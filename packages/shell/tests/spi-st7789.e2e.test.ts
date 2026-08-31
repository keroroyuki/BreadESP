// PRD: §4.2, §6.3, §6.5 — dev-plan task P2.1 acceptance (end-to-end): boots
// spi.elf on the breadesp-dbus QEMU, feeds DBusChannel transactions into
// PeripheralManager, and asserts the NetlistResolver routes the CS0 SPI writes
// to tft1, whose st7789 model renders the TFT_eSPI-style init + pixel stream
// into the RGB565 framebuffer. Skips when the device-enabled QEMU binary is
// absent (see tests/helpers/dbus-qemu.ts).
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
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'spi.elf');

const QEMU_DBUS_BIN = resolveDbusQemuBin();

registerBuiltins();

// The netlist under test: an ST7789 TFT whose CS rides HSPI's hardware CS0
// (routing by the claimed CS index, PRD §6.5) and whose DC line is wired to
// GPIO2 (the pin spi.elf toggles around each frame; the st7789 model samples
// it to split command from data streams).
const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    { instanceId: 'tft1', kind: 'st7789', props: { cs: 0, dc: 2 } },
  ],
  wires: [
    { id: 'w-dc', from: { instanceId: 'tft1', pin: 'DC' }, to: { instanceId: 'mcu', pin: 'GPIO2' } },
  ],
};

const W = 240;
const H = 240;
/** spi.elf streams 4 pixels after the init: red, green, blue, white. */
const EXPECTED_LEADING_PIXELS = [0xf800, 0x07e0, 0x001f, 0xffff];

interface PixelsPayload {
  width: number;
  height: number;
  format: 'rgb565';
  buffer: number[];
}

function pixelsOf(s: RenderSnapshot): PixelsPayload {
  if (s.type !== 'pixels' || !('width' in s.payload)) {
    throw new Error(`expected pixels snapshot, got ${JSON.stringify(s)}`);
  }
  return s.payload as PixelsPayload;
}

describe.skipIf(QEMU_DBUS_BIN === null)('st7789 SPI e2e (P2.1 acceptance, real QEMU-ESP32)', () => {
  it('renders the spi.elf pixel stream on tft1 through CS-routed SPI transactions', async () => {
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

      // The pixel stream is the last SPI frame of the firmware; wait for the
      // final (trailing-edge) snapshot to carry it.
      const t0 = Date.now();
      let last: PixelsPayload | undefined;
      let lastSnap: RenderSnapshot | undefined;
      for (;;) {
        const pixels = snapshots.filter((s) => s.instanceId === 'tft1' && s.type === 'pixels');
        lastSnap = pixels.at(-1);
        last = lastSnap !== undefined ? pixelsOf(lastSnap) : undefined;
        const done = last !== undefined
          && EXPECTED_LEADING_PIXELS.every((v, i) => last!.buffer[i] === v)
          && last.buffer[4] === 0;
        if (done) break;
        if (Date.now() - t0 > 30000) {
          throw new Error(
            `expected tft1 pixels snapshot with [${EXPECTED_LEADING_PIXELS.map((v) => v.toString(16)).join(',')}], `
              + `got ${last ? JSON.stringify(last.buffer.slice(0, 8)) : 'none'}. status=${runner.getStatus()} `
              + `uart=${JSON.stringify(runner.getUartLog())} snapshots=${snapshots.length}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      // The CS0 SPI write stream rendered a full RGB565 frame on tft1.
      expect(lastSnap!.instanceId).toBe('tft1');
      expect(last!.width).toBe(W);
      expect(last!.height).toBe(H);
      expect(last!.format).toBe('rgb565');
      expect(last!.buffer).toHaveLength(W * H);
      // Untouched GRAM stays black; the 4 streamed pixels land in scan order.
      expect(last!.buffer.slice(4).every((v) => v === 0)).toBe(true);

      // Only wired instances produced snapshots (no broadcast leakage).
      expect(new Set(snapshots.map((s) => s.instanceId))).toEqual(new Set(['tft1']));

      // Firmware completion marker on UART0 (independent of the routing path).
      expect(runner.getUartLog()).toContain('SPI OK');
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
      manager.dispose();
    }
  }, 60000);
});
