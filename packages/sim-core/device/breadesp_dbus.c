/*
 * BreadESP DBus Forward Device — PRD: §4.2, §6.7 (dev-plan tasks 1.2, 2.1)
 *
 * Serializes ESP32 bus transactions (I2C, SPI, GPIO) into length-prefixed JSON
 * frames (PRD §6.7) and pushes them to the Bridge over a unix or TCP socket.
 *
 * Integration with the stock espressif/qemu tree is patch-free:
 *
 *  - I2C: for every esp32.i2c controller found in the QOM tree an internal
 *    wildcard "sniffer" I2C slave is attached to its bus. The sniffer claims
 *    an address only when no other QEMU slave answers it, so firmware gets a
 *    real ACK for Bridge-modeled peripherals (e.g. SSD1306 @0x3C) while
 *    in-QEMU devices (e.g. tmp105 @0x48) keep their traffic unmirrored.
 *
 *  - SPI: for the general-purpose controllers (SPI2/HSPI and SPI3/VSPI; SPI0/1
 *    host the flash/PSRAM and are left alone) an internal "sniffer" SSI
 *    peripheral is attached to the bus with SSI_CS_NONE polarity, so it clocks
 *    every byte a firmware transaction shifts out. Transaction framing comes
 *    from the controller's hardware CS output lines, which are wired into the
 *    sniffer's own GPIO inputs: CS assert starts a frame (the asserted line's
 *    index becomes tx.target), CS release emits one spi write transaction.
 *
 *  - GPIO: higher-priority MMIO shadow regions are overlaid on the esp32.gpio
 *    register bank at both of its mappings (DPORT 0x3ff44000 and the APB alias
 *    0x60004000, see esp32_soc_add_periph_device). Output-level register
 *    writes (OUT / OUT_W1TS / OUT_W1TC and their bank-1 twins) are decoded
 *    into per-pin transactions. Every access is then dispatched to the
 *    original region, so existing behavior (e.g. GPIO_STRAP reads that select
 *    the boot mode) is preserved.
 *
 * Wire protocol (PRD §6.7), written by the flush bottom half which batches
 * all transactions queued during one main-loop iteration into a single frame:
 *
 *   frame   := <uint32 LE payload-length> <payload>
 *   payload := {"v":1,"tx":[<BusTransaction>,...]}
 *
 *   i2c write := {"kind":"i2c","bus":0,"target":60,"dir":"write",
 *                 "data":[..],"ts":<virtual ns>}
 *   i2c read  := {"kind":"i2c","bus":0,"target":60,"dir":"read",
 *                 "length":N,"ts":<virtual ns>}
 *   spi write := {"kind":"spi","bus":2,"target":0,"dir":"write",
 *                 "data":[..],"ts":<virtual ns>}   (target = CS line index)
 *   gpio      := {"kind":"gpio","bus":0,"target":2,"dir":"write",
 *                 "data":[level],"ts":<virtual ns>}
 *
 * TODO(PRD §4.2): I2S/ADC forwarding (M3, dev-plan tasks 3.x).
 * TODO(PRD §6.3): bridge-supplied I2C/SPI read data (reverse channel).
 * TODO(PRD §1.3): esp32s3/c3 GPIO banks use a different device (M4, task 4.1).
 *
 * Copyright (c) 2026 BreadESP contributors
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 2 as
 * published by the Free Software Foundation.
 */

#include "qemu/osdep.h"
#include "qapi/error.h"
#include "qemu/error-report.h"
#include "qemu/main-loop.h"
#include "qemu/module.h"
#include "qemu/timer.h"
#include "exec/memory.h"
#include "exec/memop.h"
#include "exec/address-spaces.h"
#include "hw/qdev-properties.h"
#include "hw/sysbus.h"
#include "hw/i2c/i2c.h"
#include "hw/i2c/esp32_i2c.h"
#include "hw/ssi/ssi.h"
#include "hw/ssi/esp32_spi.h"
#include "hw/gpio/esp32_gpio.h"
#include "io/channel.h"
#include "io/channel-socket.h"
#include "qom/object.h"

#define TYPE_BREADESP_DBUS "breadesp-dbus"
OBJECT_DECLARE_SIMPLE_TYPE(BreadespDbusState, BREADESP_DBUS)

