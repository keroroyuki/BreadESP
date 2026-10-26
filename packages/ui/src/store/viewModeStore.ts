// Canvas view mode (3D step 1): which canvas the centre column renders — the
// 2D Konva editor or the 3D modelled view. It lives in its own store so neither
// canvas owns the other's state: layout/netlist (projectStore), selection and
// simulation snapshots are shared, so both views always describe the same
// project and switching modes never touches project data.
import { create } from 'zustand';

export type CanvasMode = '2d' | '3d';

interface ViewModeState {
  mode: CanvasMode;
  setMode: (mode: CanvasMode) => void;
  toggle: () => void;
}

export const useViewModeStore = create<ViewModeState>((set) => ({
  // 3D is the default while the modelled view is being built out; flipping this
  // to '2d' restores the previous default without touching anything else.
  mode: '3d',
  setMode: (mode) => set({ mode }),
  toggle: () => set((s) => ({ mode: s.mode === '2d' ? '3d' : '2d' })),
}));
