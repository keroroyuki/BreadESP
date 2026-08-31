// PRD: §4.2, §6.5 — Resolve bus/target -> peripheral instanceId using the netlist wiring.
// Routing rules (MVP, dev-plan task P1.4):
//   - i2c:  7-bit address match. The instance's address is props.address, falling
//           back to the factory's defaults.address. The wire matrix of the ESP32
//           means an MCU pin cannot identify the I2C controller, so the bus field
//           is not part of the match.
//   - gpio: pin-level match via wires. tx.target is the GPIO number; a wire with
//           one endpoint on { instanceId: 'mcu', pin: 'GPIO<n>' } routes the
//           transaction to the peripheral at the other endpoint.
//   - spi/pwm/i2s/adc: not routable yet (no consumers; TODO with their phases).
import type { Netlist, PeripheralInstance } from '@breadesp/netlist';
import { MCU_INSTANCE_ID } from '@breadesp/netlist';
import { getFactory } from '@breadesp/peripherals';
import type { BusTransaction } from '@breadesp/peripherals';

export interface ResolvedTarget {
  instanceId: string;
  pin?: string;
}

const EMPTY_NETLIST: Netlist = { version: 1, chip: 'esp32', peripherals: [], wires: [] };

export class NetlistResolver {
  /** 7-bit I2C address -> instances claiming it. */
  private i2cByAddress = new Map<number, ResolvedTarget[]>();
  /** MCU pin name (e.g. 'GPIO2') -> wired peripheral endpoints. */
  private gpioByPin = new Map<string, ResolvedTarget[]>();

  constructor(netlist: Netlist = EMPTY_NETLIST) {
    this.setNetlist(netlist);
  }

  /** Rebuild the routing indexes from a (validated) netlist. */
  setNetlist(n: Netlist): void {
    this.i2cByAddress = new Map();
    this.gpioByPin = new Map();

    for (const inst of n.peripherals) this.indexI2cAddress(inst);
    for (const wire of n.wires) this.indexGpioWire(wire.from, wire.to);
  }

  /** Map a bus transaction onto the peripheral instance(s) it should reach. */
  resolve(tx: BusTransaction): ResolvedTarget[] {
    switch (tx.kind) {
      case 'i2c':
        // TODO(PRD §6.5): the netlist cannot bind a peripheral to an I2C
        // controller number yet; route by 7-bit address across buses.
        return tx.target === undefined ? [] : [...(this.i2cByAddress.get(tx.target) ?? [])];
      case 'gpio':
        // tx.target is the GPIO number; wires name MCU pins 'GPIO<n>'.
        return tx.target === undefined ? [] : [...(this.gpioByPin.get(`GPIO${tx.target}`) ?? [])];
      default:
        // TODO(PRD §4.2): spi(cs)/pwm/i2s/adc pin-level routing lands with the
        // corresponding peripheral models (P2/P3); nothing consumes them today.
        return [];
    }
  }

  private indexI2cAddress(inst: PeripheralInstance): void {
    const raw = inst.props?.address ?? getFactory(inst.kind)?.defaults?.address;
    const addr = Number(raw);
    if (!Number.isInteger(addr) || addr < 0 || addr > 0x7f) return;
    this.push(this.i2cByAddress, addr, { instanceId: inst.instanceId, pin: 'SDA' });
  }

  private indexGpioWire(
    from: { instanceId: string; pin: string },
    to: { instanceId: string; pin: string },
  ): void {
    // Only mcu <-> peripheral wires are routable; peripheral-to-peripheral
    // wires carry no MCU pin and are ignored.
    if (from.instanceId === MCU_INSTANCE_ID && to.instanceId !== MCU_INSTANCE_ID) {
      this.push(this.gpioByPin, from.pin, { instanceId: to.instanceId, pin: to.pin });
    } else if (to.instanceId === MCU_INSTANCE_ID && from.instanceId !== MCU_INSTANCE_ID) {
      this.push(this.gpioByPin, to.pin, { instanceId: from.instanceId, pin: from.pin });
    }
  }

  private push(map: Map<string | number, ResolvedTarget[]>, key: string | number, value: ResolvedTarget): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
}