/* Wildcard I2C slave created per esp32.i2c controller bus. */
#define TYPE_BREADESP_I2C_SNIFFER "breadesp-dbus.i2c-sniffer"
typedef struct BreadespI2cSniffer BreadespI2cSniffer;
DECLARE_INSTANCE_CHECKER(BreadespI2cSniffer, BREADESP_I2C_SNIFFER,
                         TYPE_BREADESP_I2C_SNIFFER)

/* SSI sniffer created per general-purpose esp32.spi controller bus. */
#define TYPE_BREADESP_SPI_SNIFFER "breadesp-dbus.spi-sniffer"
typedef struct BreadespSpiSniffer BreadespSpiSniffer;
DECLARE_INSTANCE_CHECKER(BreadespSpiSniffer, BREADESP_SPI_SNIFFER,
                         TYPE_BREADESP_SPI_SNIFFER)

/* GPIO register offsets within the DR_REG_GPIO_BASE bank (ESP32 TRM). */
#define ESP32_GPIO_OUT_REG       0x04
#define ESP32_GPIO_OUT_W1TS_REG  0x08
#define ESP32_GPIO_OUT_W1TC_REG  0x0c
#define ESP32_GPIO_OUT1_REG      0x10
#define ESP32_GPIO_OUT1_W1TS_REG 0x14
#define ESP32_GPIO_OUT1_W1TC_REG 0x18

/*
 * esp32.gpio iomem mappings (esp32_soc_add_periph_device): the DPORT
 * register bank and its APB alias. Both are shadowed so firmware using
 * either address window is observed.
 */
static const hwaddr breadesp_gpio_bases[] = { 0x3ff44000, 0x60004000 };

#define BREADESP_DBUS_PROTO_VERSION 1
/* Cap for a single I2C write payload mirrored to the bridge, in bytes. */
#define BREADESP_I2C_MAX_PAYLOAD 4096
/* Cap for a single SPI frame payload (one CS assertion), in bytes. */
#define BREADESP_SPI_MAX_PAYLOAD 4096

struct BreadespDbusState {
    DeviceState parent_obj;

    /* Properties: unix "socket", or TCP "host"+"port" (exactly one form). */
    char *socket_path;
    char *host;
    uint16_t port;

    QIOChannelSocket *sock;
    QEMUBH *flush_bh;

    /* Comma-joined BusTransaction JSON objects awaiting the flush BH. */
    GString *pending;
    unsigned pending_count;

    /* Peer disappeared: forwarding is disabled until the next run. */
    bool broken;
    bool overflowed;

    /* GPIO shadow state (one overlay per mapping in breadesp_gpio_bases). */
    MemoryRegion gpio_mr[ARRAY_SIZE(breadesp_gpio_bases)];
    MemoryRegion *gpio_orig;
    unsigned gpio_nmr;
    uint32_t gpio_out[2]; /* output level banks (pins 0-31, 32-39) */

    /* Sniffer devices living on the esp32.i2c buses (bus-owned). */
    GPtrArray *sniffers;
    /* Sniffer devices living on the general-purpose esp32.spi buses
     * (bus-owned). */
    GPtrArray *spi_sniffers;
};

struct BreadespI2cSniffer {
    I2CSlave parent_obj;

    BreadespDbusState *owner; /* NULL after the dbus device is unrealized */
    uint8_t bus_num;          /* I2C controller instance (I2C_NUM_x) */
    uint8_t addr;             /* address of the transfer being sniffed */
    bool reading;
    GByteArray *wr;           /* bytes collected for the current write */
    unsigned read_cnt;        /* bytes requested by the current read */
};

struct BreadespSpiSniffer {
    SSIPeripheral parent_obj;

    BreadespDbusState *owner; /* NULL after the dbus device is unrealized */
    uint8_t bus_num;          /* SPI controller instance (2 = HSPI, 3 = VSPI) */
    int active_cs;            /* CS line index framing the current bytes,
                                  -1 = no CS asserted */
    GByteArray *wr;           /* bytes collected for the current CS frame */
};

/* ------------------------------------------------------------------ */
/* Frame serialization                                                 */

