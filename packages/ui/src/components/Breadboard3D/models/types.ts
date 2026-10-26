// Shared prop contract for 3D part bodies (step 3). Live values come from the
// simulation snapshots; the model decides which of them it can express.
import type { Texture } from 'three';

export interface PartModelProps {
  /** Instance this body belongs to — screen models read their own snapshots. */
  instanceId: string;
  /** Header pin count declared by the factory (models draw exactly this many). */
  pins: number;
  /** 0..1 drive level: LED brightness, buzzer duty, speaker activity. */
  level: number;
  /** Live framebuffer texture for screen models (null when not a screen). */
  screen: Texture | null;
}
