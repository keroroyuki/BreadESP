// PRD: §4, §5 — sim-core public surface.
export { buildQemuArgs } from './args';
export type { QemuArgsInput } from './args';
export { readElfHeader, validateElf, expectedElfMachine, EM_XTENSA, EM_RISCV } from './elf';
export type { ElfHeader, ElfValidationIssue } from './elf';
