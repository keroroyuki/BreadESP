// T4.1 — canvas selection lifted out of BreadboardCanvas into a store, so
// the PropsPanel (RightPanel) can follow what the user selected without
// prop-drilling. The two slots are mutually exclusive, mirroring the canvas
// click behavior that has always cleared the other slot.
import { create } from 'zustand';

interface SelectionState {
  /** Selected peripheral instance (the MCU is fixed and never selectable). */
  instanceId: string | null;
  /** Selected wire id. */
  wireId: string | null;
  /** Select an instance; a non-null pick clears the wire slot. */
  selectInstance: (id: string | null) => void;
  /** Select a wire; a non-null pick clears the instance slot. */
  selectWire: (id: string | null) => void;
  /** Clear both slots (Esc, background click). */
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  instanceId: null,
  wireId: null,
  selectInstance: (id) =>
    set(id === null ? { instanceId: null } : { instanceId: id, wireId: null }),
  selectWire: (id) =>
    set(id === null ? { wireId: null } : { wireId: id, instanceId: null }),
  clear: () => set({ instanceId: null, wireId: null }),
}));
