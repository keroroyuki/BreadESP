// PRD: §F-EXT-3, §6.6 — marketplaceStore (dev-plan P5.2): catalog scan/load
// lifecycle, renderer-side mirroring of loaded factories into the registry
// (palette visibility), and the registryTick re-render signal. The bridge is
// mocked; the peripheral registry is real (in-memory, per test file), so the
// palette integration is exercised end to end. Kinds are unique per test.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFactory } from '@breadesp/peripherals';
import type { PeripheralCatalogEntry, PeripheralCatalogLoadResult, PeripheralCatalogScan } from '../src/ipc/bridge';

const mocks = vi.hoisted(() => ({
  catalogScan: vi.fn(),
  catalogLoad: vi.fn(),
}));

vi.mock('../src/ipc/bridge', () => ({ bridge: { per: { catalogScan: mocks.catalogScan, catalogLoad: mocks.catalogLoad } } }));

import { mirrorCatalogFactories, useMarketplaceStore } from '../src/store/marketplaceStore';
import { paletteEntries } from '../src/components/Palette/paletteEntries';

const META = {
  kind: 'mkt-servo',
  version: '0.9.0',
  displayName: 'Market Servo',
  pins: [{ id: 'SIG', role: 'pwm-in' as const }],
};

function scanWith(entries: Partial<PeripheralCatalogEntry>[]): PeripheralCatalogScan {
  return {
    rootDir: '/home/u/.breadesp/peripherals',
    entries: entries.map((e, i) => ({
      dir: `/home/u/.breadesp/peripherals/pack-${i}`,
      status: 'ok',
      issues: [],
      manifest: null,
      loaded: false,
      kinds: [],
      factories: [],
      ...e,
    })),
  };
}

