// Drop preview for palette drags over the 3D board (step 4).
//
// The HTML drag handlers live outside the WebGL canvas while the preview is drawn
// inside it, so the placement travels through this tiny store — same split as the
// 2D canvas, where the ghost is component state next to the Stage.
import { create } from 'zustand';

export interface DropGhost {
  kind: string;
  /** Snapped node origin (layout coordinates, top-left of the node box). */
  x: number;
  y: number;
}

interface DropGhostState {
  ghost: DropGhost | null;
  setGhost: (ghost: DropGhost | null) => void;
}

export const useDropGhostStore = create<DropGhostState>((set) => ({
  ghost: null,
  setGhost: (ghost) => set({ ghost }),
}));
