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
 *  - I2S (dev-plan task P2.4): the stock tree models esp32.i2s0/1 as
 *    "unimplemented-device" stubs, so firmware PCM is invisible without a
 *    shadow. Higher-priority MMIO overlays on the two legacy register banks
 *    (0x3ff4f000 / 0x3ff6d000) observe CONF / CLKM_CONF / SAMPLE_RATE_CONF /
 *    OUT_LINK. When TX is started with a DMA out-link, a virtual-clock timer
 *    consumes the linked-list descriptors (lldesc_t) from guest memory at the
 *    decoded PCM byte rate — descriptor rings loop naturally — and each 10ms
 *    tick emits one i2s transaction: 8-byte header [rate u32 LE][bits u8]
 *    [channels u8][flags u8][reserved u8] followed by the raw interleaved PCM
 *    bytes exactly as the DMA engine would shift them out. APLL and the
 *    non-DMA FIFO_WR path are documented gaps.
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
 *   pwm       := {"kind":"pwm","bus":0,"target":4,"dir":"write",
 *                 "data":[f0,f1,f2,f3,d0,d1],"ts":<virtual ns>}
 *                 (target = GPIO number; f = freq centihertz u32 LE,
 *                  d = duty permille u16 LE; 0Hz/0% = silent)
 *   i2s       := {"kind":"i2s","bus":0,"dir":"write","ts":<virtual ns>,
 *                 "data":[r0..r3,bits,channels,flags,0,<pcm>...]}
 *                 (bus = I2S controller 0/1; r = sample rate u32 LE;
 *                  pcm = raw interleaved little-endian samples)
 *
 * PWM forwarding (dev-plan task P2.3): QEMU's esp32.ledc model stores the
 * LEDC registers but never drives pins (its "led" widgets are graphical
 * only), and the GPIO matrix is unmodeled, so a firmware buzzer tone never
 * reaches the GPIO shadow. Instead an MMIO shadow is overlaid on the
 * esp32.ledc bank (both mappings) and the GPIO shadow also observes the
 * FUNCn_OUT_SEL matrix config: timer conf + channel conf0/duty are decoded
 * into (frequency, duty) per channel, the matrix maps LEDC output signals
 * (LEDC_HS_SIG_OUT0..7 = 71..78, LEDC_LS_SIG_OUT0..7 = 79..86, ESP32 TRM
 * "Peripheral Output Signals") onto pins, and every change of a pin's
 * effective tone emits one pwm transaction. HS timers are assumed to run on
 * APB_CLK 80MHz (TICK_SEL=1; the Arduino/ESP-IDF default for ledc).
 *
 * TODO(PRD §4.2): ADC forwarding (M3, dev-plan tasks 3.x).
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
#include "hw/misc/esp32_ledc.h"
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
 * GPIO matrix output-signal select: FUNCn_OUT_SEL_CFG_REG = 0x530 + 4*n
 * (n = GPIO 0..39). The low 9 bits select the peripheral output signal
 * driving the pin (0x100 = plain GPIO_OUT).
 */
#define ESP32_GPIO_FUNC0_OUT_SEL_REG 0x530
#define ESP32_GPIO_PIN_COUNT 40
#define ESP32_GPIO_OUT_SEL_MASK 0x1ff

/* LEDC peripheral output signal indices (ESP32 TRM, output signal table). */
#define LEDC_HS_SIG_OUT0_IDX 71
#define LEDC_LS_SIG_OUT0_IDX 79

/* LEDC register offsets within DR_REG_LEDC_BASE (hw/misc/esp32_ledc.h). */
#define LEDC_CH_CONF0_REG(i)  (0x000 + 0x14 * (i))
#define LEDC_CH_DUTY_REG(i)   (0x008 + 0x14 * (i))
#define LEDC_TIMER_CONF_REG(i) (0x140 + 0x08 * (i))
#define LEDC_TIMER_COUNT 8
#define LEDC_CHANNEL_COUNT 16

