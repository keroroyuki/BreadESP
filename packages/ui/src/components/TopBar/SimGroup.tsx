// T3.4 — simulation group of the TopBar. Logic migrated verbatim from
// SimControls (T1.4): pause/resume ride QMP stop/cont (QemuRunner), the
// speed selector drives the duty-cycle throttle, errors surface via toast,
// and undo/redo give F-BB-5 a visible entry point (canvas keeps the keys).
import { useState } from 'react';
import { bridge } from '../../ipc/bridge';
import { useSimulationStore } from '../../store/simulationStore';
import { selectCanRedo, selectCanUndo, useProjectStore } from '../../store/projectStore';
import { toast } from '../../store/toastStore';
import { useT } from '../../i18n';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { canRunSimulation, runSimulation } from './simRun';

/** PRD §F-SIM-2 range 0.1x–10x; > 1x saturates at host wall clock. */
const SPEED_CHOICES = [0.1, 0.25, 0.5, 1, 2, 4, 10];

export function SimGroup() {
  const status = useSimulationStore((s) => s.status);
  const speed = useSimulationStore((s) => s.speed);
  const firmwareElf = useProjectStore((s) => s.firmwareElf);
  const chip = useProjectStore((s) => s.netlist.chip);
  const canUndo = useProjectStore(selectCanUndo);
  const canRedo = useProjectStore(selectCanRedo);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const t = useT();

  const live = status === 'running' || status === 'paused';
  // P6.1: Run owns the non-live states (idle/stopped/error) and boots the
  // project's imported firmware.elf into a fresh VM.
  const runnable = canRunSimulation(status);

  const run = (label: string, fn: () => Promise<unknown>): void => {
    setBusyAction(label);
    fn()
      .catch((err: unknown) =>
        toast.error(t('toast.simFailed', { detail: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusyAction(null));
  };

  const onRun = (): void => {
    if (firmwareElf === null) {
      toast.warning(t('toast.needFirmware'));
      return;
    }
    run('run', () => runSimulation(bridge.sim, { elfPath: firmwareElf, chip }));
  };

  const onTogglePause = (): void => {
    run('pause', () => (status === 'running' ? bridge.sim.pause() : bridge.sim.start()));
  };

  const onSpeed = (factor: number): void => {
    // Optimistic mirror: the authoritative value arrives on the sim:speed push.
    useSimulationStore.getState().setSpeed(factor);
    run('speed', () => bridge.sim.setSpeed({ factor }));
  };

  return (
    <div className="flex items-center gap-1.5">
      {/* Icon-only history controls: the bar has to fit the primary Run action
          on a 1080 px window. The tooltip keeps the label discoverable. */}
      <Button
        className="w-7 px-0"
        title={`${t('common.undo')} (Ctrl+Z)`}
        aria-label={t('common.undo')}
        disabled={!canUndo}
        onClick={undo}
      >
        <Icon name="undo" size={14} />
      </Button>
      <Button
        className="w-7 px-0"
        title={`${t('common.redo')} (Ctrl+Y)`}
        aria-label={t('common.redo')}
        disabled={!canRedo}
        onClick={redo}
      >
        <Icon name="redo" size={14} />
      </Button>
      <span className="w-px self-stretch bg-bb-line" />
      {runnable ? (
        <Button
          variant="primary"
          className="h-8 rounded-md px-3 font-semibold shadow-sm"
          busy={busyAction === 'run'}
          title={firmwareElf === null ? t('toast.needFirmware') : (firmwareElf ?? undefined)}
          onClick={onRun}
        >
          <Icon name="play" size={11} /> {t('toolbar.run')}
        </Button>
      ) : (
        <Button
          variant="primary"
          className="h-8 rounded-md px-3 font-semibold shadow-sm"
          busy={busyAction === 'pause'}
          disabled={!live}
          onClick={onTogglePause}
        >
          <Icon name={status === 'running' ? 'pause' : 'play'} size={11} />
          {status === 'running' ? t('toolbar.pause') : t('toolbar.resume')}
        </Button>
      )}
      <Button
        className="w-7 px-0"
        title={t('toolbar.reset')}
        aria-label={t('toolbar.reset')}
        disabled={status === 'idle'}
        onClick={() => run('reset', () => bridge.sim.reset())}
      >
        <Icon name="reset" size={14} />
      </Button>
      <label className="flex items-center gap-1 text-xs text-bb-ink">
        {t('toolbar.speed')}
        <Select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
          {SPEED_CHOICES.map((f) => (
            <option key={f} value={f}>{f}x</option>
          ))}
        </Select>
      </label>
    </div>
  );
}
