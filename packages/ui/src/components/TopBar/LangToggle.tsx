// T3.4 — locale toggle. setLocale updates the i18n store (every useT
// component re-renders immediately) and persists via the i18n module's
// storage binding, so the choice survives an Electron restart.
import { useI18nStore, type Locale } from '../../i18n';

const CHOICES: { locale: Locale; label: string }[] = [
  { locale: 'en', label: 'EN' },
  { locale: 'zh', label: '中文' },
];

export function LangToggle() {
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);
  return (
    <div
      role="group"
      aria-label="language"
      className="inline-flex h-7 overflow-hidden rounded border border-bb-line bg-white text-xs"
    >
      {CHOICES.map((c) => (
        <button
          key={c.locale}
          type="button"
          onClick={() => setLocale(c.locale)}
          aria-pressed={locale === c.locale}
          className={`px-2 cursor-pointer ${
            locale === c.locale
              ? 'bg-bb-primary text-white'
              : 'bg-white text-bb-ink hover:bg-slate-50'
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