/* Timer conf bit fields (ESP32 TRM, LEDC_HSTIMERx_CONF_REG). */
#define LEDC_CONF_DUTY_RES_MASK 0xf
#define LEDC_CONF_CLK_DIV_SHIFT 5
#define LEDC_CONF_CLK_DIV_MASK 0x3ffff
/* Channel conf0 bit fields (LEDC_HSCHx_CONF0_REG). */
#define LEDC_CH_CONF0_TIMER_SEL_MASK 0x3
#define LEDC_CH_CONF0_SIG_OUT_EN (1u << 2)

/* HS/LS timers source APB_CLK 80MHz in the Arduino/ESP-IDF ledc path. */
#define LEDC_APB_CLK_HZ 80000000.0

/*
 * esp32.gpio iomem mappings (esp32_soc_add_periph_device): the DPORT
 * register bank and its APB alias. Both are shadowed so firmware using
 * either address window is observed.
 */
static const hwaddr breadesp_gpio_bases[] = { 0x3ff44000, 0x60004000 };

/* esp32.ledc iomem mappings (same dual-mapping scheme as esp32.gpio). */
static const hwaddr breadesp_ledc_bases[] = { 0x3ff59000, 0x60019000 };

/*
 * esp32 legacy I2S register banks (DR_REG_I2S_BASE / DR_REG_I2S1_BASE,
 * single DPORT mapping each; the stock tree places unimplemented-device
 * stubs there — esp32.c:esp32_soc_add_unimp_device "esp32.i2s0/1").
 */
static const hwaddr breadesp_i2s_bases[] = { 0x3ff4f000, 0x3ff6d000 };
#define BREADESP_I2S_BANK_SIZE 0x1000

/* Legacy I2S register offsets within the bank (ESP32 TRM, esp-idf i2s_reg.h). */
#define I2S_CONF_REG          0x08
#define I2S_OUT_LINK_REG      0x30
#define I2S_CLKM_CONF_REG     0xac
#define I2S_SAMPLE_RATE_CONF_REG 0xb0

/* I2S_CONF_REG bit fields. */
#define I2S_CONF_TX_RESET       (1u << 1)
#define I2S_CONF_TX_START       (1u << 5)
#define I2S_CONF_TX_MSB_SHIFT   (1u << 11)
#define I2S_CONF_TX_MONO        (1u << 13)

/* I2S_CLKM_CONF_REG bit fields (APLL unsupported: source is PLL 160MHz). */
#define I2S_CLKM_DIV_NUM_MASK   0xff
#define I2S_CLKM_DIV_B_SHIFT    8
#define I2S_CLKM_DIV_B_MASK     0x3f
#define I2S_CLKM_DIV_A_SHIFT    14
#define I2S_CLKM_DIV_A_MASK     0x3f
#define I2S_CLKM_PLL_HZ         160000000.0

/* I2S_SAMPLE_RATE_CONF_REG bit fields. */
#define I2S_TX_BCK_DIV_SHIFT    6
#define I2S_TX_BCK_DIV_MASK     0x3f
#define I2S_TX_BITS_MOD_SHIFT   18
#define I2S_TX_BITS_MOD_MASK    0x3f

/* I2S_OUT_LINK_REG bit fields. */
#define I2S_OUTLINK_ADDR_MASK   0xfffff
/*
 * OUTLINK_ADDR is the 20-bit offset of the first descriptor within the DRAM
 * window: the hardware reconstructs the physical address as 0x3ff00000|field
 * (esp-idf writes the pointer masked to 0xfffff; lldesc_t buf/next fields
 * carry full 32-bit pointers, only the link register is windowed).
 */
#define I2S_OUTLINK_ADDR_BASE   0x3ff00000
#define I2S_OUTLINK_STOP        (1u << 28)
#define I2S_OUTLINK_START       (1u << 29)
#define I2S_OUTLINK_RESTART     (1u << 30)

