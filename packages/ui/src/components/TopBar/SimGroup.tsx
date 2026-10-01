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

/** PRD §F-SIM-2 range 0.1x–10x; > 1x saturates at host wall clock. */
const SPEED_CHOICES = [0.1, 0.25, 0.5, 1, 2, 4, 10];

export function SimGroup() {
  const status = useSimulationStore((s) => s.status);
  const speed = useSimulationStore((s) => s.speed);
  const canUndo = useProjectStore(selectCanUndo);
  const canRedo = useProjectStore(selectCanRedo);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const t = useT();

  const live = status === 'running' || status === 'paused';

  const run = (label: string, fn: () => Promise<unknown>): void => {
    setBusyAction(label);
    fn()
      .catch((err: unknown) =>
        toast.error(t('toast.simFailed', { detail: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusyAction(null));
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
      <Button title={`${t('common.undo')} (Ctrl+Z)`} disabled={!canUndo} onClick={undo}>
        ↩ {t('common.undo')}
      </Button>
      <Button title={`${t('common.redo')} (Ctrl+Y)`} disabled={!canRedo} onClick={redo}>
        ↪ {t('common.redo')}
      </Button>
      <span className="w-px self-stretch bg-bb-line" />
      <Button
        variant="primary"
        busy={busyAction === 'pause'}
        disabled={!live}
        onClick={onTogglePause}
      >
        {status === 'running' ? `⏸ ${t('toolbar.pause')}` : `▶ ${t('toolbar.resume')}`}
      </Button>
      <Button disabled={status === 'idle'} onClick={() => run('reset', () => bridge.sim.reset())}>
        ⟲ {t('toolbar.reset')}
      </Button>
      <label className="flex items-center gap-1 text-xs text-bb-ink">
        {t('toolbar.speed')}
        <select
          className="h-7 rounded border border-bb-line bg-white px-1 text-xs"
          value={speed}
          onChange={(e) => onSpeed(Number(e.target.value))}
        >
          {SPEED_CHOICES.map((f) => (
            <option key={f} value={f}>{f}x</option>
          ))}
        </select>
      </label>
    </div>
  );
}
