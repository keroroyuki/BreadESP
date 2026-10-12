// PRD: §F-SIM-1, §6.6 — run-flow decision logic tests (packaging P6.1).
import { describe, expect, it, vi } from 'vitest';
import { canRunSimulation, runSimulation, type SimRunner } from '../src/components/TopBar/simRun';

describe('canRunSimulation (P6.1)', () => {
  it('owns exactly the non-live states', () => {
    expect(canRunSimulation('idle')).toBe(true);
    expect(canRunSimulation('stopped')).toBe(true);
    expect(canRunSimulation('error')).toBe(true);
    expect(canRunSimulation('loaded')).toBe(false);
    expect(canRunSimulation('running')).toBe(false);
    expect(canRunSimulation('paused')).toBe(false);
  });
});

describe('runSimulation (P6.1)', () => {
  it('loads the project firmware, then starts the VM (in that order)', async () => {
    const calls: string[] = [];
    const sim: SimRunner = {
      load: vi.fn(async () => { calls.push('load'); }),
      start: vi.fn(async () => { calls.push('start'); }),
    };
    await runSimulation(sim, { elfPath: '/p/proj/firmware.elf', chip: 'esp32s3' });
    expect(calls).toEqual(['load', 'start']);
    expect(sim.load).toHaveBeenCalledWith({ elfPath: '/p/proj/firmware.elf', chip: 'esp32s3' });
  });

  it('never starts when the load rejects (firmware gate, QEMU resolution)', async () => {
    const sim: SimRunner = {
      load: vi.fn(async () => { throw new Error('[BB-101] wrong arch'); }),
      start: vi.fn(async () => {}),
    };
    await expect(runSimulation(sim, { elfPath: '/p/x.elf', chip: 'esp32' })).rejects.toThrow('[BB-101]');
    expect(sim.start).not.toHaveBeenCalled();
  });
});