static void dbus_flush_bh(void *opaque)
{
    BreadespDbusState *s = opaque;
    GString *frame;
    uint32_t hdr;
    Error *local_err = NULL;

    if (s->broken || s->pending_count == 0) {
        return;
    }

    frame = g_string_sized_new(s->pending->len + 32);
    g_string_printf(frame, "{\"v\":%d,\"tx\":[", BREADESP_DBUS_PROTO_VERSION);
    g_string_append_len(frame, s->pending->str, s->pending->len);
    g_string_append(frame, "]}");

    hdr = cpu_to_le32((uint32_t)frame->len);
    g_string_prepend_len(frame, (const char *)&hdr, sizeof(hdr));

    qio_channel_write_all(QIO_CHANNEL(s->sock), frame->str, frame->len,
                          &local_err);
    if (local_err) {
        warn_report("breadesp-dbus: socket write failed, forwarding "
                    "disabled: %s", error_get_pretty(local_err));
        error_free(local_err);
        s->broken = true;
    }

    g_string_free(frame, TRUE);
    g_string_truncate(s->pending, 0);
    s->pending_count = 0;
}

/* Queue one serialized BusTransaction; the flush BH batches them. */
static void dbus_queue(BreadespDbusState *s, GString *json)
{
    if (!s->broken) {
        if (s->pending_count > 0) {
            g_string_append_c(s->pending, ',');
        }
        g_string_append_len(s->pending, json->str, json->len);
        s->pending_count++;
        qemu_bh_schedule(s->flush_bh);
    }
    g_string_free(json, TRUE);
}

static void dbus_emit_i2c_write(BreadespDbusState *s, uint8_t bus,
                                uint8_t addr, const uint8_t *data,
                                size_t len)
{
    GString *j = g_string_sized_new(64 + len * 4);
    size_t i;

    g_string_printf(j, "{\"kind\":\"i2c\",\"bus\":%u,\"target\":%u,"
                     "\"dir\":\"write\",\"ts\":%lld,\"data\":[",
                     bus, addr, (long long)qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL));
    for (i = 0; i < len; i++) {
        g_string_append_printf(j, i ? ",%u" : "%u", data[i]);
    }
    g_string_append(j, "]}");
    dbus_queue(s, j);
}

static void dbus_emit_i2c_read(BreadespDbusState *s, uint8_t bus,
                               uint8_t addr, size_t len)
{
    GString *j = g_string_sized_new(96);

    g_string_printf(j, "{\"kind\":\"i2c\",\"bus\":%u,\"target\":%u,"
                     "\"dir\":\"read\",\"length\":%zu,\"ts\":%lld}",
                     bus, addr, len,
                     (long long)qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL));
    dbus_queue(s, j);
}

static void dbus_emit_gpio(BreadespDbusState *s, uint8_t pin, uint8_t level)
{
    GString *j = g_string_sized_new(96);

    g_string_printf(j, "{\"kind\":\"gpio\",\"bus\":0,\"target\":%u,"
                     "\"dir\":\"write\",\"ts\":%lld,\"data\":[%u]}",
                     pin, (long long)qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL),
                     level);
    dbus_queue(s, j);
}

static void dbus_emit_spi_write(BreadespDbusState *s, uint8_t bus,
                                uint8_t cs, const uint8_t *data,
                                size_t len)
{
    GString *j = g_string_sized_new(64 + len * 4);
    size_t i;

    g_string_printf(j, "{\"kind\":\"spi\",\"bus\":%u,\"target\":%u,"
                     "\"dir\":\"write\",\"ts\":%lld,\"data\":[",
                     bus, cs, (long long)qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL));
    for (i = 0; i < len; i++) {
        g_string_append_printf(j, i ? ",%u" : "%u", data[i]);
    }
    g_string_append(j, "]}");
    dbus_queue(s, j);
}

/* ------------------------------------------------------------------ */
/* I2C sniffer slave                                                   */

static void sniffer_flush_write(BreadespI2cSniffer *s)
{
    if (s->wr->len > 0) {
        dbus_emit_i2c_write(s->owner, s->bus_num, s->addr,
                            s->wr->data, s->wr->len);
        g_byte_array_set_size(s->wr, 0);
    }
}

