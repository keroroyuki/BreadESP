// PRD: §4, §5 — sim-core public surface.
export { buildQemuArgs, qemuSystemForChip } from './args';
export type { QemuArgsInput, QemuDbusChannel, QemuSystem } from './args';
export { readElfHeader, validateElf, expectedElfMachine, EM_XTENSA, EM_RISCV } from './elf';
export type { ElfHeader, ElfValidationIssue } from './elf';
