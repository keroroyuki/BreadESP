// PRD: §4.2 — QEMU command line construction (boot path, control channels, sandbox).
import { describe, expect, it } from 'vitest';
import { buildQemuArgs, qemuSystemForChip } from '../src/args.js';

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

  it('maps every supported chip to its QEMU machine name (dev-plan P4.1)', () => {
    // Assert the exact -machine <name> pair, not a bare substring.
    const machineOf = (chip: string) => {
      const argv = buildQemuArgs({ ...BASE, chip } as typeof BASE);
      return argv[argv.indexOf('-machine') + 1];
    };
    expect(machineOf('esp32')).toBe('esp32');
    expect(machineOf('esp32s3')).toBe('esp32s3');
    expect(machineOf('esp32c3')).toBe('esp32c3');
    expect(machineOf('esp32c6')).toBe('esp32c6');
  });

  it('maps each chip family to its QEMU system emulator', () => {
    // Xtensa chips run qemu-system-xtensa; RISC-V chips need qemu-system-riscv32
    // ("machine not found" on the wrong family — dev-plan P4.1).
    expect(qemuSystemForChip('esp32')).toBe('qemu-system-xtensa');
    expect(qemuSystemForChip('esp32s3')).toBe('qemu-system-xtensa');
    expect(qemuSystemForChip('esp32c3')).toBe('qemu-system-riscv32');
    expect(qemuSystemForChip('esp32c6')).toBe('qemu-system-riscv32');
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