/*
 * DMA linked-list descriptor (esp-idf lldesc_t), 12 bytes:
 *   dw0: size[11:0], length[23:12], offset[28:24], sosf[29], eof[30], owner[31]
 *   +4: buf address, +8: next descriptor address (0 = end of chain).
 */
#define I2S_LLDESC_LEN_SHIFT    12
#define I2S_LLDESC_LEN_MASK     0xfff

/* PCM consumption tick (virtual clock) and per-tick byte cap. */
#define I2S_TICK_MS             10
#define I2S_TICK_MAX_BYTES      16384
/* Header prepended to every i2s transaction payload (see frame docs above). */
#define I2S_TX_HEADER_BYTES     8

/* Per-controller I2S DMA sniffing state (see the P2.4 section below). */
typedef struct BreadespI2sChan BreadespI2sChan;
struct BreadespI2sChan {
    BreadespDbusState *owner;
    uint8_t bus;               /* I2S controller index (0/1) */
    uint32_t conf;
    uint32_t clkm_conf;
    uint32_t srate_conf;
    uint32_t out_link;         /* last OUT_LINK write (addr + control bits) */
    bool streaming;            /* TX started with a valid DMA out-link */
    uint32_t desc;             /* address of the next lldesc_t to load */
    uint32_t buf;              /* current descriptor's data cursor */
    uint32_t remaining;        /* bytes left in the current descriptor */
    bool dma_warned;           /* one-shot warn on unreadable guest memory */
    GByteArray *chunk;         /* PCM collected for the current tick */
    QEMUTimer *tick;
};

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

    /* GPIO matrix: peripheral output signal selected per pin (0 = unset). */
    uint16_t gpio_out_sel[ESP32_GPIO_PIN_COUNT];

    /* LEDC shadow state (one overlay per mapping in breadesp_ledc_bases). */
    MemoryRegion ledc_mr[ARRAY_SIZE(breadesp_ledc_bases)];
    MemoryRegion *ledc_orig;
    unsigned ledc_nmr;
    uint32_t ledc_timer_conf[LEDC_TIMER_COUNT];
    uint32_t ledc_ch_conf0[LEDC_CHANNEL_COUNT];
    uint32_t ledc_ch_duty[LEDC_CHANNEL_COUNT];

    /* Last tone emitted per pin (dedupe): 0 centihertz/0 permille = silent. */
    uint32_t pwm_last_centi[ESP32_GPIO_PIN_COUNT];
    uint16_t pwm_last_duty[ESP32_GPIO_PIN_COUNT];

    /* I2S shadows + DMA sniffing state, one per legacy controller. */
    MemoryRegion i2s_mr[ARRAY_SIZE(breadesp_i2s_bases)];
    MemoryRegion *i2s_orig[ARRAY_SIZE(breadesp_i2s_bases)];
    BreadespI2sChan i2s[ARRAY_SIZE(breadesp_i2s_bases)];

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

static void dbus_emit_pwm(BreadespDbusState *s, uint8_t pin,
                          uint32_t centi_hz, uint16_t duty_permille)
{
    GString *j = g_string_sized_new(112);

    g_string_printf(j, "{\"kind\":\"pwm\",\"bus\":0,\"target\":%u,"
                     "\"dir\":\"write\",\"ts\":%lld,"
                     "\"data\":[%u,%u,%u,%u,%u,%u]}",
                     pin, (long long)qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL),
                     centi_hz & 0xff, (centi_hz >> 8) & 0xff,
                     (centi_hz >> 16) & 0xff, (centi_hz >> 24) & 0xff,
                     duty_permille & 0xff, (duty_permille >> 8) & 0xff);
    dbus_queue(s, j);
}

