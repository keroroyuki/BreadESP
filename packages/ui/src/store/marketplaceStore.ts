// PRD: §F-EXT-3, §6.6 — Local peripheral catalog state (dev-plan P5.2, the
// "offline marketplace"). Owns the scan result of the local peripherals root
// and the explicit per-package load action. A successful load mirrors the
// returned factory metadata into this process's registry
// (registerRemotePeripheral) and bumps `registryTick` so registry-driven UI
// (the palette) re-renders with the new kinds.
import { create } from 'zustand';
import { getFactory, registerRemotePeripheral, type PeripheralMeta } from '@breadesp/peripherals';
import { bridge } from '../ipc/bridge';
import type { PeripheralCatalogEntry } from '../ipc/bridge';

/**
 * Mirror Bridge-side factory metadata into this process's registry (P5.2).
 * Idempotent per kind: a kind already present (built-in, previously mirrored)
 * is skipped — the Bridge rejected true duplicates at load time with
 * [BB-221], so a kind that exists here already carries equivalent metadata.
 * Returns the kinds that were newly mirrored.
 */
export function mirrorCatalogFactories(factories: readonly PeripheralMeta[]): string[] {
  const added: string[] = [];
  for (const meta of factories) {
    if (getFactory(meta.kind) !== undefined) continue;
    registerRemotePeripheral(meta);
    added.push(meta.kind);
  }
  return added;
}

interface MarketplaceState {
  /** The scanned peripherals root; null until the first scan resolves. */
  rootDir: string | null;
  entries: PeripheralCatalogEntry[];
  scanning: boolean;
  /** Dirs with an in-flight load (double-click guard). */
  loading: Record<string, boolean>;
  /** Last failure (scan or load), surfaced in the panel. */
  error: string | null;
  /** Last successful load summary. */
  notice: string | null;
  /**
   * Bumped whenever remote factories mirror into this process's registry.
   * Registry-driven components (Palette) subscribe to re-render.
   */
  registryTick: number;
  /** Scan the local peripherals root (also re-mirrors already-loaded kinds). */
  scan: () => Promise<void>;
  /** Load a catalog package into the Bridge registry (explicit user action). */
  load: (dir: string) => Promise<void>;
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  rootDir: null,
  entries: [],
  scanning: false,
  loading: {},
  error: null,
  notice: null,
  registryTick: 0,

  scan: async () => {
    set({ scanning: true, error: null });
    try {
      const scan = await bridge.per.catalogScan();
      // A renderer reload loses this process's mirrored stubs while the Bridge
      // session keeps its registrations — re-mirror from the scan's factories.
      const added = mirrorCatalogFactories(scan.entries.flatMap((e) => e.factories));
      set((s) => ({
        rootDir: scan.rootDir,
        entries: scan.entries,
        scanning: false,
        registryTick: added.length > 0 ? s.registryTick + 1 : s.registryTick,
      }));
    } catch (err) {
      set({ scanning: false, error: `Catalog scan failed: ${reason(err)}` });
    }
  },

  load: async (dir) => {
    if (get().loading[dir]) return; // double-click guard
    set({ loading: { ...get().loading, [dir]: true }, error: null, notice: null });
    try {
      const result = await bridge.per.catalogLoad({ dir });
      const added = mirrorCatalogFactories(result.factories);
      set((s) => ({
        entries: s.entries.map((e) =>
          e.dir === result.dir ? { ...e, loaded: true, kinds: result.kinds, factories: result.factories } : e,
        ),
        registryTick: added.length > 0 ? s.registryTick + 1 : s.registryTick,
        notice: `Loaded ${result.kinds.join(', ')} — now in the palette`,
      }));
    } catch (err) {
      set({ error: `Load failed: ${reason(err)}` });
    } finally {
      const loading = { ...get().loading };
      delete loading[dir];
      set({ loading });
    }
  },
}));
