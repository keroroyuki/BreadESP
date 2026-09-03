// PRD: §F-SIM-1/2/4 — dev-plan task P2.6 acceptance (end-to-end, real QEMU).
// Boots blink.elf on the breadesp-dbus QEMU and observes the GPIO2 transaction
// stream's wall-clock arrival rate: pausing freezes the virtual clock (zero
// transactions), resuming restores it, and a 0.25x speed factor stretches the
// same virtual-time work over ~4x the wall time via the QMP stop/cont duty
// cycle. Skips when the device-enabled QEMU binary is absent.
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BusTransaction } from '@breadesp/peripherals';
import { DBusChannel } from '../src/qemu/DBusChannel.js';
import { QemuRunner } from '../src/qemu/QemuRunner.js';
import { needDbusQemuBin, resolveDbusQemuBin } from './helpers/dbus-qemu.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'blink.elf');

const QEMU_DBUS_BIN = resolveDbusQemuBin();

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(QEMU_DBUS_BIN === null)('sim speed e2e (P2.6 acceptance, real QEMU-ESP32)', () => {
  it('pauses, resumes and throttles the logical clock via QMP', async () => {
    let txCount = 0;
    const dbus = new DBusChannel();
    dbus.onTransaction((_tx: BusTransaction) => { txCount++; });
    await dbus.listen({});

    const runner = new QemuRunner();
    const speeds: number[] = [];
    runner.on('speed', (f: number) => speeds.push(f));
    try {
      await runner.load({
        firmwareElf: FIXTURE_ELF,
        chip: 'esp32',
        qemuBin: needDbusQemuBin(),
        dbus: { port: dbus.port },
      });
      await runner.start();
      expect(runner.getStatus()).toBe('running');

      // Baseline: full-speed arrival rate of GPIO2 toggle transactions.
      await delay(500); // boot settles into the blink loop
      txCount = 0;
      await delay(1500);
      const fullRate = txCount / 1.5; // tx per second
      expect(fullRate).toBeGreaterThan(0);

      // Pause: QMP stop freezes the virtual clock — the stream must dry up.
      await runner.pause();
      expect(runner.getStatus()).toBe('paused');
      txCount = 0;
      await delay(800);
      expect(txCount).toBe(0);

      // Resume: the stream comes back.
      await runner.start();
      expect(runner.getStatus()).toBe('running');
      txCount = 0;
      await delay(1000);
      expect(txCount).toBeGreaterThan(0);

      // 0.25x: the same virtual-time blink stretches over ~4x the wall time.
      runner.setSpeed(0.25);
      expect(speeds).toContain(0.25);
      expect(runner.getStatus()).toBe('running'); // throttle halts stay internal
      await delay(500); // settle into the duty cycle
      txCount = 0;
      await delay(2000);
      const slowRate = txCount / 2;
      expect(slowRate).toBeGreaterThan(0);
      expect(slowRate).toBeLessThan(fullRate * 0.6);
      expect(slowRate).toBeGreaterThan(fullRate * 0.05);

      // Restoring 1x brings the full rate back.
      runner.setSpeed(1);
      await delay(500);
      txCount = 0;
      await delay(1500);
      expect(txCount / 1.5).toBeGreaterThan(fullRate * 0.6);
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
    }
  }, 60000);
});