/*
 * Claim the address only when no other slave on this bus owns it: in-QEMU
 * devices keep exclusive traffic, everything else belongs to the Bridge
 * (netlist peripherals), and claiming it provides the firmware its ACK.
 */
static bool sniffer_match_and_add(I2CSlave *candidate, uint8_t address,
                                  bool broadcast, I2CNodeList *current_devs)
{
    BreadespI2cSniffer *s = BREADESP_I2C_SNIFFER(candidate);
    BusState *bus = qdev_get_parent_bus(DEVICE(candidate));
    BusChild *kid;

    if (broadcast) {
        return false; /* let in-QEMU devices handle general calls */
    }

    QTAILQ_FOREACH(kid, &bus->children, sibling) {
        if (kid->child == DEVICE(candidate)) {
            continue;
        }
        if (I2C_SLAVE(kid->child)->address == address) {
            return false;
        }
    }

    s->addr = address;
    I2CNode *node = g_new(I2CNode, 1);
    node->elt = candidate;
    QLIST_INSERT_HEAD(current_devs, node, next);
    return true;
}

static int sniffer_event(I2CSlave *i2c, enum i2c_event event)
{
    BreadespI2cSniffer *s = BREADESP_I2C_SNIFFER(i2c);

    if (!s->owner) {
        return 0;
    }
    switch (event) {
    case I2C_START_SEND:
        sniffer_flush_write(s); /* repeated start closes the write phase */
        s->reading = false;
        break;
    case I2C_START_RECV:
        sniffer_flush_write(s);
        s->reading = true;
        s->read_cnt = 0;
        break;
    case I2C_FINISH:
        if (s->reading) {
            dbus_emit_i2c_read(s->owner, s->bus_num, s->addr, s->read_cnt);
            s->reading = false;
        } else {
            sniffer_flush_write(s);
        }
        break;
    default:
        break;
    }
    return 0; /* ACK */
}

static int sniffer_send(I2CSlave *i2c, uint8_t data)
{
    BreadespI2cSniffer *s = BREADESP_I2C_SNIFFER(i2c);

    if (s->wr->len < BREADESP_I2C_MAX_PAYLOAD) {
        g_byte_array_append(s->wr, &data, 1);
    } else if (s->owner && !s->owner->overflowed) {
        s->owner->overflowed = true;
        warn_report("breadesp-dbus: i2c payload exceeds %d bytes, "
                    "extra bytes dropped", BREADESP_I2C_MAX_PAYLOAD);
    }
    return 0; /* ACK */
}

static uint8_t sniffer_recv(I2CSlave *i2c)
{
    BreadespI2cSniffer *s = BREADESP_I2C_SNIFFER(i2c);

    s->read_cnt++;
    /* TODO(PRD §6.3): return bridge-supplied data once the reverse
     * channel exists (P1.3+). */
    return 0xff;
}

static void sniffer_reset_hold(Object *obj, ResetType type)
{
    BreadespI2cSniffer *s = BREADESP_I2C_SNIFFER(obj);

    g_byte_array_set_size(s->wr, 0);
    s->reading = false;
    s->read_cnt = 0;
}

static void sniffer_init(Object *obj)
{
    BreadespI2cSniffer *s = BREADESP_I2C_SNIFFER(obj);

    s->wr = g_byte_array_new();
}

static void sniffer_finalize(Object *obj)
{
    BreadespI2cSniffer *s = BREADESP_I2C_SNIFFER(obj);

    g_byte_array_free(s->wr, TRUE);
}

static void sniffer_class_init(ObjectClass *klass, void *data)
{
    I2CSlaveClass *sc = I2C_SLAVE_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);

    sc->event = sniffer_event;
    sc->send = sniffer_send;
    sc->recv = sniffer_recv;
    sc->match_and_add = sniffer_match_and_add;
    rc->phases.hold = sniffer_reset_hold;
}

static const TypeInfo sniffer_type_info = {
    .name = TYPE_BREADESP_I2C_SNIFFER,
    .parent = TYPE_I2C_SLAVE,
    .instance_size = sizeof(BreadespI2cSniffer),
    .instance_init = sniffer_init,
    .instance_finalize = sniffer_finalize,
    .class_init = sniffer_class_init,
};

