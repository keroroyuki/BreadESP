// T4.1 — selection store contract: mutual exclusion between the instance and
// wire slots, null picks only clear their own slot, clear() resets both.
import { describe, it, expect, beforeEach } from 'vitest';
import { useSelectionStore } from '../src/store/selectionStore';

const reset = (): void => {
  useSelectionStore.getState().clear();
};

describe('selectionStore', () => {
  beforeEach(reset);

  it('starts with nothing selected', () => {
    const s = useSelectionStore.getState();
    expect(s.instanceId).toBeNull();
    expect(s.wireId).toBeNull();
  });

  it('selecting an instance clears the wire slot', () => {
    useSelectionStore.getState().selectWire('wire-1');
    useSelectionStore.getState().selectInstance('led-1');
    const s = useSelectionStore.getState();
    expect(s.instanceId).toBe('led-1');
    expect(s.wireId).toBeNull();
  });

  it('selecting a wire clears the instance slot', () => {
    useSelectionStore.getState().selectInstance('led-1');
    useSelectionStore.getState().selectWire('wire-1');
    const s = useSelectionStore.getState();
    expect(s.wireId).toBe('wire-1');
    expect(s.instanceId).toBeNull();
  });

  it('a null instance pick keeps the wire slot', () => {
    useSelectionStore.getState().selectWire('wire-1');
    useSelectionStore.getState().selectInstance(null);
    expect(useSelectionStore.getState().wireId).toBe('wire-1');
  });

  it('a null wire pick keeps the instance slot', () => {
    useSelectionStore.getState().selectInstance('led-1');
    useSelectionStore.getState().selectWire(null);
    expect(useSelectionStore.getState().instanceId).toBe('led-1');
  });

  it('clear() empties both slots', () => {
    useSelectionStore.getState().selectInstance('led-1');
    useSelectionStore.getState().clear();
    const s = useSelectionStore.getState();
    expect(s.instanceId).toBeNull();
    expect(s.wireId).toBeNull();
  });

  it('re-selecting another instance swaps the pick', () => {
    useSelectionStore.getState().selectInstance('led-1');
    useSelectionStore.getState().selectInstance('mic-2');
    expect(useSelectionStore.getState().instanceId).toBe('mic-2');
  });
});
