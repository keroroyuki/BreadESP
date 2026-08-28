// PRD: §6.6 — Resolve bus/target -> peripheral instanceId using the netlist wiring.
// MVP rule: an I2C peripheral's address (inst.props.address) matches tx.target on the same I2C bus.
// TODO(PRD §4.2): full resolver covering SPI/GPIO/I2S/ADC with pin wiring.
import type { Netlist } from '@breadesp/netlist';
import type { BusTransaction } from '@breadesp/peripherals';

export interface ResolvedTarget { instanceId: string; pin?: string; }

export class NetlistResolver {
  constructor(private netlist: Netlist) {}

  resolve(tx: BusTransaction): ResolvedTarget[] {
    const out: ResolvedTarget[] = [];
    for (const p of this.netlist.peripherals) {
      if (tx.kind === 'i2c') {
        const addr = Number(p.props?.address);
        if (addr === tx.target) out.push({ instanceId: p.instanceId, pin: 'SDA' });
      } else if (tx.kind === 'spi' || tx.kind === 'gpio' || tx.kind === 'pwm' || tx.kind === 'i2s' || tx.kind === 'adc') {
        // TODO: pin-level resolution via wires.
        out.push({ instanceId: p.instanceId });
      }
    }
    return out;
  }

  setNetlist(n: Netlist): void { this.netlist = n; }
}
