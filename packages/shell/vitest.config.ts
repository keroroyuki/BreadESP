// Vitest config for @breadesp/shell.
// Serial execution: several suites spawn a real qemu-system-xtensa (uart/dbus/
// spi/pwm/i2s/scope/speed e2e). Running them concurrently makes the guests
// compete for host CPU, and the oscilloscope period assertion (10% edge-
// spacing band) flakes under that jitter — surfaced when the P2.6 sim-speed
// e2e added a long-running duty-cycled guest to the pool. One thread keeps
// real-hardware measurements deterministic; unit tests are fast either way.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
