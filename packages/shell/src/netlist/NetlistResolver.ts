// PRD: §4.2, §6.5 — Resolve bus/target -> peripheral instanceId using the netlist wiring.
// Routing rules (MVP, dev-plan tasks P1.4 + P2.1):
//   - i2c:  7-bit address match. The instance's address is props.address, falling
//           back to the factory's defaults.address. The wire matrix of the ESP32
//           means an MCU pin cannot identify the I2C controller, so the bus field
//           is not part of the match.
//   - spi:  CS-line match. tx.target is the SPI controller's CS index (0-2); the
//           instance claims it via props.cs (factory default 0). Like I2C, the
//           controller number is not part of the match — the netlist cannot
//           bind a peripheral to a bus number (the QEMU CS lines are virtual,
//           not routed through the GPIO matrix). The MOSI/SCK/DC wires are for
//           gpio routing (DC) and UI drawing, not for SPI delivery.
//   - gpio: pin-level match via wires. tx.target is the GPIO number; a wire with
//           one endpoint on { instanceId: 'mcu', pin: 'GPIO<n>' } routes the
//           transaction to the peripheral at the other endpoint.
//   - pwm:  same pin-level wire routing as gpio (dev-plan task P2.3: the
//           device's LEDC shadow decodes freq/duty per output pin).
//   - i2s:  controller-number claim (dev-plan task P2.4). tx.bus is the I2S
//           controller index (0/1); the instance claims it via props.bus
//           (factory default 0), and only kinds whose factory pin table
//           exposes an i2s-data-in role match — mirroring the SPI CS claim.
//           The DIN/WS/BCK wires are for UI drawing only: the QEMU device
//           forwards PCM straight from the DMA engine, before the GPIO
//           matrix, so no pin identity exists at the transaction level.
//   - adc:  not routable yet (no consumers; TODO with P3).
import type { Netlist, PeripheralInstance } from '@breadesp/netlist';
import { MCU_INSTANCE_ID } from '@breadesp/netlist';
import { getFactory } from '@breadesp/peripherals';
import type { BusTransaction } from '@breadesp/peripherals';

export interface ResolvedTarget {
  instanceId: string;
  pin?: string;
}

const EMPTY_NETLIST: Netlist = { version: 1, chip: 'esp32', peripherals: [], wires: [] };

/** ESP32 SPI controllers expose three hardware CS lines (hw/ssi/esp32_spi.h). */
const SPI_CS_MAX = 2;
/** ESP32 has two legacy I2S controllers (I2S0/I2S1). */
const I2S_BUS_MAX = 1;

export class NetlistResolver {
  /** 7-bit I2C address -> instances claiming it. */
  private i2cByAddress = new Map<number, ResolvedTarget[]>();
  /** SPI CS line index -> instances claiming it. */
  private spiByCs = new Map<number, ResolvedTarget[]>();
  /** MCU pin name (e.g. 'GPIO2') -> wired peripheral endpoints. */
  private gpioByPin = new Map<string, ResolvedTarget[]>();
  /** I2S controller number -> instances claiming it. */
  private i2sByBus = new Map<number, ResolvedTarget[]>();
  /** `${instanceId}|${pinId}` -> wired MCU GPIO number (P3.4 input injection). */
  private gpioInputByInstancePin = new Map<string, number>();

  constructor(netlist: Netlist = EMPTY_NETLIST) {
    this.setNetlist(netlist);
  }

  /** Rebuild the routing indexes from a (validated) netlist. */
  setNetlist(n: Netlist): void {
    this.i2cByAddress = new Map();
    this.spiByCs = new Map();
    this.gpioByPin = new Map();
    this.i2sByBus = new Map();
    this.gpioInputByInstancePin = new Map();

    for (const inst of n.peripherals) {
      this.indexI2cAddress(inst);
      this.indexSpiCs(inst);
      this.indexI2sBus(inst);
    }
    for (const wire of n.wires) this.indexGpioWire(wire.from, wire.to);
  }

