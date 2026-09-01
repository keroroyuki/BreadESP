// PRD: §4.2, §6.3, §6.5 — dev-plan task P2.3 acceptance (end-to-end): boots
// buzzer.elf on the breadesp-dbus QEMU; the firmware configures LEDC HS
// timer0/channel0 for a 440Hz square wave routed through the GPIO matrix onto
// GPIO4, then retunes to 880Hz. The device's LEDC + GPIO-matrix shadows decode
// each configuration into a pwm transaction, NetlistResolver routes it over
// the GPIO4 wire to buzz1, and the buzzer model emits tone snapshots.
// Skips when the device-enabled QEMU binary is absent (tests/helpers/dbus-qemu.ts).
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Netlist } from '@breadesp/netlist';
import type { RenderSnapshot } from '@breadesp/peripherals';
import { registerBuiltins } from '@breadesp/peripherals';
import { DBusChannel } from '../src/qemu/DBusChannel.js';
import { QemuRunner } from '../src/qemu/QemuRunner.js';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';
import { needDbusQemuBin, resolveDbusQemuBin } from './helpers/dbus-qemu.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'buzzer.elf');

const QEMU_DBUS_BIN = resolveDbusQemuBin();

registerBuiltins();

// buzzer.elf drives GPIO4; the buzzer's '+' pin is wired to it.
const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [{ instanceId: 'buzz1', kind: 'buzzer' }],
  wires: [
    { id: 'w-sig', from: { instanceId: 'buzz1', pin: '+' }, to: { instanceId: 'mcu', pin: 'GPIO4' } },
  ],
};

interface TonePayload {
  freqHz: number;
  duty: number;
}

function toneOf(s: RenderSnapshot): TonePayload {
  if (s.type !== 'tone' || !('freqHz' in s.payload)) {
    throw new Error(`expected tone snapshot, got ${JSON.stringify(s)}`);
  }
  return s.payload as TonePayload;
}

describe.skipIf(QEMU_DBUS_BIN === null)('buzzer PWM e2e (P2.3 acceptance, real QEMU-ESP32)', () => {
  it('decodes the LEDC 440Hz -> 880Hz sequence on GPIO4 into tone snapshots', async () => {
    const snapshots: RenderSnapshot[] = [];
    const manager = new PeripheralManager();
    manager.on('snapshot', (s: RenderSnapshot) => snapshots.push(s));
    manager.applyNetlist(NETLIST);

    const dbus = new DBusChannel();
    dbus.onTransaction((tx) => manager.route(tx));
    await dbus.listen({}); // ephemeral TCP port on 127.0.0.1

    const runner = new QemuRunner();
    try {
      // The device connects out during its realize, so listening must precede load().
      await runner.load({
        firmwareElf: FIXTURE_ELF,
        chip: 'esp32',
        qemuBin: needDbusQemuBin(),
        dbus: { port: dbus.port },
      });
      await runner.start();

      // Wait for the retune: the last tone snapshot must be the 880Hz one.
      const t0 = Date.now();
      let tones: TonePayload[] = [];
      for (;;) {
        tones = snapshots
          .filter((s) => s.instanceId === 'buzz1' && s.type === 'tone')
          .map(toneOf);
        if (tones.length >= 2 && tones.at(-1)!.freqHz > 800) break;
        if (Date.now() - t0 > 30000) {
          throw new Error(
            `expected buzz1 tone snapshots [~440Hz, ~880Hz], got ${JSON.stringify(tones)}. `
              + `status=${runner.getStatus()} uart=${JSON.stringify(runner.getUartLog())} `
              + `snapshots=${snapshots.length}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      // The full tone sequence: 440Hz (~50% duty), then 880Hz.
      const sounding = tones.filter((t) => t.freqHz > 0 && t.duty > 0);
      expect(sounding[0].freqHz).toBeGreaterThan(430);
      expect(sounding[0].freqHz).toBeLessThan(450);
      expect(sounding[0].duty).toBeGreaterThan(0.45);
      expect(sounding[0].duty).toBeLessThan(0.55);
      const last = sounding.at(-1)!;
      expect(last.freqHz).toBeGreaterThan(860);
      expect(last.freqHz).toBeLessThan(900);

      // Only the wired instance produced snapshots (no broadcast leakage).
      expect(new Set(snapshots.map((s) => s.instanceId))).toEqual(new Set(['buzz1']));

      // Firmware markers on UART0 (independent of the routing path).
      expect(runner.getUartLog()).toContain('BUZZ 440');
      expect(runner.getUartLog()).toContain('BUZZ 880');
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
      manager.dispose();
    }
  }, 60000);
});
