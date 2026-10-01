// Empty-board onboarding (T2.7): a centered 1-2-3 guide shown while the
// layout has no nodes. pointer-events:none so it never blocks drops, pin
// clicks or panning — it is pure guidance, not a modal.
import { useT } from '../../i18n';

const STEPS = ['canvas.guide.step1', 'canvas.guide.step2', 'canvas.guide.step3'] as const;

export function EmptyGuide() {
  const t = useT();
  return (
    <div
      aria-hidden
      className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none"
    >
      <div className="rounded-lg border border-bb-line bg-white/85 px-8 py-6 shadow-sm backdrop-blur-sm max-w-sm text-center">
        <div className="text-sm font-semibold text-bb-ink mb-4">{t('canvas.guide.title')}</div>
        <ol className="text-left space-y-2.5">
          {STEPS.map((key, i) => (
            <li key={key} className="flex items-start gap-2.5 text-xs text-bb-ink leading-4">
              <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bb-primary text-[10px] font-semibold text-white">
                {i + 1}
              </span>
              {t(key)}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
