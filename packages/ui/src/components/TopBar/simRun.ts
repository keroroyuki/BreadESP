// PRD: §F-SIM-1, §6.6 — the Run flow's decision logic (packaging P6.1).
// Load boots a fresh VM from the project's imported firmware.elf, then start
// resumes it; the Bridge resolves the QEMU binary and DBus channel itself.
import type { ChipKind } from '@breadesp/netlist';
import type { SimStatus } from '../../store/simulationStore';

/** Minimal sim-bridge surface the run flow needs (subset of BridgeApi['sim']). */
export interface SimRunner {
  load: (p: { elfPath: string; chip: ChipKind }) => Promise<unknown>;
  start: () => Promise<unknown>;
}

/** Run owns the non-live states; pause/resume owns loaded/running/paused. */
export function canRunSimulation(status: SimStatus): boolean {
  return status === 'idle' || status === 'stopped' || status === 'error';
}

/** Load the project firmware into a fresh VM, then resume it. */
export async function runSimulation(sim: SimRunner, input: { elfPath: string; chip: ChipKind }): Promise<void> {
  await sim.load({ elfPath: input.elfPath, chip: input.chip });
  await sim.start();
}
