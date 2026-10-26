// 3D view: kind -> model component. Typed as Record<ModelKey, …> so a catalogue
// entry without a component is a typecheck error rather than an invisible part.
import type { ComponentType } from 'react';
import { modelKeyFor, type ModelKey } from './modelCatalog';
import { ButtonModel } from './models/ButtonModel';
import { BuzzerModel } from './models/BuzzerModel';
import { GenericPartModel } from './models/GenericPartModel';
import { KnobModel } from './models/KnobModel';
import { LedModel } from './models/LedModel';
import { MicModel } from './models/MicModel';
import { OledModel } from './models/OledModel';
import { ScopeModel } from './models/ScopeModel';
import { Sht30Model } from './models/Sht30Model';
import { SpeakerModel } from './models/SpeakerModel';
import { TftModel } from './models/TftModel';
import type { PartModelProps } from './models/types';

/** A part body: geometry plus whatever live state it can express. */
export type PartModelComponent = ComponentType<PartModelProps>;

export const MODEL_COMPONENTS: Record<ModelKey, PartModelComponent> = {
  led: LedModel,
  button: ButtonModel,
  buzzer: BuzzerModel,
  speaker: SpeakerModel,
  ssd1306: OledModel,
  st7789: TftModel,
  oscilloscope: ScopeModel,
  mic: MicModel,
  knob: KnobModel,
  sht30: Sht30Model,
  generic: GenericPartModel,
};

/** Model body for a peripheral kind (generic fallback for unmodelled kinds). */
export function partModelFor(kind: string): PartModelComponent {
  return MODEL_COMPONENTS[modelKeyFor(kind)];
}