/* Parse the controller index from the QOM path (".../i2c0" -> 0). */
static int bus_num_from_path(Object *obj)
{
    const char *path = object_get_canonical_path(obj);
    const char *p = path + strlen(path);

    while (p > path && g_ascii_isdigit((guchar)p[-1])) {
        p--;
    }
    return *p ? atoi(p) : -1;
}

static void dbus_attach_i2c_sniffer(Object *obj, BreadespDbusState *s,
                                    int fallback_bus)
{
    DeviceState *i2c_dev = DEVICE(obj);
    BusState *bus = qdev_get_child_bus(i2c_dev, "i2c");
    DeviceState *sniff_dev;
    BreadespI2cSniffer *sniff;
    int bus_num = bus_num_from_path(obj);

    if (!bus) {
        return;
    }
    if (bus_num < 0) {
        bus_num = fallback_bus;
    }

    /* Hand the device to the bus (bus-owned lifetime), like tmp105. */
    sniff_dev = qdev_new(TYPE_BREADESP_I2C_SNIFFER);
    sniff = BREADESP_I2C_SNIFFER(sniff_dev);
    sniff->owner = s;
    sniff->bus_num = (uint8_t)bus_num;
    qdev_realize_and_unref(sniff_dev, bus, &error_fatal);
    g_ptr_array_add(s->sniffers, sniff_dev);
}

/* ------------------------------------------------------------------ */
/* SPI sniffer peripheral                                              */

/*
 * CS release closes the frame: the bytes clocked since assertion become one
 * spi write transaction, attributed to the CS line that framed them.
 */
static void spi_sniffer_flush(BreadespSpiSniffer *s)
{
    if (s->wr->len > 0) {
        if (s->owner) {
            dbus_emit_spi_write(s->owner, s->bus_num, (uint8_t)s->active_cs,
                                s->wr->data, s->wr->len);
        }
        g_byte_array_set_size(s->wr, 0);
    }
    s->active_cs = -1;
}

/* SSI_CS_NONE polarity: called for every byte the controller shifts out. */
static uint32_t spi_sniffer_transfer(SSIPeripheral *dev, uint32_t val)
{
    BreadespSpiSniffer *s = BREADESP_SPI_SNIFFER(dev);

    if (s->active_cs >= 0) {
        if (s->wr->len < BREADESP_SPI_MAX_PAYLOAD) {
            g_byte_array_append(s->wr, (const guint8 *)&val, 1);
        } else if (s->owner && !s->owner->overflowed) {
            s->owner->overflowed = true;
            warn_report("breadesp-dbus: spi payload exceeds %d bytes, "
                        "extra bytes dropped", BREADESP_SPI_MAX_PAYLOAD);
        }
    }
    /* MISO stays undriven: no reverse channel yet (PRD §6.3 TODO). */
    return 0;
}

/* The controller's hardware CS output lines, wired as GPIO inputs. */
static void spi_sniffer_cs(void *opaque, int n, int level)
{
    BreadespSpiSniffer *s = opaque;

    if (level == 0) {
        /* Assertion opens a frame. All unmasked lines assert together, so the
         * first one seen claims the transaction (SPI_PIN masks the rest). */
        if (s->active_cs < 0) {
            s->active_cs = n;
            g_byte_array_set_size(s->wr, 0);
        }
    } else if (s->active_cs == n) {
        spi_sniffer_flush(s);
    }
}

static void spi_sniffer_reset_hold(Object *obj, ResetType type)
{
    BreadespSpiSniffer *s = BREADESP_SPI_SNIFFER(obj);

    g_byte_array_set_size(s->wr, 0);
    s->active_cs = -1;
}

/* ssi_peripheral_realize() calls this unconditionally: no backing hardware. */
static void spi_sniffer_realize(SSIPeripheral *dev, Error **errp)
{
}

static void spi_sniffer_init(Object *obj)
{
    BreadespSpiSniffer *s = BREADESP_SPI_SNIFFER(obj);

    s->active_cs = -1;
    s->wr = g_byte_array_new();
}

static void spi_sniffer_finalize(Object *obj)
{
    BreadespSpiSniffer *s = BREADESP_SPI_SNIFFER(obj);

    g_byte_array_free(s->wr, TRUE);
}

