// Global toast queue — the single feedback channel replacing the per-component
// inline msg/error/notice strings. Store-driven (not context) so non-React
// code (canvas callbacks, store actions) can push directly via `toast()`.
// Auto-dismiss timers live here: errors stay longest so the IPC detail stays
// readable; the cap evicts the oldest to keep the stack bounded.
import { create } from 'zustand';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

/** Max simultaneous toasts; the oldest is evicted beyond this. */
export const TOAST_LIMIT = 5;

/** Auto-dismiss delay per kind (ms). */
export const TOAST_DURATION: Record<ToastKind, number> = {
  success: 3000,
  info: 4000,
  warning: 6000,
  error: 8000,
};

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string, opts?: { duration?: number }) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Test hook: stop pending timers between cases so leaks cannot fire later. */
export function __clearToastTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message, opts) => {
    const id = nextId++;
    const toasts = [...get().toasts, { id, kind, message }].slice(-TOAST_LIMIT);
    set({ toasts });
    const duration = opts?.duration ?? TOAST_DURATION[kind];
    const timer = setTimeout(() => {
      timers.delete(id);
      // Guard: an explicit dismiss may already have removed this toast.
      if (useToastStore.getState().toasts.some((t) => t.id === id)) get().dismiss(id);
    }, duration);
    timers.set(id, timer);
    return id;
  },
  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** Imperative helpers for non-React callers. */
export const toast = {
  success: (m: string, opts?: { duration?: number }) => useToastStore.getState().push('success', m, opts),
  info: (m: string, opts?: { duration?: number }) => useToastStore.getState().push('info', m, opts),
  warning: (m: string, opts?: { duration?: number }) => useToastStore.getState().push('warning', m, opts),
  error: (m: string, opts?: { duration?: number }) => useToastStore.getState().push('error', m, opts),
};
