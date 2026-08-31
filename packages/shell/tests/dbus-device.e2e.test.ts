// PRD: §4.2, §6.7 — dev-plan task P1.2 acceptance (end-to-end, real QEMU + custom
// device). Boots the i2c.elf fixture (GPIO toggles + one I2C write to 0x3C) on the
// breadesp-built qemu-system-xtensa and asserts the DBusChannel receives the
// serialized transactions. Skips when the device-enabled QEMU binary is absent:
// set BREADESP_QEMU_DBUS_BIN or build it with `node scripts/build-qemu-device.mjs`.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BusTransaction } from '@breadesp/peripherals';
import { DBusChannel } from '../src/qemu/DBusChannel.js';
import { QemuRunner } from '../src/qemu/QemuRunner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'i2c.elf');
const DBUS_META = join(REPO_ROOT, 'packages', 'sim-core', 'bin', 'qemu-breadesp.json');

interface DbusMeta {
  target?: string;
  binaryPath?: string;
  repoRelativePath?: string;
}

/** Manifest written by scripts/build-qemu-device.mjs — trusted repo artifact. */
function resolveDbusQemuBin(): string | null {
  const fromEnv = process.env.BREADESP_QEMU_DBUS_BIN;
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  if (!existsSync(DBUS_META)) return null;
  let meta: DbusMeta;
  try {
    meta = JSON.parse(readFileSync(DBUS_META, 'utf8')) as DbusMeta;
  } catch {
    return null;
  }
  // A linux-docker build produces a Linux ELF; it cannot run on other hosts.
  if (meta.target === 'linux-docker' && process.platform !== 'linux') return null;
  for (const p of [meta.binaryPath, meta.repoRelativePath]) {
    if (typeof p === 'string' && p.length > 0 && existsSync(p)) return p;
  }
  if (typeof meta.repoRelativePath === 'string') {
    const rel = join(REPO_ROOT, meta.repoRelativePath);
    if (existsSync(rel)) return rel;
  }
  return null;
}

const QEMU_DBUS_BIN = resolveDbusQemuBin();

function needBin(): string {
  if (QEMU_DBUS_BIN === null) throw new Error('device-enabled QEMU missing; run node scripts/build-qemu-device.mjs');
  return QEMU_DBUS_BIN;
}

describe.skipIf(QEMU_DBUS_BIN === null)('DBusChannel e2e (breadesp-dbus device, real QEMU-ESP32)', () => {
  it('receives GPIO and I2C transactions serialized to length-prefixed frames', async () => {
    const txs: BusTransaction[] = [];
    const dbus = new DBusChannel();
    dbus.onTransaction((tx) => txs.push(tx));
    await dbus.listen({}); // ephemeral TCP port on 127.0.0.1

    const runner = new QemuRunner();
    const logs: string[] = [];
    runner.on('log', (s: string) => logs.push(s));

    try {
      // The device connects out during its realize, so listening must precede load().
      await runner.load({
        firmwareElf: FIXTURE_ELF,
        chip: 'esp32',
        qemuBin: needBin(),
        dbus: { port: dbus.port },
      });
      expect(runner.getStatus()).toBe('loaded');

      await runner.start();
      expect(runner.getStatus()).toBe('running');

      const t0 = Date.now();
      for (;;) {
        const gpio = txs.find((t) => t.kind === 'gpio' && t.target === 2 && t.dir === 'write' && t.data?.[0] === 1);
        const i2c = txs.find((t) => t.kind === 'i2c' && t.target === 0x3c && t.dir === 'write');
        if (gpio && i2c) break;
        if (Date.now() - t0 > 30000) {
          throw new Error(
            `expected GPIO + I2C transactions within 30s. status=${runner.getStatus()} ` +
            `uart=${JSON.stringify(runner.getUartLog())} txs=${JSON.stringify(txs)} log=${JSON.stringify(logs.join(''))}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      // PRD §6.3/§6.7 field mapping: LED on via GPIO_OUT_W1TS (i2c.elf transaction 1).
      const gpioOn = txs.find((t) => t.kind === 'gpio' && t.target === 2 && t.data?.[0] === 1);
      expect(gpioOn).toMatchObject({ bus: 0, target: 2, dir: 'write' });
      expect(Array.from(gpioOn!.data ?? [])).toEqual([1]);
      expect(gpioOn!.ts).toBeGreaterThanOrEqual(0); // virtual ns -> logical ms

      // SSD1306 write: FIFO [0x78, 0x00, 0xAE] -> one write frame to 0x3C.
      const i2c = txs.find((t) => t.kind === 'i2c' && t.target === 0x3c && t.dir === 'write');
      expect(i2c).toMatchObject({ kind: 'i2c', bus: 0, target: 0x3c, dir: 'write' });
      expect(Array.from(i2c!.data ?? [])).toEqual([0x00, 0xae]);

      // LED off (transaction 2) must also arrive, after the I2C transfer in program order.
      const gpioOff = txs.find((t) => t.kind === 'gpio' && t.target === 2 && t.data?.[0] === 0);
      expect(gpioOff).toBeDefined();
      expect(gpioOff!.ts).toBeGreaterThanOrEqual(i2c!.ts);

      // Firmware completion marker on UART0 (independent of the dbus channel).
      expect(runner.getUartLog()).toContain('I2C OK');
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
    }
  }, 60000);
});
