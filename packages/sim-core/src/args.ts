// PRD: §4, §5 — Construct the QEMU-ESP32 command line for a given firmware + netlist.
// AI Agent: this runs qemu-system-xtensa (espressif/qemu). Binary path resolved at runtime,
// never checked into the repo (PRD §10.6).
import type { ChipKind } from '@breadesp/netlist';

export interface QemuArgsInput {
  qemuBin: string;          // absolute path to qemu-system-xtensa
  firmwareElf: string;      // .elf path (symbol-bearing, required for debug)
  chip: ChipKind;
  /** GDB stub port to expose (e.g. 1234). */
  gdbPort?: number;
  /** QMP control channel (TCP on loopback) so the Bridge can start/pause the VM. */
  qmpPort?: number;
  /** DBus forward socket path (custom device -> Bridge). */
  dbusSocket?: string;
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
  ];

  if (input.gdbPort) argv.push('-gdb', `tcp::${input.gdbPort}`);
  // QMP listens on TCP loopback (Node cannot reach AF_UNIX sockets on Windows).
  if (input.qmpPort) argv.push('-qmp', `tcp:127.0.0.1:${input.qmpPort},server=on,wait=off`);
  if (input.noNetwork !== false) argv.push('-nic', 'none');   // PRD §9
  // DBus forward device: custom QEMU device that pipes bus traffic to a unix socket.
  // TODO(PRD §4.2): implement the device in packages/sim-core device source (C).
  if (input.dbusSocket) argv.push('-device', `breadesp-dbus,socket=${input.dbusSocket}`);

  return argv;
}

function chipToMachine(chip: ChipKind): string {
  switch (chip) {
    case 'esp32': return 'esp32';
    case 'esp32s3': return 'esp32s3';
    case 'esp32c3': return 'esp32c3';
  }
}
