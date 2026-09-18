// PRD: §F-DBG-5 — esp-gdb Xtensa register-layout selection (found during P4.5).
// esp-gdb 17.x ships one register-layout config per Xtensa chip as a shared
// library, but its BUILT-IN default does not match espressif QEMU's esp32 /
// esp32s3 gdb stubs — `-target-select` then dies with "Remote 'g' packet
// reply is too long (expected 388 bytes, got 628 bytes)". Setting
// XTENSA_GNU_CONFIG to the chip's config library (installed next to the GDB
// binary as ../lib/xtensa_<chip>.so) selects the matching layout. RISC-V
// chips have no Xtensa layout, installations without the library keep the
// plain environment, and a user-set XTENSA_GNU_CONFIG always wins.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChipKind } from '@breadesp/netlist';

/** Environment additions selecting the chip's Xtensa dynconfig, or undefined. */
export function resolveDynconfigEnv(gdbBin: string, chip: ChipKind): Record<string, string | undefined> | undefined {
  if (chip !== 'esp32' && chip !== 'esp32s3') return undefined;
  if (process.env.XTENSA_GNU_CONFIG !== undefined) return undefined;
  if (gdbBin === '') return undefined;
  const candidate = join(dirname(gdbBin), '..', 'lib', `xtensa_${chip}.so`);
  if (!existsSync(candidate)) return undefined;
  return { XTENSA_GNU_CONFIG: candidate };
}