function resetStore(): void {
  useMarketplaceStore.setState({
    rootDir: null,
    entries: [],
    scanning: false,
    loading: {},
    error: null,
    notice: null,
    registryTick: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe('marketplaceStore — scan (P5.2, PRD §F-EXT-3)', () => {
  it('populates rootDir/entries and clears the error', async () => {
    useMarketplaceStore.setState({ error: 'stale' });
    mocks.catalogScan.mockResolvedValueOnce(scanWith([{ manifest: null }]));
    await useMarketplaceStore.getState().scan();
    const s = useMarketplaceStore.getState();
    expect(s.rootDir).toBe('/home/u/.breadesp/peripherals');
    expect(s.entries).toHaveLength(1);
    expect(s.scanning).toBe(false);
    expect(s.error).toBeNull();
  });

  it('re-mirrors factories of packages the Bridge session already loaded (renderer reload)', async () => {
    mocks.catalogScan.mockResolvedValueOnce(scanWith([
      {
        dir: '/home/u/.breadesp/peripherals/servo',
        loaded: true,
        kinds: ['mkt-servo'],
        factories: [META],
      },
    ]));
    const tickBefore = useMarketplaceStore.getState().registryTick;
    await useMarketplaceStore.getState().scan();
    // The kind renders in the palette without any further action.
    expect(getFactory('mkt-servo')).toBeDefined();
    expect(paletteEntries().map((e) => e.kind)).toContain('mkt-servo');
    expect(useMarketplaceStore.getState().registryTick).toBe(tickBefore + 1);
  });

  it('does not bump registryTick when a scan mirrors nothing new', async () => {
    mocks.catalogScan.mockResolvedValueOnce(scanWith([]));
    await useMarketplaceStore.getState().scan();
    expect(useMarketplaceStore.getState().registryTick).toBe(0);
    mocks.catalogScan.mockResolvedValueOnce(scanWith([
      { loaded: true, kinds: ['mkt-servo'], factories: [META] }, // already mirrored above
    ]));
    await useMarketplaceStore.getState().scan();
    expect(useMarketplaceStore.getState().registryTick).toBe(0);
  });

  it('surfaces a scan failure as an error without clobbering entries', async () => {
    useMarketplaceStore.setState({ entries: scanWith([{}]).entries });
    mocks.catalogScan.mockRejectedValueOnce(new Error('io down'));
    await useMarketplaceStore.getState().scan();
    const s = useMarketplaceStore.getState();
    expect(s.error).toBe('Catalog scan failed: io down');
    expect(s.entries).toHaveLength(1);
    expect(s.scanning).toBe(false);
  });
});

describe('marketplaceStore — load (P5.2, PRD §F-EXT-3)', () => {
  it('mirrors the loaded factories, marks the entry loaded and bumps registryTick', async () => {
    mocks.catalogScan.mockResolvedValueOnce(scanWith([{ dir: '/p/acme' }]));
    await useMarketplaceStore.getState().scan();
    const result: PeripheralCatalogLoadResult = {
      dir: '/p/acme',
      kinds: ['mkt-thermo'],
      factories: [{ kind: 'mkt-thermo', version: '1.0.0', displayName: 'Thermo', pins: [] }],
    };
    mocks.catalogLoad.mockResolvedValueOnce(result);
    const tickBefore = useMarketplaceStore.getState().registryTick;
    await useMarketplaceStore.getState().load('/p/acme');

    const s = useMarketplaceStore.getState();
    expect(mocks.catalogLoad).toHaveBeenCalledWith({ dir: '/p/acme' });
    expect(s.entries[0]).toMatchObject({ loaded: true, kinds: ['mkt-thermo'] });
    expect(s.registryTick).toBe(tickBefore + 1);
    expect(s.notice).toBe('Loaded mkt-thermo — now in the palette');
    expect(s.loading).toEqual({});
    // The mirrored kind is palette-visible (the M5 acceptance path, P5.2 flavor).
    expect(paletteEntries().map((e) => e.kind)).toContain('mkt-thermo');
    expect(getFactory('mkt-thermo')?.displayName).toBe('Thermo');
  });

  it('surfaces a load failure as an error and mirrors nothing', async () => {
    mocks.catalogScan.mockResolvedValueOnce(scanWith([{ dir: '/p/bad' }]));
    await useMarketplaceStore.getState().scan();
    mocks.catalogLoad.mockRejectedValueOnce(new Error('[BB-223] failed to load peripheral package'));
    const tickBefore = useMarketplaceStore.getState().registryTick;
    await useMarketplaceStore.getState().load('/p/bad');
    const s = useMarketplaceStore.getState();
    expect(s.error).toBe('Load failed: [BB-223] failed to load peripheral package');
    expect(s.entries[0]?.loaded).toBe(false);
    expect(s.registryTick).toBe(tickBefore);
    expect(s.loading).toEqual({});
  });

  it('deduplicates concurrent loads of the same dir (double-click guard)', async () => {
    let resolveLoad: (r: PeripheralCatalogLoadResult) => void = () => {};
    mocks.catalogLoad.mockImplementationOnce(
      () => new Promise<PeripheralCatalogLoadResult>((res) => { resolveLoad = res; }),
    );
    const first = useMarketplaceStore.getState().load('/p/dup');
    const second = useMarketplaceStore.getState().load('/p/dup');
    resolveLoad({ dir: '/p/dup', kinds: [], factories: [] });
    await Promise.all([first, second]);
    expect(mocks.catalogLoad).toHaveBeenCalledTimes(1);
  });
});

describe('mirrorCatalogFactories (P5.2)', () => {
  it('registers only kinds missing from this registry and reports them', () => {
    const meta = { kind: 'mkt-mirror', version: '1.0.0', displayName: 'Mirror', pins: [] };
    expect(mirrorCatalogFactories([meta])).toEqual(['mkt-mirror']);
    // Second mirror of the same kind is a no-op (no [BB-221] storm).
    expect(mirrorCatalogFactories([meta])).toEqual([]);
    expect(mirrorCatalogFactories([])).toEqual([]);
  });
});
