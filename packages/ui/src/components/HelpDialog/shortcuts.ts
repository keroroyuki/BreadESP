// T3.5 — the shortcut registry: the single source the help dialog renders
// from. Key caps are physical keys (not translated); descriptions are
// MessageKeys so the dialog re-renders on locale switch. The list must stay
// in sync with the handlers in BreadboardCanvas / HelpDialog.
import type { MessageKey } from '../../i18n';

export interface ShortcutDoc {
  /** Physical key cap, e.g. "Ctrl+Z". */
  keys: string;
  /** i18n key of the human description. */
  descKey: MessageKey;
}

export interface ShortcutSection {
  titleKey: MessageKey;
  items: ShortcutDoc[];
}

export const SHORTCUTS: readonly ShortcutSection[] = [
  {
    titleKey: 'help.section.editing',
    items: [
      { keys: 'Esc', descKey: 'help.keys.esc' },
      { keys: 'Delete', descKey: 'help.keys.delete' },
      { keys: 'Ctrl+Z', descKey: 'help.keys.undo' },
      { keys: 'Ctrl+Y / Ctrl+Shift+Z', descKey: 'help.keys.redo' },
    ],
  },
  {
    titleKey: 'help.section.canvas',
    items: [
      { keys: 'Wheel', descKey: 'help.keys.zoom' },
      { keys: 'Drag background', descKey: 'help.keys.pan' },
      { keys: '?', descKey: 'help.keys.help' },
    ],
  },
];

/**
 * Shared keyboard guard: true while a text surface (serial console input,
 * wavegen fields, dir input) owns the key, so canvas-global shortcuts must
 * not fire. Exported for BreadboardCanvas and HelpDialog — keep one source.
 */
export const isEditableTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