static void spi_sniffer_class_init(ObjectClass *klass, void *data)
{
    SSIPeripheralClass *ssc = SSI_PERIPHERAL_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);

    ssc->transfer = spi_sniffer_transfer;
    ssc->realize = spi_sniffer_realize;
    /* See every byte regardless of the SSI cs flag: framing is done by the
     * GPIO-wired CS lines, not by the bus's own CS mechanism. */
    ssc->cs_polarity = SSI_CS_NONE;
    rc->phases.hold = spi_sniffer_reset_hold;
}

static const TypeInfo spi_sniffer_type_info = {
    .name = TYPE_BREADESP_SPI_SNIFFER,
    .parent = TYPE_SSI_PERIPHERAL,
    .instance_size = sizeof(BreadespSpiSniffer),
    .instance_init = spi_sniffer_init,
    .instance_finalize = spi_sniffer_finalize,
    .class_init = spi_sniffer_class_init,
};

static void dbus_attach_spi_sniffer(Object *obj, BreadespDbusState *s,
                                    int bus_num)
{
    DeviceState *spi_dev = DEVICE(obj);
    SSIBus *bus = (SSIBus *)qdev_get_child_bus(spi_dev, "spi");
    DeviceState *sniff_dev;
    BreadespSpiSniffer *sniff;
    int i;

    if (!bus) {
        return;
    }

    sniff_dev = qdev_new(TYPE_BREADESP_SPI_SNIFFER);
    sniff = BREADESP_SPI_SNIFFER(sniff_dev);
    sniff->owner = s;
    sniff->bus_num = (uint8_t)bus_num;
    /* One input per hardware CS line of this controller (esp32_spi drives
     * all unmasked lines around each transaction, SPI_PIN masks the rest). */
    qdev_init_gpio_in(sniff_dev, spi_sniffer_cs, ESP32_SPI_CS_COUNT);
    ssi_realize_and_unref(sniff_dev, bus, &error_fatal);
    for (i = 0; i < ESP32_SPI_CS_COUNT; i++) {
        qdev_connect_gpio_out_named(spi_dev, SSI_GPIO_CS, i,
                                    qdev_get_gpio_in(sniff_dev, i));
    }
    g_ptr_array_add(s->spi_sniffers, sniff_dev);
}

/* ------------------------------------------------------------------ */
/* GPIO MMIO shadow                                                    */

static uint64_t dbus_gpio_read(void *opaque, hwaddr addr, unsigned size)
{
    BreadespDbusState *s = opaque;
    uint64_t val = 0;

    if (s->gpio_orig) {
        memory_region_dispatch_read(s->gpio_orig, addr, &val,
                                    size_memop(size) | MO_LE,
                                    MEMTXATTRS_UNSPECIFIED);
    }
    return val;
}

static void dbus_gpio_forward_write(void *opaque, hwaddr addr,
                                    uint64_t value)
{
    BreadespDbusState *s = opaque;
    uint32_t old, nw;
    unsigned bank, pin, diff;

    switch (addr) {
    case ESP32_GPIO_OUT_REG:
        old = s->gpio_out[0];
        nw = (uint32_t)value;
        bank = 0;
        break;
    case ESP32_GPIO_OUT_W1TS_REG:
        old = s->gpio_out[0];
        nw = old | (uint32_t)value;
        bank = 0;
        break;
    case ESP32_GPIO_OUT_W1TC_REG:
        old = s->gpio_out[0];
        nw = old & ~(uint32_t)value;
        bank = 0;
        break;
    case ESP32_GPIO_OUT1_REG:
        old = s->gpio_out[1];
        nw = (uint32_t)value;
        bank = 1;
        break;
    case ESP32_GPIO_OUT1_W1TS_REG:
        old = s->gpio_out[1];
        nw = old | (uint32_t)value;
        bank = 1;
        break;
    case ESP32_GPIO_OUT1_W1TC_REG:
        old = s->gpio_out[1];
        nw = old & ~(uint32_t)value;
        bank = 1;
        break;
    default:
        return; /* not an output register: observe only */
    }

    s->gpio_out[bank] = nw;
    diff = old ^ nw;
    if (diff) {
        for (pin = 0; pin < 32; pin++) {
            if (diff & (1u << pin)) {
                dbus_emit_gpio(s, (uint8_t)(bank * 32 + pin),
                               (nw >> pin) & 1);
            }
        }
    }
}

