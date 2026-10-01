// i18n module: dictionary alignment, interpolation, locale detection,
// persistence round-trips (injectable storage; vitest runs in node env).
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { zh } from '../src/i18n/zh';
import {
  LOCALE_STORAGE_KEY,
  detectLocale,
  format,
  loadLocale,
  saveLocale,
  t,
  type StringStorage,
} from '../src/i18n';

function fakeStorage(initial: Record<string, string> = {}): StringStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('i18n dictionaries', () => {
  it('zh has exactly the same key set as en', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it('every message is non-empty in both locales', () => {
    for (const [k, v] of Object.entries(en)) expect(v.length, `en.${k}`).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(zh)) expect(v.length, `zh.${k}`).toBeGreaterThan(0);
  });
});

describe('format', () => {
  it('replaces known placeholders', () => {
    expect(format('hello {name}, {n} items', { name: 'led', n: 3 })).toBe('hello led, 3 items');
  });
  it('keeps unknown placeholders verbatim', () => {
    expect(format('a {x} b', { y: 1 })).toBe('a {x} b');
  });
  it('returns the template untouched without params', () => {
    expect(format('a {x} b')).toBe('a {x} b');
  });
});

describe('t', () => {
  it('translates in both locales', () => {
    expect(t('en', 'toolbar.save')).toBe('Save');
    expect(t('zh', 'toolbar.save')).toBe('保存');
  });
  it('interpolates params', () => {
    expect(t('zh', 'toast.saveFailed', { detail: 'EACCES' })).toContain('EACCES');
  });
});

describe('detectLocale', () => {
  it('stored value wins over navigator', () => {
    expect(detectLocale('zh-CN', 'en')).toBe('en');
    expect(detectLocale('en-US', 'zh')).toBe('zh');
  });
  it('navigator zh* prefixes map to zh', () => {
    expect(detectLocale('zh-CN', null)).toBe('zh');
    expect(detectLocale('zh-TW', null)).toBe('zh');
    expect(detectLocale('ZH', null)).toBe('zh');
  });
  it('falls back to en for non-zh navigators and garbage stored values', () => {
    expect(detectLocale('en-US', null)).toBe('en');
    expect(detectLocale('fr-FR', null)).toBe('en');
    expect(detectLocale('zh-CN', 'garbage')).toBe('zh');
    expect(detectLocale(undefined, null)).toBe('en');
  });
});

describe('persistence', () => {
  it('saves and loads round-trip', () => {
    const s = fakeStorage();
    saveLocale(s, 'zh');
    expect(s.data.get(LOCALE_STORAGE_KEY)).toBe('zh');
    expect(loadLocale(s, 'en-US')).toBe('zh');
  });
  it('load falls back to detection when nothing stored', () => {
    expect(loadLocale(fakeStorage(), 'zh-CN')).toBe('zh');
    expect(loadLocale(fakeStorage(), 'en-US')).toBe('en');
  });
  it('a throwing getItem is treated as nothing stored', () => {
    const broken: StringStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
    };
    expect(loadLocale(broken, 'zh-CN')).toBe('zh');
  });
  it('a throwing setItem does not throw', () => {
    const broken: StringStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveLocale(broken, 'zh')).not.toThrow();
  });
});
