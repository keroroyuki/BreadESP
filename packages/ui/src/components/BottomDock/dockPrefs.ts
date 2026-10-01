// T3.6 — bottom-dock panel visibility as pure, unit-testable helpers.
// Persistence is a compact comma list under 'breadesp.dock' (injectable
// storage stays in the component); the order is normalized to the canonical
// DOCK_PANEL_ORDER so a toggle re-inserts a panel at its home position.
export type DockPanelId = 'serial' | 'scope' | 'screen' | 'wavegen';

/** Canonical left-to-right order of the panels in the dock. */
export const DOCK_PANEL_ORDER: readonly DockPanelId[] = ['serial', 'scope', 'screen', 'wavegen'];

/** Default view: the two live-instrument panes side by side. */
export const DEFAULT_DOCK_VISIBLE: readonly DockPanelId[] = ['serial', 'scope'];

export const DOCK_STORAGE_KEY = 'breadesp.dock';

/** Parse a persisted list; unknown/duplicate ids drop out, order normalizes. */
export function parseDockVisible(raw: string | null): DockPanelId[] {
  if (raw === null) return [...DEFAULT_DOCK_VISIBLE];
  if (raw.trim() === '') return [];
  const ids = raw.split(',').map((s) => s.trim());
  const known = ids.filter((id): id is DockPanelId =>
    (DOCK_PANEL_ORDER as readonly string[]).includes(id));
  return DOCK_PANEL_ORDER.filter((id) => known.includes(id));
}

/** Serialize for storage; canonical order makes the value stable. */
export function serializeDockVisible(visible: readonly DockPanelId[]): string {
  return [...visible].join(',');
}

/** Toggle one panel off/on; a switched-on panel lands at its canonical slot. */
export function toggleDockPanel(visible: readonly DockPanelId[], id: DockPanelId): DockPanelId[] {
  const has = visible.includes(id);
  return DOCK_PANEL_ORDER.filter((p) => (p === id ? !has : visible.includes(p)));
}
