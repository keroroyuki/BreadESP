// Shared select — a native <select> with the platform chrome stripped and our
// own chevron, so every dropdown in the app (speed, firmware candidate, watch
// mode) has the same height, radius and padding as Button.
//
// Native is deliberate: keyboard support, type-ahead and the OS picker come
// free, which matters more than pixel control for a small desktop tool.
import type { SelectHTMLAttributes } from 'react';
import { Icon } from './Icon';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Fill the parent instead of sizing to content. */
  block?: boolean;
}

export function Select({ block = false, className = '', children, ...rest }: SelectProps) {
  return (
    <span className={`relative inline-flex items-center ${block ? 'w-full min-w-0' : ''}`}>
      <select
        className={`h-7 cursor-pointer appearance-none rounded border border-bb-line bg-white pl-2 pr-6 text-xs text-bb-ink
          transition-colors hover:border-slate-400 focus:border-bb-primary focus:outline-none
          disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-bb-muted
          ${block ? 'w-full min-w-0' : ''} ${className}`}
        {...rest}
      >
        {children}
      </select>
      <Icon name="chevronDown" size={12} className="pointer-events-none absolute right-1.5 text-bb-muted" />
    </span>
  );
}