static void dbus_gpio_write(void *opaque, hwaddr addr, uint64_t value,
                            unsigned size)
{
    BreadespDbusState *s = opaque;

    dbus_gpio_forward_write(opaque, addr, value);
    if (s->gpio_orig) {
        /* Observe-only shadow: keep the original register view in sync. */
        memory_region_dispatch_write(s->gpio_orig, addr, value,
                                     size_memop(size) | MO_LE,
                                     MEMTXATTRS_UNSPECIFIED);
    }
}

static const MemoryRegionOps dbus_gpio_ops = {
    .read = dbus_gpio_read,
    .write = dbus_gpio_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {
        .min_access_size = 1,
        .max_access_size = 4,
    },
};

static void dbus_setup_gpio_shadow(BreadespDbusState *s, Object *gpio)
{
    MemoryRegion *orig = sysbus_mmio_get_region(SYS_BUS_DEVICE(gpio), 0);
    MemoryRegionSection sec;
    size_t i;

    /*
     * esp32-only guard: esp32s3 (and esp32c3 in the riscv build) model their
     * GPIO banks on TYPE_ESP32_GPIO subclasses, so the dynamic cast in the
     * scanner matches them too — but they map the bank once at 0x60004000,
     * with nothing at the esp32 DPORT window. Probing for the esp32 dual
     * mapping (DPORT 0x3ff44000 hosting this very region) keeps the shadow
     * esp32-specific without type-name string hacks.
     */
    sec = memory_region_find(get_system_memory(), breadesp_gpio_bases[0], 4);
    if (sec.mr != orig) {
        return;
    }

    s->gpio_orig = orig;
    for (i = 0; i < ARRAY_SIZE(breadesp_gpio_bases); i++) {
        memory_region_init_io(&s->gpio_mr[i], OBJECT(s), &dbus_gpio_ops,
                              s, "breadesp.gpio-shadow",
                              memory_region_size(orig));
        memory_region_add_subregion_overlap(get_system_memory(),
                                            breadesp_gpio_bases[i],
                                            &s->gpio_mr[i], 1);
        s->gpio_nmr++;
    }
}

/* ------------------------------------------------------------------ */
/* QOM tree scan                                                       */

static int dbus_scan_visit(Object *obj, void *opaque)
{
    BreadespDbusState *s = opaque;

    if (object_dynamic_cast(obj, TYPE_ESP32_I2C)) {
        dbus_attach_i2c_sniffer(obj, s, s->sniffers->len);
    } else if (object_dynamic_cast(obj, TYPE_ESP32_SPI)) {
        int bus_num = bus_num_from_path(obj);
        /* SPI0/1 host the flash/PSRAM: their cache traffic is not peripheral
         * business. SPI2 (HSPI) and SPI3 (VSPI) are the user buses. */
        if (bus_num >= 2) {
            dbus_attach_spi_sniffer(obj, s, bus_num);
        }
    } else if (object_dynamic_cast(obj, TYPE_ESP32_GPIO)) {
        dbus_setup_gpio_shadow(s, obj);
    }
    object_child_foreach(obj, dbus_scan_visit, opaque);
    return 0;
}

/* ------------------------------------------------------------------ */
/* Device lifecycle                                                    */

