// Vitest config for @breadesp/shell.
// Serial execution: several suites spawn a real qemu-system-xtensa (uart/dbus/
// spi/pwm/i2s/scope/speed e2e). Running them concurrently makes the guests
// compete for host CPU, and the oscilloscope period assertion (10% edge-
// spacing band) flakes under that jitter — surfaced when the P2.6 sim-speed
// e2e added a long-running duty-cycled guest to the pool. One thread keeps
// real-hardware measurements deterministic; unit tests are fast either way.
//
// Aliases pin @breadesp/* imports to workspace source: the package "main"
// fields point at compiled dist/ for the Electron runtime, and tests must
// always exercise src (PRD §10 source-first rule; no stale-dist drift).
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@breadesp/netlist': resolve(__dirname, '../netlist/src/index.ts'),
      '@breadesp/peripherals': resolve(__dirname, '../peripherals/src/index.ts'),
      '@breadesp/sim-core': resolve(__dirname, '../sim-core/src/index.ts'),
    },
  },
  test: {
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
