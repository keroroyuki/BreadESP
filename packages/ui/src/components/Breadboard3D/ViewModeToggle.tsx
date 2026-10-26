// Canvas mode switcher (3D step 1): floats over whichever canvas is mounted, so
// the user can compare the same project in 2D and 3D at any time. Both views
// share the project/selection/simulation stores — switching only changes which
// renderer draws them.
import { useT } from '../../i18n';
import { useViewModeStore, type CanvasMode } from '../../store/viewModeStore';

const MODES: readonly CanvasMode[] = ['2d', '3d'];

export function ViewModeToggle() {
  const mode = useViewModeStore((s) => s.mode);
  const setMode = useViewModeStore((s) => s.setMode);
  const t = useT();
  return (
    <div
      className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-bb-line bg-white/85 p-1 shadow-sm backdrop-blur"
      title={t('canvas.view.mode')}
    >
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          className={
            'h-6 min-w-8 cursor-pointer select-none rounded px-2 text-[11px] ' +
            (mode === m ? 'bg-bb-primary text-white' : 'text-bb-ink hover:bg-slate-100')
          }
        >
          {m === '2d' ? t('canvas.view.mode2d') : t('canvas.view.mode3d')}
        </button>
      ))}
    </div>
  );
}