static void breadesp_dbus_realize(DeviceState *dev, Error **errp)
{
    BreadespDbusState *s = BREADESP_DBUS(dev);
    SocketAddress *saddr;
    Error *local_err = NULL;

    if (!!s->socket_path == !!s->port) {
        error_setg(errp, "breadesp-dbus: exactly one transport required: "
                   "'socket' (unix path) or 'host'+'port' (TCP)");
        return;
    }

    s->pending = g_string_new(NULL);
    s->sniffers = g_ptr_array_new();
    s->spi_sniffers = g_ptr_array_new();
    s->flush_bh = qemu_bh_new(dbus_flush_bh, s);

    if (s->socket_path) {
        saddr = g_new0(SocketAddress, 1);
        saddr->type = SOCKET_ADDRESS_TYPE_UNIX;
        saddr->u.q_unix.path = g_strdup(s->socket_path);
    } else {
        saddr = g_new0(SocketAddress, 1);
        saddr->type = SOCKET_ADDRESS_TYPE_INET;
        saddr->u.inet.host = g_strdup(s->host ?: "127.0.0.1");
        saddr->u.inet.port = g_strdup_printf("%u", (unsigned)s->port);
    }

    /* Connect before wiring the hooks so an absent Bridge fails fast. */
    s->sock = qio_channel_socket_new();
    if (qio_channel_socket_connect_sync(s->sock, saddr, &local_err) < 0) {
        error_propagate(errp, local_err);
        qapi_free_SocketAddress(saddr);
        return;
    }
    qapi_free_SocketAddress(saddr);
    qio_channel_set_blocking(QIO_CHANNEL(s->sock), true, NULL);

    dbus_scan_visit(object_get_root(), s);
    if (s->sniffers->len == 0) {
        warn_report("breadesp-dbus: no esp32.i2c controllers found; "
                    "I2C forwarding disabled");
    }
    if (s->spi_sniffers->len == 0) {
        warn_report("breadesp-dbus: no esp32.hspi/vspi controllers found; "
                    "SPI forwarding disabled");
    }
}

static void breadesp_dbus_unrealize(DeviceState *dev)
{
    BreadespDbusState *s = BREADESP_DBUS(dev);

    while (s->gpio_nmr > 0) {
        s->gpio_nmr--;
        memory_region_del_subregion(get_system_memory(),
                                    &s->gpio_mr[s->gpio_nmr]);
    }
    s->gpio_orig = NULL;
    if (s->sniffers) {
        for (guint i = 0; i < s->sniffers->len; i++) {
            BREADESP_I2C_SNIFFER(g_ptr_array_index(s->sniffers, i))->owner = NULL;
        }
        g_ptr_array_free(s->sniffers, TRUE);
        s->sniffers = NULL;
    }
    if (s->spi_sniffers) {
        for (guint i = 0; i < s->spi_sniffers->len; i++) {
            BREADESP_SPI_SNIFFER(g_ptr_array_index(s->spi_sniffers, i))->owner = NULL;
        }
        g_ptr_array_free(s->spi_sniffers, TRUE);
        s->spi_sniffers = NULL;
    }
    if (s->flush_bh) {
        qemu_bh_delete(s->flush_bh);
        s->flush_bh = NULL;
    }
    if (s->sock) {
        qio_channel_close(QIO_CHANNEL(s->sock), NULL);
        object_unref(OBJECT(s->sock));
        s->sock = NULL;
    }
    if (s->pending) {
        g_string_free(s->pending, TRUE);
        s->pending = NULL;
    }
}

static void breadesp_dbus_reset_hold(Object *obj, ResetType type)
{
    BreadespDbusState *s = BREADESP_DBUS(obj);

    memset(s->gpio_out, 0, sizeof(s->gpio_out));
    g_string_truncate(s->pending, 0);
    s->pending_count = 0;
}

static Property breadesp_dbus_props[] = {
    DEFINE_PROP_STRING("socket", BreadespDbusState, socket_path),
    DEFINE_PROP_STRING("host", BreadespDbusState, host),
    DEFINE_PROP_UINT16("port", BreadespDbusState, port, 0),
    DEFINE_PROP_END_OF_LIST(),
};

static void breadesp_dbus_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);

    dc->realize = breadesp_dbus_realize;
    dc->unrealize = breadesp_dbus_unrealize;
    dc->desc = "BreadESP DBus forward device (PRD 4.2)";
    device_class_set_props(dc, breadesp_dbus_props);
    rc->phases.hold = breadesp_dbus_reset_hold;
}

static const TypeInfo breadesp_dbus_type_info = {
    .name = TYPE_BREADESP_DBUS,
    .parent = TYPE_DEVICE,
    .instance_size = sizeof(BreadespDbusState),
    .class_init = breadesp_dbus_class_init,
};

static void breadesp_dbus_register_types(void)
{
    type_register_static(&breadesp_dbus_type_info);
    type_register_static(&sniffer_type_info);
    type_register_static(&spi_sniffer_type_info);
}

type_init(breadesp_dbus_register_types)
