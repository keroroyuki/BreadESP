// Toast queue: push/dismiss lifecycle, cap eviction, per-kind auto-dismiss.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOAST_DURATION,
  TOAST_LIMIT,
  __clearToastTimers,
  toast,
  useToastStore,
} from '../src/store/toastStore';

const state = () => useToastStore.getState().toasts;

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  __clearToastTimers();
});

afterEach(() => {
  __clearToastTimers();
  vi.useRealTimers();
});

describe('toastStore', () => {
  it('push appends and returns a unique id', () => {
    const a = toast.info('a');
    const b = toast.info('b');
    expect(a).not.toBe(b);
    expect(state().map((t) => t.message)).toEqual(['a', 'b']);
  });

  it('dismiss removes exactly the given toast', () => {
    const a = toast.info('a');
    toast.info('b');
    useToastStore.getState().dismiss(a);
    expect(state().map((t) => t.message)).toEqual(['b']);
  });

  it('dismiss of an unknown id is a no-op', () => {
    toast.info('a');
    useToastStore.getState().dismiss(999);
    expect(state()).toHaveLength(1);
  });

  it(`caps at ${TOAST_LIMIT} toasts, evicting the oldest`, () => {
    for (let i = 0; i < TOAST_LIMIT + 3; i++) toast.info(`m${i}`);
    const msgs = state().map((t) => t.message);
    expect(msgs).toHaveLength(TOAST_LIMIT);
    expect(msgs[0]).toBe(`m3`); // first three evicted
  });

  it('auto-dismisses after the per-kind duration', () => {
    vi.useFakeTimers();
    toast.success('ok');
    expect(state()).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_DURATION.success - 1);
    expect(state()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state()).toHaveLength(0);
  });

  it('error toasts outlive success toasts', () => {
    vi.useFakeTimers();
    toast.success('ok');
    toast.error('bad');
    vi.advanceTimersByTime(TOAST_DURATION.success);
    expect(state().map((t) => t.kind)).toEqual(['error']);
    vi.advanceTimersByTime(TOAST_DURATION.error - TOAST_DURATION.success);
    expect(state()).toHaveLength(0);
  });

  it('a custom duration overrides the default', () => {
    vi.useFakeTimers();
    toast.info('custom', { duration: 100 });
    vi.advanceTimersByTime(99);
    expect(state()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state()).toHaveLength(0);
  });

  it('explicit dismiss cancels the pending auto-dismiss timer', () => {
    vi.useFakeTimers();
    const id = toast.info('x');
    useToastStore.getState().dismiss(id);
    vi.advanceTimersByTime(TOAST_DURATION.info * 2);
    expect(state()).toHaveLength(0); // no throw, still empty
  });
});
