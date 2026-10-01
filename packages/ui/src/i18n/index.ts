// Lightweight i18n: flat key dictionaries + a zustand store, zero runtime deps.
// - `t(locale, key, params)` is pure (unit-testable): `{x}` placeholders are
//   replaced with params; unknown placeholders are left verbatim.
// - `useT()` returns a component-bound translator that re-renders on locale
//   change; `tNow()` reads the current locale for non-React callers (stores,
//   toast helpers).
// - Persistence goes through injectable storage (localStorage in the app,
//   fakes in tests) so the module stays testable under vitest's node env.
import { create } from 'zustand';
import { en } from './en';
import { zh } from './zh';
import type { MessageKey } from './en';

export type Locale = 'en' | 'zh';
export type { MessageKey };

const DICTS: Record<Locale, Record<MessageKey, string>> = { en, zh };

/** Minimal storage contract (subset of localStorage) for DI in tests. */
export interface StringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LOCALE_STORAGE_KEY = 'breadesp.locale';

/** Interpolate `{x}` placeholders; missing params keep the placeholder. */
export function format(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

/** Pure translate. */
export function t(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  const dict = DICTS[locale] ?? DICTS.en;
  return format(dict[key] ?? en[key], params);
}

/**
 * Locale preference: stored value wins, else the navigator language when it
 * starts with `zh` (zh-CN/zh-TW/…), else English. `nav` is injectable for tests.
 */
export function detectLocale(nav: string | undefined, stored: string | null): Locale {
  if (stored === 'zh' || stored === 'en') return stored;
  return nav?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Read the persisted locale from `storage`; corrupted values fall back. */
export function loadLocale(storage: StringStorage, nav: string | undefined): Locale {
  let stored: string | null = null;
  try {
    stored = storage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return detectLocale(nav, stored);
}

/** Persist the locale; a throwing storage (quota/private mode) must not break the app. */
export function saveLocale(storage: StringStorage, locale: Locale): void {
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore
  }
}

interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/** The navigator/storage bindings live here (not in the pure helpers) so app
 *  code never touches them directly and tests inject their own. */
const navigatorLanguage = (): string | undefined =>
  typeof navigator === 'undefined' ? undefined : navigator.language;

const domStorage = (): StringStorage | undefined => {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
};

/** T5.1: keep <html lang> in sync for accessibility/tooling; a DOM-less
 *  environment (node tests) simply skips it. */
const syncDocumentLang = (locale: Locale): void => {
  try {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  } catch {
    // ignore
  }
};

export const useI18nStore = create<I18nState>((set) => ({
  locale: (() => {
    const initial = loadLocale(domStorage() ?? { getItem: () => null, setItem: () => {} }, navigatorLanguage());
    syncDocumentLang(initial);
    return initial;
  })(),
  setLocale: (locale) => {
    set({ locale });
    syncDocumentLang(locale);
    const s = domStorage();
    if (s) saveLocale(s, locale);
  },
}));

/** Component hook: re-renders on locale change. */
export function useT(): (key: MessageKey, params?: Record<string, string | number>) => string {
  const locale = useI18nStore((s) => s.locale);
  return (key, params) => t(locale, key, params);
}

/** Non-React translate (stores, toast pushers) — reads the current locale. */
export function tNow(key: MessageKey, params?: Record<string, string | number>): string {
  return t(useI18nStore.getState().locale, key, params);
}
