// PRD: §F-BB-2, §F-EXT-1 — Visual identity table. These assertions protect the
// two properties the palette/canvas/3D labels rely on: every built-in kind has a
// distinct-enough identity, and an unknown (third-party) kind still renders.
import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import {
  CATEGORY_ACCENT,
  CATEGORY_LABEL_KEY,
  CATEGORY_ORDER,
  PART_COPY,
  PART_ICON_PATHS,
  partVisual,
} from '../src/components/parts/partVisuals';

const BUILTIN_KINDS = [
  'led',
  'button',
  'buzzer',
  'speaker',
  'mic',
  'knob',
  'sht30',
  'ssd1306',
  'st7789',
  'oscilloscope',
];

describe('partVisual', () => {
  it('gives every built-in kind a category and a glyph', () => {
    for (const kind of BUILTIN_KINDS) {
      const visual = partVisual(kind);
      expect(visual.category).not.toBe('other');
      expect(visual.icon.length).toBeGreaterThan(10);
    }
  });

  it('assigns built-in icons from the glyph library', () => {
    for (const kind of BUILTIN_KINDS) {
      const known = Object.values(PART_ICON_PATHS) as string[];
      expect(known).toContain(partVisual(kind).icon);
    }
  });

  it('falls back to the generic chip for unknown kinds', () => {
    const visual = partVisual('acme-servo');
    expect(visual.category).toBe('other');
    expect(visual.icon).toBe(PART_ICON_PATHS.chip);
  });

  it('keeps every category reachable from the palette order', () => {
    for (const kind of BUILTIN_KINDS) {
      expect(CATEGORY_ORDER).toContain(partVisual(kind).category);
    }
    expect(CATEGORY_ORDER).toContain('other');
  });

  it('gives every category an accent colour', () => {
    for (const category of CATEGORY_ORDER) {
      expect(CATEGORY_ACCENT[category]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('part copy', () => {
  it('has a name and a role for every built-in kind', () => {
    for (const kind of BUILTIN_KINDS) {
      const copy = PART_COPY[kind];
      expect(copy).toBeDefined();
      if (copy === undefined) continue;
      expect(t('en', copy.name).length).toBeGreaterThan(0);
      expect(t('en', copy.role).length).toBeGreaterThan(0);
      expect(t('zh', copy.name).length).toBeGreaterThan(0);
      expect(t('zh', copy.role).length).toBeGreaterThan(0);
    }
  });

  it('translates every category label in both locales', () => {
    for (const category of CATEGORY_ORDER) {
      const key = CATEGORY_LABEL_KEY[category];
      expect(t('en', key).length).toBeGreaterThan(0);
      expect(t('zh', key).length).toBeGreaterThan(0);
    }
  });

  it('localizes the names (zh differs from en)', () => {
    const led = PART_COPY.led;
    expect(led).toBeDefined();
    if (led === undefined) return;
    expect(t('zh', led.name)).not.toBe(t('en', led.name));
  });
});