static void dbus_emit_i2s(BreadespDbusState *s, uint8_t bus, uint32_t rate,
                          uint8_t bits, uint8_t channels, uint8_t flags,
                          const uint8_t *data, size_t len)
{
    GString *j = g_string_sized_new(96 + len * 4);
    size_t i;

    g_string_printf(j, "{\"kind\":\"i2s\",\"bus\":%u,\"dir\":\"write\","
                     "\"ts\":%lld,\"data\":[%u,%u,%u,%u,%u,%u,%u,0",
                     bus, (long long)qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL),
                     rate & 0xff, (rate >> 8) & 0xff, (rate >> 16) & 0xff,
                     (rate >> 24) & 0xff, bits, channels, flags);
    for (i = 0; i < len; i++) {
        g_string_append_printf(j, ",%u", data[i]);
    }
    g_string_append(j, "]}");
    dbus_queue(s, j);
}

/* ------------------------------------------------------------------ */
/* LEDC -> GPIO-matrix tone decode                                     */

/*
 * Effective (freq, duty) of one LEDC channel. Mirrors the esp32.ledc
 * model's register layout; the frequency formula is the ESP32 TRM's
 * f = APB_CLK / (clk_div/256) / 2^duty_res. Returns false when the channel
 * produces no square wave (disabled, zero divisor/resolution, zero duty).
 */
static bool ledc_channel_tone(BreadespDbusState *s, int ch,
                              uint32_t *centi_hz, uint16_t *duty_permille)
{
    uint32_t conf0 = s->ledc_ch_conf0[ch];
    int timer_idx = (conf0 & LEDC_CH_CONF0_TIMER_SEL_MASK) + (ch < 8 ? 0 : 4);
    uint32_t tconf = s->ledc_timer_conf[timer_idx];
    uint32_t duty_res = tconf & LEDC_CONF_DUTY_RES_MASK;
    uint32_t clk_div = (tconf >> LEDC_CONF_CLK_DIV_SHIFT) & LEDC_CONF_CLK_DIV_MASK;
    uint32_t duty_raw = (s->ledc_ch_duty[ch] >> 4) & 0xfffff;

    if (!(conf0 & LEDC_CH_CONF0_SIG_OUT_EN) || duty_res == 0 || clk_div == 0
        || duty_raw == 0) {
        return false;
    }

    double freq = LEDC_APB_CLK_HZ * 256.0
                  / ((double)clk_div * (double)(1u << duty_res));
    uint32_t full_scale = (1u << duty_res) - 1;
    uint32_t permille = (uint32_t)(1000.0 * duty_raw / full_scale + 0.5);

    *centi_hz = (uint32_t)(freq * 100.0 + 0.5);
    *duty_permille = permille > 1000 ? 1000 : (uint16_t)permille;
    return *centi_hz > 0;
}

/*
 * Recompute every pin's tone and emit a pwm transaction per changed pin.
 * Cheap enough to run on any LEDC/matrix write (16 channels x 40 pins of
 * register reads, and the emit dedupe keeps quiet configurations silent).
 */
