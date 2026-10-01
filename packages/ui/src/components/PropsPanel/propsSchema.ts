// T4.2 — property-form schema for the PropsPanel. Built-in kinds with
// meaningful tunables get an explicit schema whose BOUNDS import the model's
// LIMITS constants (single source of truth — the UI never invents a range).
// Every other kind — third-party included — degrades to a generic editor
// derived from getFactory(kind).defaults ∪ the instance's own props, so any
// registered kind is editable with zero per-kind UI code (PRD §F-EXT-1).
import {
  KNOB_LIMITS,
  MIC_LIMITS,
  SHT30_LIMITS,
  getFactory,
  registerBuiltins,
} from '@breadesp/peripherals';

export interface NumberField {
  type: 'number';
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Integer-only input (e.g. an I2C address). */
  integer: boolean;
}

export interface SelectField {
  type: 'select';
  key: string;
  label: string;
  choices: readonly { value: string; label: string }[];
}

export interface StringField {
  type: 'string';
  key: string;
  label: string;
}

export type PropField = NumberField | SelectField | StringField;

/** One rendered row: the field descriptor plus the instance's current value. */
export type PropFieldView = PropField & {
  /** Value from the instance (undefined = not set; the form shows the fallback). */
  value: unknown;
  /** Factory default for the key when the instance omits it. */
  fallback: unknown;
};

interface KindSchema {
  fields: readonly PropField[];
}

// Explicit schemas. Bounds come from the peripherals LIMITS constants; the
// `fallback` shown in the form is the model's documented default (display
// hint only — validation stays with the model's config parser).
const SCHEMAS: Record<string, KindSchema> = {
  sht30: {
    fields: [
      {
        type: 'number', key: 'temperatureC', label: 'temperature (°C)', integer: false,
        min: SHT30_LIMITS.temperatureC.min, max: SHT30_LIMITS.temperatureC.max, step: 0.5,
      },
      {
        type: 'number', key: 'humidityRh', label: 'humidity (%RH)', integer: false,
        min: SHT30_LIMITS.humidityRh.min, max: SHT30_LIMITS.humidityRh.max, step: 1,
      },
      {
        type: 'number', key: 'address', label: 'I2C address', integer: true,
        min: SHT30_LIMITS.address.min, max: SHT30_LIMITS.address.max, step: 1,
      },
    ],
  },
  mic: {
    fields: [
      {
        type: 'select', key: 'waveform', label: 'waveform',
        choices: MIC_LIMITS.waveforms.map((w) => ({ value: w, label: w })),
      },
      {
        type: 'number', key: 'freqHz', label: 'frequency (Hz)', integer: false,
        min: MIC_LIMITS.freqHz.min, max: MIC_LIMITS.freqHz.max, step: 1,
      },
      {
        type: 'number', key: 'amplitude', label: 'amplitude', integer: false,
        min: MIC_LIMITS.amplitude.min, max: MIC_LIMITS.amplitude.max, step: 0.05,
      },
      {
        type: 'number', key: 'sampleRate', label: 'sample rate (Hz)', integer: false,
        min: MIC_LIMITS.sampleRate.min, max: MIC_LIMITS.sampleRate.max, step: 1000,
      },
      {
        type: 'number', key: 'chunkMs', label: 'chunk (ms)', integer: false,
        min: MIC_LIMITS.chunkMs.min, max: MIC_LIMITS.chunkMs.max, step: 5,
      },
      {
        type: 'number', key: 'bus', label: 'I2S bus', integer: true,
        min: Math.min(...MIC_LIMITS.bus), max: Math.max(...MIC_LIMITS.bus), step: 1,
      },
    ],
  },
  oscilloscope: {
    fields: [
      // The scope model only validates "positive"; these bounds keep the UI
      // form sane (a 10ms–10s window, at most 10k edges per channel).
      { type: 'number', key: 'windowMs', label: 'window (ms)', integer: false, min: 10, max: 10000, step: 10 },
      { type: 'number', key: 'maxEdges', label: 'max edges', integer: true, min: 10, max: 10000, step: 10 },
    ],
  },
  knob: {
    fields: [
      {
        type: 'number', key: 'stepMs', label: 'step (ms)', integer: false,
        min: KNOB_LIMITS.stepMs.min, max: KNOB_LIMITS.stepMs.max, step: 1,
      },
    ],
  },
};

/** Clamp a number field to its schema bounds (integers round first). */
export function clampNumberField(field: NumberField, raw: number): number {
  const v = field.integer ? Math.round(raw) : raw;
  return Math.min(field.max, Math.max(field.min, v));
}

/** Generic field descriptor inferred from a single value's typeof. */
function fieldFromValue(key: string, v: unknown): PropField {
  if (typeof v === 'boolean') {
    return {
      type: 'select', key, label: key,
      choices: [{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }],
    };
  }
  if (typeof v === 'number') {
    return {
      type: 'number', key, label: key, integer: Number.isInteger(v),
      // Generic fields carry no model bounds — free numeric input.
      min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY, step: 1,
    };
  }
  return { type: 'string', key, label: key };
}

/**
 * The form model for one instance. Explicit schema kinds render their schema
 * (values merged over factory defaults); everything else derives generic
 * fields over defaults ∪ instance props — defaults first (factory order),
 * then instance-only keys (sorted) so the list is stable across renders.
 */
export function fieldsForInstance(
  kind: string,
  props?: Record<string, unknown>,
): readonly PropFieldView[] {
  registerBuiltins();
  const factory = getFactory(kind);
  const defaults = factory?.defaults ?? {};
  const merged: Record<string, unknown> = { ...defaults, ...(props ?? {}) };
  const explicit = SCHEMAS[kind];
  if (explicit !== undefined) {
    return explicit.fields.map((f) => ({ ...f, value: merged[f.key], fallback: defaults[f.key] }));
  }
  const extraKeys = Object.keys(props ?? {})
    .filter((k) => !(k in defaults))
    .sort();
  const keys = [...Object.keys(defaults), ...extraKeys];
  return keys.map((key) => ({
    ...fieldFromValue(key, merged[key]),
    value: merged[key],
    fallback: defaults[key],
  }));
}
