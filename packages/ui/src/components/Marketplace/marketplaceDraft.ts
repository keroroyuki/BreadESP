// PRD: §F-EXT-3 — Pure presentation logic of the local peripheral catalog
// panel (dev-plan P5.2, the "offline marketplace"). Kept bridge-free so every
// display decision is unit-testable; the component and store own effects.
import type { PeripheralCatalogEntry } from '../../ipc/bridge';

/** Badge label of a catalog entry. A loaded package stays 'loaded' even when
 *  a later rescan flags the on-disk manifest — the registered code is running. */
export function statusLabel(entry: Pick<PeripheralCatalogEntry, 'status' | 'loaded'>): string {
  if (entry.loaded) return 'loaded';
  switch (entry.status) {
    case 'ok': return 'ready';
    case 'incompatible': return 'incompatible';
    case 'invalid': return 'invalid';
  }
}

/** Only a successfully scanned, not-yet-loaded package can be loaded. */
export function canLoad(entry: Pick<PeripheralCatalogEntry, 'status' | 'loaded'>): boolean {
  return entry.status === 'ok' && !entry.loaded;
}

/** Last path segment of a dir, tolerant of both separators (renderer has no node:path). */
export function dirBasename(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() ?? dir;
}

/** Display title: the manifest displayName, falling back to the dir name. */
export function entryTitle(entry: Pick<PeripheralCatalogEntry, 'dir' | 'manifest'>): string {
  return entry.manifest?.displayName ?? dirBasename(entry.dir);
}

/** Secondary line: `name@version` when the manifest parsed. */
export function entrySubtitle(entry: Pick<PeripheralCatalogEntry, 'manifest'>): string | null {
  const m = entry.manifest;
  return m === null ? null : `${m.name}@${m.version}`;
}

/**
 * Kind line: registered kinds once loaded, advertised `provides` before that
 * (advertised = informational, rendered as such), null when neither exists.
 */
export function kindsLine(entry: Pick<PeripheralCatalogEntry, 'loaded' | 'kinds' | 'manifest'>): string | null {
  if (entry.loaded && entry.kinds.length > 0) return `kinds: ${entry.kinds.join(', ')}`;
  if (!entry.loaded && entry.manifest?.provides !== undefined && entry.manifest.provides.length > 0) {
    return `provides: ${entry.manifest.provides.join(', ')}`;
  }
  return null;
}

/** One-line summary of the whole catalog for the panel footer. */
export function catalogSummary(entries: readonly Pick<PeripheralCatalogEntry, 'status' | 'loaded'>[]): string {
  if (entries.length === 0) return 'no packages found';
  const loaded = entries.filter((e) => e.loaded).length;
  const broken = entries.filter((e) => !e.loaded && e.status !== 'ok').length;
  const parts = [`${entries.length} package${entries.length === 1 ? '' : 's'}`];
  if (loaded > 0) parts.push(`${loaded} loaded`);
  if (broken > 0) parts.push(`${broken} not loadable`);
  return parts.join(' · ');
}
