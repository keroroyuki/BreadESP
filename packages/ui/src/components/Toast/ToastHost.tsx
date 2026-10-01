// Toast viewport (Radix) — renders the toastStore queue. Auto-dismiss is
// owned by the store (timers there); Radix handles a11y roles, focus and
// swipe-to-dismiss (which routes back into store.dismiss).
// Single instance mounted once at the App root.
import * as ToastPrimitive from '@radix-ui/react-toast';
import { useToastStore, type ToastKind } from '../../store/toastStore';

const KIND_CLASSES: Record<ToastKind, { bar: string; icon: string }> = {
  success: { bar: 'border-l-bb-ok', icon: '✓' },
  info: { bar: 'border-l-bb-primary', icon: 'ℹ' },
  warning: { bar: 'border-l-bb-warn', icon: '!' },
  error: { bar: 'border-l-bb-danger', icon: '✕' },
};

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={Infinity}>
      {toasts.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          open
          duration={Infinity}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
          className={`border-l-4 ${KIND_CLASSES[t.kind].bar}
            bg-white border border-bb-line border-l-4 rounded shadow-md px-3 py-2
            flex items-start gap-2 max-w-sm text-xs text-bb-ink
            data-[swipe=move]:translate-x-2 transition-transform`}
        >
          <span aria-hidden className="pt-px select-none">{KIND_CLASSES[t.kind].icon}</span>
          <ToastPrimitive.Description className="leading-4 break-words">
            {t.message}
          </ToastPrimitive.Description>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport
        className="fixed top-3 right-3 z-50 flex flex-col gap-2 outline-none"
        style={{ '--radix-toast-swipe-end-x': '0px' } as React.CSSProperties}
      />
    </ToastPrimitive.Provider>
  );
}
