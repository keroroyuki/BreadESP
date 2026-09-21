// PRD: §F-EXT-3 — marketplaceDraft pure presentation logic (dev-plan P5.2):
// status labels, loadability, titles, kind lines and the catalog summary.
import { describe, expect, it } from 'vitest';
import type { PeripheralCatalogEntry } from '../src/ipc/bridge';
import {
  canLoad,
  catalogSummary,
  dirBasename,
  entrySubtitle,
  entryTitle,
  kindsLine,
  statusLabel,
} from '../src/components/Marketplace/marketplaceDraft';

function entry(overrides: Partial<PeripheralCatalogEntry> = {}): PeripheralCatalogEntry {
  return {
    dir: '/root/acme-matrix',
    status: 'ok',
    issues: [],
    manifest: {
      manifestVersion: 1,
      name: 'acme-matrix',
      version: '0.3.1',
      displayName: 'Acme LED Matrix',
      entry: 'index.mjs',
    },
    loaded: false,
    kinds: [],
    factories: [],
    ...overrides,
  };
}

describe('marketplaceDraft — status and loadability (P5.2, PRD §F-EXT-3)', () => {
  it('labels each status; loaded wins over a broken on-disk rescan', () => {
    expect(statusLabel(entry())).toBe('ready');
    expect(statusLabel(entry({ status: 'invalid' }))).toBe('invalid');
    expect(statusLabel(entry({ status: 'incompatible' }))).toBe('incompatible');
    expect(statusLabel(entry({ loaded: true }))).toBe('loaded');
    // The registered code is running; a later disk-side breakage must not
    // relabel it.
    expect(statusLabel(entry({ loaded: true, status: 'invalid' }))).toBe('loaded');
  });

  it('allows loading only a successfully scanned, not-yet-loaded package', () => {
    expect(canLoad(entry())).toBe(true);
    expect(canLoad(entry({ loaded: true }))).toBe(false);
    expect(canLoad(entry({ status: 'invalid' }))).toBe(false);
    expect(canLoad(entry({ status: 'incompatible' }))).toBe(false);
  });
});

describe('marketplaceDraft — titles and lines', () => {
  it('uses the manifest displayName, falling back to the dir basename', () => {
    expect(entryTitle(entry())).toBe('Acme LED Matrix');
    expect(entryTitle(entry({ manifest: null, dir: 'C:\\peripherals\\broken-pack' }))).toBe('broken-pack');
  });

  it('derives basenames across separators and trailing slashes', () => {
    expect(dirBasename('/a/b/c')).toBe('c');
    expect(dirBasename('C:\\a\\b\\')).toBe('b');
    expect(dirBasename('solo')).toBe('solo');
  });

  it('renders the name@version subtitle only when a manifest parsed', () => {
    expect(entrySubtitle(entry())).toBe('acme-matrix@0.3.1');
    expect(entrySubtitle(entry({ manifest: null }))).toBeNull();
  });

  it('shows registered kinds when loaded, advertised provides before that', () => {
    expect(kindsLine(entry({ loaded: true, kinds: ['acme-matrix'] }))).toBe('kinds: acme-matrix');
    expect(kindsLine(entry({ manifest: { ...entry().manifest!, provides: ['acme-matrix', 'acme-buzzer'] } })))
      .toBe('provides: acme-matrix, acme-buzzer');
    expect(kindsLine(entry())).toBeNull();
    expect(kindsLine(entry({ manifest: null }))).toBeNull();
    // An empty provides list renders nothing.
    expect(kindsLine(entry({ manifest: { ...entry().manifest!, provides: [] } }))).toBeNull();
  });
});

describe('marketplaceDraft — catalog summary', () => {
  it('summarizes empty, uniform and mixed catalogs', () => {
    expect(catalogSummary([])).toBe('no packages found');
    expect(catalogSummary([entry()])).toBe('1 package');
    expect(catalogSummary([entry(), entry({ loaded: true })])).toBe('2 packages · 1 loaded');
    expect(catalogSummary([entry({ status: 'invalid' }), entry({ status: 'incompatible' })]))
      .toBe('2 packages · 2 not loadable');
    // A loaded package with a broken rescan counts as loaded, not broken.
    expect(catalogSummary([entry({ loaded: true, status: 'invalid' }), entry({ status: 'ok' })]))
      .toBe('2 packages · 1 loaded');
  });
});
