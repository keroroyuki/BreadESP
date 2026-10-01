// Floating canvas zoom controls (T2.2): -/percent/+ and view reset, anchored
// at the container center. Rendered inside the canvas container (absolute).
import { useCanvasViewStore } from '../../store/canvasViewStore';
import { useT } from '../../i18n';

export function CanvasToolbar({ size }: { size: { w: number; h: number } }) {
  const view = useCanvasViewStore((s) => s.view);
  const zoomAt = useCanvasViewStore((s) => s.zoomAt);
  const reset = useCanvasViewStore((s) => s.reset);
  const t = useT();

  const center = { x: size.w / 2, y: size.h / 2 };
  const zoom = (factor: number): void => zoomAt(center, factor);

  const btn =
    'w-7 h-7 rounded bg-white/90 border border-bb-line text-bb-ink text-xs ' +
    'hover:bg-white active:bg-slate-100 cursor-pointer select-none';
  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border border-bb-line bg-white/80 p-1 shadow-sm backdrop-blur">
      <button type="button" className={btn} title={t('canvas.view.zoomOut')} onClick={() => zoom(1 / 1.25)}>−</button>
      <span className="w-11 text-center text-[11px] text-bb-ink tabular-nums select-none">
        {Math.round(view.scale * 100)}%
      </span>
      <button type="button" className={btn} title={t('canvas.view.zoomIn')} onClick={() => zoom(1.25)}>+</button>
      <button
        type="button"
        className={btn}
        title={t('canvas.view.reset')}
        onClick={reset}
      >
        ⌖
      </button>
    </div>
  );
}
