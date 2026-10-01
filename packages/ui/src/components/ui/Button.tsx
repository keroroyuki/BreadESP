// Shared Button — the single visual language for every control surface
// (Tailwind v4; no preflight needed since classes are self-contained).
// Variants map onto the bb-* design tokens from styles/global.css; `busy`
// shows a spinner and disables interaction without moving the layout.
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  /** While true: spinner + disabled, keeps its width (no layout jump). */
  busy?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<NonNullable<ButtonProps['variant']>, string> = {
  default:
    'bg-white text-bb-ink border border-bb-line hover:bg-slate-50 active:bg-slate-100 disabled:bg-slate-100 disabled:text-bb-muted disabled:border-bb-line',
  primary:
    'bg-bb-primary text-white border border-bb-primary-strong hover:bg-bb-primary-strong active:bg-blue-900 disabled:bg-slate-300 disabled:border-slate-300 disabled:text-slate-500',
  danger:
    'bg-white text-bb-danger border border-red-300 hover:bg-red-50 active:bg-red-100 disabled:bg-slate-100 disabled:text-bb-muted disabled:border-bb-line',
  ghost:
    'bg-transparent text-bb-ink border border-transparent hover:bg-slate-100 active:bg-slate-200 disabled:text-bb-muted',
};

export function Button({ variant = 'default', busy = false, disabled, className = '', children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled === true || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded px-2.5 h-7 text-xs font-medium cursor-pointer select-none
        transition-colors duration-75 disabled:cursor-not-allowed
        ${VARIANT_CLASSES[variant]} ${className}`}
      {...rest}
    >
      {busy && (
        <span
          aria-hidden
          className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      )}
      {children}
    </button>
  );
}