static void ledc_pwm_update(BreadespDbusState *s)
{
    unsigned pin;

    for (pin = 0; pin < ESP32_GPIO_PIN_COUNT; pin++) {
        uint16_t sig = s->gpio_out_sel[pin];
        uint32_t centi = 0;
        uint16_t duty = 0;

        if (sig >= LEDC_HS_SIG_OUT0_IDX && sig < LEDC_HS_SIG_OUT0_IDX + 8) {
            ledc_channel_tone(s, sig - LEDC_HS_SIG_OUT0_IDX, &centi, &duty);
        } else if (sig >= LEDC_LS_SIG_OUT0_IDX && sig < LEDC_LS_SIG_OUT0_IDX + 8) {
            ledc_channel_tone(s, 8 + sig - LEDC_LS_SIG_OUT0_IDX, &centi, &duty);
        }

        if (centi != s->pwm_last_centi[pin] || duty != s->pwm_last_duty[pin]) {
            s->pwm_last_centi[pin] = centi;
            s->pwm_last_duty[pin] = duty;
            dbus_emit_pwm(s, (uint8_t)pin, centi, duty);
        }
    }
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
    case ESP32_GPIO_FUNC0_OUT_SEL_REG ... ESP32_GPIO_FUNC0_OUT_SEL_REG + 4 * (ESP32_GPIO_PIN_COUNT - 1):
        /* GPIO matrix output-signal select: feeds the LEDC tone decode. */
        if (((addr - ESP32_GPIO_FUNC0_OUT_SEL_REG) & 3) == 0) {
            unsigned n = (addr - ESP32_GPIO_FUNC0_OUT_SEL_REG) / 4;
            s->gpio_out_sel[n] = (uint16_t)(value & ESP32_GPIO_OUT_SEL_MASK);
            ledc_pwm_update(s);
        }
        return;
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
/* LEDC MMIO shadow                                                    */

static uint64_t dbus_ledc_read(void *opaque, hwaddr addr, unsigned size)
{
    BreadespDbusState *s = opaque;
    uint64_t val = 0;

    if (s->ledc_orig) {
        memory_region_dispatch_read(s->ledc_orig, addr, &val,
                                    size_memop(size) | MO_LE,
                                    MEMTXATTRS_UNSPECIFIED);
    }
    return val;
}

static void dbus_ledc_write(void *opaque, hwaddr addr, uint64_t value,
                            unsigned size)
{
    BreadespDbusState *s = opaque;
    uint32_t v = (uint32_t)value;
    unsigned i;

    /* Record the tone-relevant registers, then re-evaluate all pins. */
    for (i = 0; i < LEDC_TIMER_COUNT; i++) {
        if (addr == LEDC_TIMER_CONF_REG(i)) {
            s->ledc_timer_conf[i] = v;
            ledc_pwm_update(s);
            goto forward;
        }
    }
    for (i = 0; i < LEDC_CHANNEL_COUNT; i++) {
        if (addr == LEDC_CH_CONF0_REG(i)) {
            s->ledc_ch_conf0[i] = v;
            ledc_pwm_update(s);
            goto forward;
        }
        if (addr == LEDC_CH_DUTY_REG(i)) {
            s->ledc_ch_duty[i] = v;
            ledc_pwm_update(s);
            goto forward;
        }
    }

forward:
    if (s->ledc_orig) {
        /* Observe-only shadow: keep the model's own register view in sync. */
        memory_region_dispatch_write(s->ledc_orig, addr, value,
                                     size_memop(size) | MO_LE,
                                     MEMTXATTRS_UNSPECIFIED);
    }
}

static const MemoryRegionOps dbus_ledc_ops = {
    .read = dbus_ledc_read,
    .write = dbus_ledc_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {
        .min_access_size = 1,
        .max_access_size = 4,
    },
};

static void dbus_setup_ledc_shadow(BreadespDbusState *s, Object *ledc)
{
    MemoryRegion *orig = sysbus_mmio_get_region(SYS_BUS_DEVICE(ledc), 0);
    MemoryRegionSection sec;
    size_t i;

    /* Same esp32-only guard as the GPIO shadow: the DPORT window must host
     * this very region (esp32s3/c3 map LEDC elsewhere). */
    sec = memory_region_find(get_system_memory(), breadesp_ledc_bases[0], 4);
    if (sec.mr != orig) {
        return;
    }

    s->ledc_orig = orig;
    for (i = 0; i < ARRAY_SIZE(breadesp_ledc_bases); i++) {
        memory_region_init_io(&s->ledc_mr[i], OBJECT(s), &dbus_ledc_ops,
                              s, "breadesp.ledc-shadow",
                              memory_region_size(orig));
        memory_region_add_subregion_overlap(get_system_memory(),
                                            breadesp_ledc_bases[i],
                                            &s->ledc_mr[i], 1);
        s->ledc_nmr++;
    }
}

/* ------------------------------------------------------------------ */
/* I2S MMIO shadow + DMA PCM walker (P2.4)                             */

/*
 * Decode the effective PCM format from the observed registers. Mirrors the
 * ESP32 TRM master-mode formulas with a fixed 160MHz PLL source (APLL is a
 * documented gap): sck = 160M / (div_num + div_b/div_a), bck = sck / bck_div,
 * ws = bck / (bits * channels). Returns false for configurations that cannot
 * produce audio (bypass divisors, implausible rates).
 */
static bool i2s_decode_format(BreadespI2sChan *c, uint32_t *rate_out,
                              uint8_t *bits_out, uint8_t *channels_out)
{
    uint32_t div_num = c->clkm_conf & I2S_CLKM_DIV_NUM_MASK;
    uint32_t div_b = (c->clkm_conf >> I2S_CLKM_DIV_B_SHIFT) & I2S_CLKM_DIV_B_MASK;
    uint32_t div_a = (c->clkm_conf >> I2S_CLKM_DIV_A_SHIFT) & I2S_CLKM_DIV_A_MASK;
    uint32_t bck_div = (c->srate_conf >> I2S_TX_BCK_DIV_SHIFT) & I2S_TX_BCK_DIV_MASK;
    uint32_t bits = (c->srate_conf >> I2S_TX_BITS_MOD_SHIFT) & I2S_TX_BITS_MOD_MASK;
    uint32_t channels = (c->conf & I2S_CONF_TX_MONO) ? 1 : 2;
    double div, ws;

    if (div_num < 2 || bck_div == 0) {
        return false;
    }
    if (bits == 0) {
        bits = 16; /* driver default when the field is left at reset */
    }
    if (bits < 8 || bits > 32 || (bits & 7) != 0) {
        return false;
    }
    div = (double)div_num + (div_a != 0 ? (double)div_b / (double)div_a : 0.0);
    ws = I2S_CLKM_PLL_HZ / div / (double)bck_div / ((double)bits * channels);
    if (ws < 1000.0 || ws > 192000.0) {
        return false;
    }
    *rate_out = (uint32_t)(ws + 0.5);
    *bits_out = (uint8_t)bits;
    *channels_out = (uint8_t)channels;
    return true;
}

static void i2s_stop_channel(BreadespI2sChan *c)
{
    c->streaming = false;
    if (c->tick) {
        timer_del(c->tick);
    }
    if (c->chunk) {
        g_byte_array_set_size(c->chunk, 0);
    }
}

/*
 * Re-evaluate the streaming condition after a CONF / OUT_LINK write:
 * TX started, not held in reset, and an out-link chain was armed. Stopping
 * (TX_START cleared, TX_RESET, or OUTLINK_STOP) halts the walker and drops
 * the partial chunk.
 */
static void i2s_eval(BreadespI2sChan *c)
{
    bool want = (c->conf & I2S_CONF_TX_START) != 0
                && (c->conf & I2S_CONF_TX_RESET) == 0
                && (c->out_link & I2S_OUTLINK_STOP) == 0
                && c->desc != 0;

    if (want && !c->streaming) {
        c->streaming = true;
        timer_mod(c->tick,
                  qemu_clock_get_ms(QEMU_CLOCK_VIRTUAL) + I2S_TICK_MS);
    } else if (!want && c->streaming) {
        i2s_stop_channel(c);
    }
}

/* Guest-memory read for descriptor chain walking / PCM fetching. */
static bool i2s_dma_read(BreadespI2sChan *c, uint64_t addr, void *dst,
                         size_t len)
{
    if (address_space_read(&address_space_memory, addr,
                           MEMTXATTRS_UNSPECIFIED, dst, len) != MEMTX_OK) {
        if (!c->dma_warned) {
            c->dma_warned = true;
            warn_report("breadesp-dbus: i2s%u DMA read at 0x%llx failed; "
                        "stream stopped", c->bus, (unsigned long long)addr);
        }
        return false;
    }
    return true;
}

/*
 * Consumption tick: pull I2S_TICK_MS worth of PCM through the descriptor
 * chain at the decoded byte rate and emit it as one i2s transaction. Rings
 * (a descriptor whose next points back into the chain) loop forever, which
 * is exactly how firmware sustains a continuous tone; the per-tick byte and
 * descriptor-fetch caps keep zero-length/self-pointing descriptors from
 * spinning the loop.
 */
#define I2S_TICK_MAX_FETCHES 64

static void i2s_tick(void *opaque)
{
    BreadespI2sChan *c = opaque;
    BreadespDbusState *s = c->owner;
    uint32_t rate, due;
    uint8_t bits, channels;
    unsigned fetches = 0;

    if (!c->streaming) {
        return;
    }
    if (!i2s_decode_format(c, &rate, &bits, &channels)) {
        i2s_stop_channel(c);
        return;
    }

    due = (uint32_t)((double)rate * (bits / 8.0) * channels * I2S_TICK_MS
                     / 1000.0 + 0.5);
    if (due > I2S_TICK_MAX_BYTES) {
        due = I2S_TICK_MAX_BYTES;
    }

    while (due > 0) {
        if (c->remaining == 0) {
            uint8_t d[12];
            uint32_t len;
            if (c->desc == 0 || ++fetches > I2S_TICK_MAX_FETCHES) {
                break; /* chain drained (or pathological): idle until restart */
            }
            if (!i2s_dma_read(c, c->desc, d, sizeof(d))) {
                i2s_stop_channel(c);
                return;
            }
            len = (ldl_le_p(d) >> I2S_LLDESC_LEN_SHIFT) & I2S_LLDESC_LEN_MASK;
            c->buf = ldl_le_p(d + 4);
            c->desc = ldl_le_p(d + 8);
            c->remaining = len;
            continue;
        }
        uint32_t n = MIN(due, c->remaining);
        g_byte_array_set_size(c->chunk, c->chunk->len + n);
        if (!i2s_dma_read(c, c->buf,
                          c->chunk->data + c->chunk->len - n, n)) {
            i2s_stop_channel(c);
            return;
        }
        c->buf += n;
        c->remaining -= n;
        due -= n;
    }

    if (c->chunk->len > 0) {
        uint8_t flags = (c->conf & I2S_CONF_TX_MSB_SHIFT) ? 1 : 0;
        dbus_emit_i2s(s, c->bus, rate, bits, channels, flags,
                      c->chunk->data, c->chunk->len);
        g_byte_array_set_size(c->chunk, 0);
    }
    if (c->streaming) {
        timer_mod(c->tick,
                  qemu_clock_get_ms(QEMU_CLOCK_VIRTUAL) + I2S_TICK_MS);
    }
}

static uint64_t dbus_i2s_read(void *opaque, hwaddr addr, unsigned size)
{
    BreadespI2sChan *c = opaque;
    uint64_t val = 0;

    if (c->owner->i2s_orig[c->bus]) {
        memory_region_dispatch_read(c->owner->i2s_orig[c->bus], addr, &val,
                                    size_memop(size) | MO_LE,
                                    MEMTXATTRS_UNSPECIFIED);
    }
    return val;
}

static void dbus_i2s_write(void *opaque, hwaddr addr, uint64_t value,
                           unsigned size)
{
    BreadespI2sChan *c = opaque;
    uint32_t v = (uint32_t)value;

    switch (addr) {
    case I2S_CONF_REG:
        c->conf = v;
        i2s_eval(c);
        break;
    case I2S_OUT_LINK_REG:
        c->out_link = v;
        if (v & (I2S_OUTLINK_START | I2S_OUTLINK_RESTART)) {
            c->desc = I2S_OUTLINK_ADDR_BASE | (v & I2S_OUTLINK_ADDR_MASK);
            c->buf = 0;
            c->remaining = 0;
            c->dma_warned = false;
        }
        i2s_eval(c);
        break;
    case I2S_CLKM_CONF_REG:
        c->clkm_conf = v;
        break;
    case I2S_SAMPLE_RATE_CONF_REG:
        c->srate_conf = v;
        break;
    default:
        break;
    }

    if (c->owner->i2s_orig[c->bus]) {
        /* Observe-only shadow: keep the stub's register view in sync. */
        memory_region_dispatch_write(c->owner->i2s_orig[c->bus], addr, value,
                                     size_memop(size) | MO_LE,
                                     MEMTXATTRS_UNSPECIFIED);
    }
}

static const MemoryRegionOps dbus_i2s_ops = {
    .read = dbus_i2s_read,
    .write = dbus_i2s_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {
        .min_access_size = 1,
        .max_access_size = 4,
    },
};

/*
 * The stock tree models esp32.i2s0/1 as unimplemented-device stubs, so there
 * is no QOM type to match in the scan — probe the two esp32 base addresses
 * directly (esp32s3/c3 map their I2S banks elsewhere, so the probe doubles
 * as the esp32-only guard, like the GPIO shadow's DPORT probe).
 */
static void dbus_setup_i2s_shadows(BreadespDbusState *s)
{
    size_t i;

    for (i = 0; i < ARRAY_SIZE(breadesp_i2s_bases); i++) {
        MemoryRegionSection sec = memory_region_find(get_system_memory(),
                                                     breadesp_i2s_bases[i], 4);
        BreadespI2sChan *c;

        if (!sec.mr) {
            continue;
        }
        c = &s->i2s[i];
        c->owner = s;
        c->bus = (uint8_t)i;
        c->chunk = g_byte_array_new();
        c->tick = timer_new_ms(QEMU_CLOCK_VIRTUAL, i2s_tick, c);
        s->i2s_orig[i] = sec.mr;
        memory_region_init_io(&s->i2s_mr[i], OBJECT(s), &dbus_i2s_ops, c,
                              "breadesp.i2s-shadow", BREADESP_I2S_BANK_SIZE);
        memory_region_add_subregion_overlap(get_system_memory(),
                                            breadesp_i2s_bases[i],
                                            &s->i2s_mr[i], 1);
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
    } else if (object_dynamic_cast(obj, TYPE_ESP32_LEDC)) {
        dbus_setup_ledc_shadow(s, obj);
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

    dbus_setup_i2s_shadows(s);
    if (!s->i2s_orig[0] && !s->i2s_orig[1]) {
        warn_report("breadesp-dbus: no esp32.i2s register banks found; "
                    "I2S forwarding disabled");
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
    while (s->ledc_nmr > 0) {
        s->ledc_nmr--;
        memory_region_del_subregion(get_system_memory(),
                                    &s->ledc_mr[s->ledc_nmr]);
    }
    s->ledc_orig = NULL;
    for (guint i = 0; i < ARRAY_SIZE(breadesp_i2s_bases); i++) {
        BreadespI2sChan *c = &s->i2s[i];
        if (s->i2s_orig[i]) {
            memory_region_del_subregion(get_system_memory(), &s->i2s_mr[i]);
            s->i2s_orig[i] = NULL;
        }
        if (c->tick) {
            timer_free(c->tick);
            c->tick = NULL;
        }
        if (c->chunk) {
            g_byte_array_free(c->chunk, TRUE);
            c->chunk = NULL;
        }
    }
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
    memset(s->gpio_out_sel, 0, sizeof(s->gpio_out_sel));
    memset(s->ledc_timer_conf, 0, sizeof(s->ledc_timer_conf));
    memset(s->ledc_ch_conf0, 0, sizeof(s->ledc_ch_conf0));
    memset(s->ledc_ch_duty, 0, sizeof(s->ledc_ch_duty));
    memset(s->pwm_last_centi, 0, sizeof(s->pwm_last_centi));
    memset(s->pwm_last_duty, 0, sizeof(s->pwm_last_duty));
    for (guint i = 0; i < ARRAY_SIZE(breadesp_i2s_bases); i++) {
        BreadespI2sChan *c = &s->i2s[i];
        c->conf = 0;
        c->clkm_conf = 0;
        c->srate_conf = 0;
        c->out_link = 0;
        c->desc = 0;
        c->buf = 0;
        c->remaining = 0;
        c->dma_warned = false;
        i2s_stop_channel(c);
    }
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
