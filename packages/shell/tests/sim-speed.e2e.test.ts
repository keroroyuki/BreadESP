// PRD: §F-SIM-1/2/4 — dev-plan task P2.6 acceptance (end-to-end, real QEMU).
// Boots blink.elf on the breadesp-dbus QEMU and observes the GPIO2 transaction
// stream: pausing freezes the virtual clock (zero transactions), resuming
// restores it, and a 0.25x speed factor stretches the same virtual-time work
// over ~4x the wall time via the QMP stop/cont duty cycle. Skips when the
// device-enabled QEMU binary is absent.
//
// Assertions measure the logical clock itself — the span between the device's
// virtual-clock timestamps (PRD §6.7) divided by wall time — instead of
// transactions per wall second. Host TCG throughput varies with CPU load and
// power management (observed 25 -> 9 tx/s within one 1x run), while the
// virtual/wall clock ratio stays 1.0; rate-count assertions were therefore
// host-load flaky and are not the contract under test.
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

interface ClockSample {
  /** Transactions observed in the window. */
  count: number;
  /** Virtual-clock milliseconds advanced between first and last transaction. */
  clockSpanMs: number;
  /** Actual wall-clock duration of the window. */
  wallMs: number;
}

describe.skipIf(QEMU_DBUS_BIN === null)('sim speed e2e (P2.6 acceptance, real QEMU-ESP32)', () => {
  it('pauses, resumes and throttles the logical clock via QMP', async () => {
    let stamps: number[] = [];
    const dbus = new DBusChannel();
    dbus.onTransaction((tx: BusTransaction) => { stamps.push(tx.ts); });
    await dbus.listen({});

    // Virtual-clock advance over wall time. Timestamps are frozen while the
    // VM is stopped (QMP stop, duty-cycle halt windows) and otherwise advance
    // at `speed` × wall time, independent of how fast the host executes the
    // guest.
    const sample = async (wallMs: number): Promise<ClockSample> => {
      stamps = [];
      const t0 = performance.now();
      await delay(wallMs);
      const elapsed = performance.now() - t0;
      const count = stamps.length;
      const clockSpanMs = count > 1 ? stamps[count - 1] - stamps[0] : 0;
      return { count, clockSpanMs, wallMs: elapsed };
    };
    const clockRatio = (s: ClockSample): number => s.clockSpanMs / s.wallMs;

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

      // Baseline at 1x: the virtual clock advances with wall time.
      await delay(500); // boot settles into the blink loop
      const fast = await sample(1500);
      expect(fast.count).toBeGreaterThan(0);
      expect(clockRatio(fast)).toBeGreaterThan(0.7);

      // Pause: QMP stop freezes the virtual clock — the stream must dry up.
      await runner.pause();
      expect(runner.getStatus()).toBe('paused');
      stamps = [];
      await delay(800);
      expect(stamps.length).toBe(0);

      // Resume: the stream and the clock come back.
      await runner.start();
      expect(runner.getStatus()).toBe('running');
      const resumed = await sample(1000);
      expect(resumed.count).toBeGreaterThan(0);
      expect(clockRatio(resumed)).toBeGreaterThan(0.7);

      // 0.25x: the clock advances at a quarter of wall time, so the same
      // virtual-time blink stretches over ~4x the wall time.
      runner.setSpeed(0.25);
      expect(speeds).toContain(0.25);
      expect(runner.getStatus()).toBe('running'); // throttle halts stay internal
      await delay(500); // settle into the duty cycle
      const slow = await sample(2000);
      expect(slow.count).toBeGreaterThan(0);
      expect(clockRatio(slow)).toBeGreaterThan(0.15);
      expect(clockRatio(slow)).toBeLessThan(0.4);

      // Restoring 1x brings the clock back to wall time. Comparing against the
      // throttled ratio (not the baseline count) keeps this host-load proof.
      runner.setSpeed(1);
      await delay(500);
      const restored = await sample(1500);
      expect(restored.count).toBeGreaterThan(0);
      expect(clockRatio(restored)).toBeGreaterThan(0.7);
      expect(clockRatio(restored)).toBeGreaterThan(clockRatio(slow) * 2.5);
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
    }
  }, 60000);
});
