// PRD: §4, §5 — Construct the QEMU-ESP32 command line for a given firmware + netlist.
// AI Agent: the binary is a per-family system emulator from espressif/qemu, resolved at
// runtime, never checked into the repo (PRD §10.6). Xtensa chips (esp32/s3) run
// qemu-system-xtensa; RISC-V chips (c3/c6) run qemu-system-riscv32 — see
// qemuSystemForChip(). The caller passes the matching binary via `qemuBin`.
import type { ChipKind } from '@breadesp/netlist';

/** DBus forward channel (PRD §4.2): the custom device connects out to the Bridge. */
export interface QemuDbusChannel {
  /** TCP loopback host (device property `host`, default 127.0.0.1 in the device). */
  host?: string;
  /** TCP port (device property `port`). */
  port?: number;
  /** Unix domain socket path (device property `socket`) — POSIX hosts only. */
  socket?: string;
}

export interface QemuArgsInput {
  qemuBin: string;          // absolute path to qemu-system-xtensa
  firmwareElf: string;      // .elf path (symbol-bearing, required for debug)
  chip: ChipKind;
  /** GDB stub port to expose (e.g. 1234). */
  gdbPort?: number;
  /** QMP control channel (TCP on loopback) so the Bridge can start/pause the VM. */
  qmpPort?: number;
  /**
   * DBus forward channel (custom device -> Bridge, PRD §6.7). Either a TCP
   * host/port pair (works on Windows where AF_UNIX is unavailable to Node) or
   * a unix socket path. Exactly one form.
   */
  dbus?: QemuDbusChannel;
  /** Disable all networking (PRD §9 sandbox). */
  noNetwork?: boolean;
}

/** Build the argv array. */
export function buildQemuArgs(input: QemuArgsInput): string[] {
  const machine = chipToMachine(input.chip);
  const argv: string[] = [
    input.qemuBin,
    '-machine', machine,
    // espressif/qemu boots the ELF directly via -kernel: segments are loaded into
    // memory and execution starts at the ELF entry. (-drive if=mtdblock is NOT
    // supported by this build; if=mtd requires padded 2/4/8/16 MB flash images.)
    '-kernel', input.firmwareElf,
    '-serial', 'stdio',                 // UART0 -> stdout (PRD §F-SER-1)
    '-nographic',
    // Freeze at reset: execution gates on QMP `cont` (QemuRunner.start()) or a
    // GDB `continue` once the stub client attached — otherwise the guest runs to
    // app_main before any debugger can arm breakpoints (PRD §F-SIM-1, F-DBG-1).
    '-S',
  ];

  // Loopback only: the stub must not be reachable from other hosts (PRD §9 sandbox).
  if (input.gdbPort) argv.push('-gdb', `tcp:127.0.0.1:${input.gdbPort}`);
  // QMP listens on TCP loopback (Node cannot reach AF_UNIX sockets on Windows).
  if (input.qmpPort) argv.push('-qmp', `tcp:127.0.0.1:${input.qmpPort},server=on,wait=off`);
  if (input.noNetwork !== false) argv.push('-nic', 'none');   // PRD §9
  // DBus forward device (PRD §4.2, dev-plan task P1.2): the breadesp-dbus QEMU
  // device serializes bus transactions (PRD §6.7) to this channel. TCP for
  // Windows hosts, unix socket on POSIX.
  if (input.dbus) {
    const { host, port, socket } = input.dbus;
    if (socket !== undefined && port !== undefined) {
      throw new Error('dbus channel: pass either socket (unix) or host+port (TCP), not both');
    }
    if (socket !== undefined) {
      argv.push('-device', `breadesp-dbus,socket=${socket}`);
    } else if (port !== undefined) {
      argv.push('-device', `breadesp-dbus,host=${host ?? '127.0.0.1'},port=${port}`);
    } else {
      throw new Error('dbus channel requires either socket or port');
    }
  }

  return argv;
}

/** QEMU system emulator that runs a chip family (PRD §5: espressif/qemu). */
export type QemuSystem = 'qemu-system-xtensa' | 'qemu-system-riscv32';

/** Machine name of each chip on its emulator (verified against espressif/qemu -machine help). */
function chipToMachine(chip: ChipKind): string {
  switch (chip) {
    case 'esp32': return 'esp32';
    case 'esp32s3': return 'esp32s3';
    case 'esp32c3': return 'esp32c3';
    case 'esp32c6': return 'esp32c6';
  }
}

/**
 * System emulator binary name for a chip (dev-plan task P4.1): esp32/s3 are
 * Xtensa LX6/LX7 and live in qemu-system-xtensa; esp32c3/esp32c6 are RISC-V
 * and live in qemu-system-riscv32. Passing the wrong-family binary fails in
 * QEMU with "machine ... not found" — resolve the binary by this mapping.
 */
export function qemuSystemForChip(chip: ChipKind): QemuSystem {
  switch (chip) {
    case 'esp32':
    case 'esp32s3':
      return 'qemu-system-xtensa';
    case 'esp32c3':
    case 'esp32c6':
      return 'qemu-system-riscv32';
  }
}
