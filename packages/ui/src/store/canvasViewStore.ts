// Canvas viewport state (T2.1): zoom/pan shared by the Konva Stage and the
// floating zoom controls. Mutations go through the pure canvasView helpers.
import { create } from 'zustand';
import {
  IDENTITY_VIEW,
  zoomAtPoint,
  type Pt,
  type View,
} from '../components/Breadboard/canvasView';

interface CanvasViewState {
  view: View;
  /** Zoom by `factor` keeping the world point under `pointer` fixed. */
  zoomAt: (pointer: Pt, factor: number) => void;
  /** Pan by container-pixel deltas (drag gestures). */
  panBy: (dx: number, dy: number) => void;
  reset: () => void;
}

export const useCanvasViewStore = create<CanvasViewState>((set) => ({
  view: IDENTITY_VIEW,
  zoomAt: (pointer, factor) =>
    set((s) => ({ view: zoomAtPoint(s.view, pointer, factor) })),
  panBy: (dx, dy) =>
    set((s) => ({ view: { ...s.view, x: s.view.x + dx, y: s.view.y + dy } })),
  reset: () => set({ view: IDENTITY_VIEW }),
}));
