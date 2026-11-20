// PRD: §F-BB-2, §F-EXT-1 — One visual identity per peripheral kind, shared by
// the palette, the 2D canvas nodes and the 3D nameplates. Recognition is the
// point: a beginner should be able to tell an LED from a buzzer by silhouette
// and colour before reading a word.
//
// Third-party kinds are not enumerable, so every lookup has a neutral fallback
// (category `other`, generic chip glyph): a plugin still renders, it just does
// not claim a built-in identity.
import type { MessageKey } from '../../i18n';

export type PartCategory = 'input' | 'output' | 'display' | 'sensor' | 'instrument' | 'other';

export interface PartVisual {
  category: PartCategory;
  /** Stroke-only SVG path data on a 24×24 grid. */
  icon: string;
}

/** Display order of the palette groups. */
export const CATEGORY_ORDER: readonly PartCategory[] = [
  'input',
  'output',
  'display',
  'sensor',
  'instrument',
  'other',
];

/** Category accents — hue carries the signal family, not decoration. */
export const CATEGORY_ACCENT: Record<PartCategory, string> = {
  input: '#0d9488',
  output: '#d97706',
  display: '#6366f1',
  sensor: '#059669',
  instrument: '#475569',
  other: '#94a3b8',
};

/** Tinted background for icon tiles (10–14% of the accent). */
export const CATEGORY_TINT: Record<PartCategory, string> = {
  input: '#e6fffb',
  output: '#fff7e6',
  display: '#eef0ff',
  sensor: '#e8f9f1',
  instrument: '#eef2f7',
  other: '#f1f5f9',
};

export const CATEGORY_LABEL_KEY: Record<PartCategory, MessageKey> = {
  input: 'part.category.input',
  output: 'part.category.output',
  display: 'part.category.display',
  sensor: 'part.category.sensor',
  instrument: 'part.category.instrument',
  other: 'part.category.other',
};

/** Glyph library. One `d` per icon keeps the React and Konva renderers in sync. */
const ICON = {
  led: 'M12 5a5 5 0 0 1 5 5c0 1.9-1 3-2 4v2H9v-2c-1-1-2-2.1-2-4a5 5 0 0 1 5-5ZM9 19h6M10.5 21.5h3',
  button: 'M5 8h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2ZM12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  buzzer: 'M12 4a5 5 0 0 1 5 5v5H7V9a5 5 0 0 1 5-5ZM7 17h10M9.5 20h5',
  speaker: 'M4 10h3l4-3v10l-4-3H4ZM15.5 9.5a4 4 0 0 1 0 5M18 7a8 8 0 0 1 0 10',
  mic: 'M12 4a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3ZM6 11a6 6 0 0 0 12 0M12 17v3',
  knob: 'M12 4a8 8 0 1 1 0 16a8 8 0 0 1 0-16ZM12 8v4.5M12 4v1.5M20 12h-1.5M5.5 12H4',
  sht30: 'M7 7h10v10H7ZM4 9.5h3M4 12h3M4 14.5h3M17 9.5h3M17 12h3M17 14.5h3M12 10v3M12 15.2v.01',
  oled: 'M3 8h18v8H3ZM6 11h7M6 13h4',
  tft: 'M4 5h16v14H4ZM7 8h10v8H7Z',
  scope: 'M3 7h18v10H3ZM6 12.5l2.5-3L11 13l3-4 4 3.5',
  chip: 'M8 8h8v8H8ZM4 9.5h4M4 12h4M4 14.5h4M16 9.5h4M16 12h4M16 14.5h4',
} as const;

export type PartIconKey = keyof typeof ICON;

export const PART_ICON_PATHS: Record<PartIconKey, string> = ICON;

const VISUALS: Record<string, { category: PartCategory; icon: PartIconKey }> = {
  led: { category: 'output', icon: 'led' },
  buzzer: { category: 'output', icon: 'buzzer' },
  speaker: { category: 'output', icon: 'speaker' },
  button: { category: 'input', icon: 'button' },
  knob: { category: 'input', icon: 'knob' },
  mic: { category: 'input', icon: 'mic' },
  ssd1306: { category: 'display', icon: 'oled' },
  st7789: { category: 'display', icon: 'tft' },
  sht30: { category: 'sensor', icon: 'sht30' },
  oscilloscope: { category: 'instrument', icon: 'scope' },
};

const FALLBACK: PartVisual = { category: 'other', icon: ICON.chip };

/** Visual identity for a kind; unknown (third-party) kinds get the generic chip. */
export function partVisual(kind: string): PartVisual {
  const v = VISUALS[kind];
  return v === undefined ? FALLBACK : { category: v.category, icon: ICON[v.icon] };
}

/** Localized name/role keys for a kind; null when the kind has no built-in copy. */
export const PART_COPY: Record<string, { name: MessageKey; role: MessageKey }> = {
  led: { name: 'part.led.name', role: 'part.led.role' },
  buzzer: { name: 'part.buzzer.name', role: 'part.buzzer.role' },
  speaker: { name: 'part.speaker.name', role: 'part.speaker.role' },
  button: { name: 'part.button.name', role: 'part.button.role' },
  knob: { name: 'part.knob.name', role: 'part.knob.role' },
  mic: { name: 'part.mic.name', role: 'part.mic.role' },
  ssd1306: { name: 'part.ssd1306.name', role: 'part.ssd1306.role' },
  st7789: { name: 'part.st7789.name', role: 'part.st7789.role' },
  sht30: { name: 'part.sht30.name', role: 'part.sht30.role' },
  oscilloscope: { name: 'part.oscilloscope.name', role: 'part.oscilloscope.role' },
};
