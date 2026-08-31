// PRD: §4.2 — QEMU command line construction (boot path, control channels, sandbox).
import { describe, expect, it } from 'vitest';
import { buildQemuArgs } from '../src/args.js';

const BASE = {
  qemuBin: '/opt/qemu/qemu-system-xtensa',
  firmwareElf: '/fixtures/blink.elf',
  chip: 'esp32',
} as const;

describe('buildQemuArgs', () => {
  it('boots the firmware ELF via -kernel (no flash drive)', () => {
    const argv = buildQemuArgs(BASE);
    expect(argv).toContain('-kernel');
    const ki = argv.indexOf('-kernel');
    expect(argv[ki + 1]).toBe('/fixtures/blink.elf');
    expect(argv.some((a) => a.startsWith('file='))).toBe(false);
    expect(argv).not.toContain('-drive');
  });

  it('maps chip to machine type', () => {
    expect(buildQemuArgs({ ...BASE, chip: 'esp32' })).toContain('esp32');
    expect(buildQemuArgs({ ...BASE, chip: 'esp32s3' })).toContain('esp32s3');
    expect(buildQemuArgs({ ...BASE, chip: 'esp32c3' })).toContain('esp32c3');
  });

  it('exposes UART0 on stdio and disables networking by default', () => {
    const argv = buildQemuArgs(BASE);
    expect(argv).toEqual(expect.arrayContaining(['-serial', 'stdio', '-nographic', '-nic', 'none']));
  });

  it('keeps networking when noNetwork is explicitly false', () => {
    const argv = buildQemuArgs({ ...BASE, noNetwork: false });
    expect(argv).not.toContain('-nic');
  });

  it('freezes the VM at reset (-S) so load() runs no guest code', () => {
    const argv = buildQemuArgs(BASE);
    expect(argv).toContain('-S');
  });

  it('adds GDB stub and QMP listeners when ports are given', () => {
    const argv = buildQemuArgs({ ...BASE, gdbPort: 1234, qmpPort: 4321 });
    // Stub binds loopback only (PRD §9 sandbox).
    expect(argv).toEqual(expect.arrayContaining(['-gdb', 'tcp:127.0.0.1:1234']));
    expect(argv).toEqual(
      expect.arrayContaining(['-qmp', 'tcp:127.0.0.1:4321,server=on,wait=off']),
    );
  });

  it('omits GDB/QMP/dbus flags when ports/sockets are not given', () => {
    const argv = buildQemuArgs(BASE);
    expect(argv).not.toContain('-gdb');
    expect(argv).not.toContain('-qmp');
    expect(argv).not.toContain('-device');
  });

  it('adds the breadesp-dbus device on a unix socket (POSIX hosts)', () => {
    const argv = buildQemuArgs({ ...BASE, dbus: { socket: '/tmp/breadesp-dbus.sock' } });
    expect(argv).toEqual(expect.arrayContaining(['-device', 'breadesp-dbus,socket=/tmp/breadesp-dbus.sock']));
  });

  it('adds the breadesp-dbus device on TCP loopback (Windows hosts)', () => {
    const argv = buildQemuArgs({ ...BASE, dbus: { port: 5555 } });
    expect(argv).toEqual(
      expect.arrayContaining(['-device', 'breadesp-dbus,host=127.0.0.1,port=5555']),
    );
    const explicit = buildQemuArgs({ ...BASE, dbus: { host: '127.0.0.1', port: 5556 } });
    expect(explicit).toEqual(
      expect.arrayContaining(['-device', 'breadesp-dbus,host=127.0.0.1,port=5556']),
    );
  });

  it('rejects dbus channels that are neither socket nor port, or both', () => {
    expect(() => buildQemuArgs({ ...BASE, dbus: {} })).toThrow(/either socket or port/);
    expect(() => buildQemuArgs({ ...BASE, dbus: { socket: '/tmp/x.sock', port: 1 } })).toThrow(/not both/);
  });
});
