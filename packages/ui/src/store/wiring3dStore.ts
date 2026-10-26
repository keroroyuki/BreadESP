// 3D pin wiring state (step 4).
//
// Lives in a store rather than component state because two places drive it: the
// pin hit areas inside the WebGL scene, and the canvas-level keyboard handler
// (Esc) / background click outside it. The rules themselves come from the shared
// `advanceWiring`, so 2D and 3D can never disagree about what a pin click means.
import { create } from 'zustand';
import { MCU_INSTANCE_ID, type WireEndpoint } from '@breadesp/netlist';
import { toast } from './toastStore';
import { tNow } from '../i18n';
import { advanceWiring } from '../components/Breadboard/wiringFlow';
import { useProjectStore } from './projectStore';

const endpointLabel = (ep: WireEndpoint): string =>
  `${ep.instanceId === MCU_INSTANCE_ID ? 'MCU' : ep.instanceId}.${ep.pin}`;

interface Wiring3DState {
  /** Pin that started the current wire, or null when idle. */
  pending: WireEndpoint | null;
  /** Board point under the cursor while a wire is in progress (rubber band end). */
  hover: { x: number; z: number } | null;
  pickPin: (endpoint: WireEndpoint) => void;
  setHover: (hover: { x: number; z: number } | null) => void;
  cancel: () => void;
}

export const useWiring3DStore = create<Wiring3DState>((set, get) => ({
  pending: null,
  hover: null,

  pickPin: (endpoint) => {
    const outcome = advanceWiring(get().pending, endpoint);
    if (outcome.kind === 'start') {
      set({ pending: endpoint, hover: null });
      toast.info(tNow('canvas.wiringFrom', { pin: endpointLabel(endpoint) }));
      return;
    }
    if (outcome.kind === 'cancel') {
      set({ pending: null, hover: null });
      toast.info(tNow('canvas.wireCancelled'));
      return;
    }
    if (outcome.kind === 'not-routable') {
      set({ pending: null, hover: null });
      toast.warning(tNow('canvas.wireNotRoutable'));
      return;
    }
    const id = useProjectStore.getState().addWire(outcome.from, outcome.to);
    set({ pending: null, hover: null });
    if (id === null) {
      toast.warning(tNow('canvas.wireExists'));
    } else {
      toast.success(
        tNow('canvas.wireCreated', {
          from: endpointLabel(outcome.from),
          to: endpointLabel(outcome.to),
        }),
      );
    }
  },

  setHover: (hover) => set({ hover }),
  cancel: () => set({ pending: null, hover: null }),
}));