  /** Map a bus transaction onto the peripheral instance(s) it should reach. */
  resolve(tx: BusTransaction): ResolvedTarget[] {
    switch (tx.kind) {
      case 'i2c':
        // TODO(PRD §6.5): the netlist cannot bind a peripheral to an I2C
        // controller number yet; route by 7-bit address across buses.
        return tx.target === undefined ? [] : [...(this.i2cByAddress.get(tx.target) ?? [])];
      case 'spi':
        // tx.target is the CS line index (0-2) the QEMU device framed the
        // transaction on; routing follows the claimed CS, not the wires.
        return tx.target === undefined ? [] : [...(this.spiByCs.get(tx.target) ?? [])];
      case 'gpio':
      case 'pwm':
        // tx.target is the GPIO number; wires name MCU pins 'GPIO<n>'. PWM
        // (LEDC decoded by the device shadow, P2.3) is a per-pin output like
        // gpio level writes, so it follows the same wire routing.
        return tx.target === undefined ? [] : [...(this.gpioByPin.get(`GPIO${tx.target}`) ?? [])];
      case 'i2s':
        // tx.bus is the I2S controller number (the device forwards DMA PCM
        // per controller); routing follows the claimed bus, not the wires.
        return [...(this.i2sByBus.get(tx.bus) ?? [])];
      default:
        // TODO(PRD §4.2): adc routing lands with the input models (P3).
        return [];
    }
  }

  /**
   * Reverse lookup (P3.4 input injection): the MCU GPIO number wired to a
   * peripheral pin, e.g. resolveGpioInput('knob1', 'A') -> 4 when a wire
   * joins knob1.A to mcu.GPIO4. Undefined when the pin is unwired (or the
   * wire's MCU endpoint is not a GPIO pin name).
   */
  resolveGpioInput(instanceId: string, pinId: string): number | undefined {
    return this.gpioInputByInstancePin.get(`${instanceId}|${pinId}`);
  }

  private indexI2cAddress(inst: PeripheralInstance): void {
    const factory = getFactory(inst.kind);
    const raw = inst.props?.address ?? factory?.defaults?.address;
    const addr = Number(raw);
    if (!Number.isInteger(addr) || addr < 0 || addr > 0x7f) return;
    this.push(this.i2cByAddress, addr, { instanceId: inst.instanceId, pin: 'SDA' });
  }

  private indexSpiCs(inst: PeripheralInstance): void {
    // Only kinds that actually expose an SPI CS pin claim SPI transactions;
    // the role filter keeps e.g. LEDs with a numeric prop from matching.
    const factory = getFactory(inst.kind);
    if (!factory?.pins.some((p) => p.role === 'spi-cs')) return;
    const raw = inst.props?.cs ?? factory.defaults?.cs;
    const cs = Number(raw);
    if (!Number.isInteger(cs) || cs < 0 || cs > SPI_CS_MAX) return;
    this.push(this.spiByCs, cs, { instanceId: inst.instanceId, pin: 'CS' });
  }

  private indexI2sBus(inst: PeripheralInstance): void {
    // Only kinds that actually consume I2S data claim I2S transactions; the
    // role filter keeps e.g. an LED with a numeric prop from matching.
    const factory = getFactory(inst.kind);
    if (!factory?.pins.some((p) => p.role === 'i2s-data-in')) return;
    const raw = inst.props?.bus ?? factory.defaults?.bus;
    const bus = Number(raw);
    if (!Number.isInteger(bus) || bus < 0 || bus > I2S_BUS_MAX) return;
    this.push(this.i2sByBus, bus, { instanceId: inst.instanceId, pin: 'DIN' });
  }

  private indexGpioWire(
    from: { instanceId: string; pin: string },
    to: { instanceId: string; pin: string },
  ): void {
    // Only mcu <-> peripheral wires are routable; peripheral-to-peripheral
    // wires carry no MCU pin and are ignored.
    if (from.instanceId === MCU_INSTANCE_ID && to.instanceId !== MCU_INSTANCE_ID) {
      this.push(this.gpioByPin, from.pin, { instanceId: to.instanceId, pin: to.pin });
      this.indexGpioInput(from.pin, to.instanceId, to.pin);
    } else if (to.instanceId === MCU_INSTANCE_ID && from.instanceId !== MCU_INSTANCE_ID) {
      this.push(this.gpioByPin, to.pin, { instanceId: from.instanceId, pin: from.pin });
      this.indexGpioInput(to.pin, from.instanceId, from.pin);
    }
  }

  /** Reverse-index the peripheral endpoint of an mcu<->peripheral wire (P3.4). */
  private indexGpioInput(mcuPin: string, instanceId: string, pinId: string): void {
    const m = /^GPIO(\d+)$/.exec(mcuPin);
    if (m === null) return; // e.g. 3V3/GND rails carry no routable GPIO
    this.gpioInputByInstancePin.set(`${instanceId}|${pinId}`, Number(m[1]));
  }

  private push(map: Map<string | number, ResolvedTarget[]>, key: string | number, value: ResolvedTarget): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
}
