// PRD: §F-BB-2, §F-EXT-1 — Peripheral palette. Drag to place on the breadboard.
// The list is registry-driven (dev-plan P5.1): every registered factory —
// built-in or third-party — appears automatically with its displayName and
// version; no per-kind UI code is required for a peripheral to be placeable.
// P5.2: re-renders when a catalog load mirrors new kinds into the registry.
// T3.1: instant search over label/kind (paletteFilter, pure) with a result
// counter; the blank query keeps the full registry order.
//
// Visual pass: entries are grouped by signal family (input / output / display /
// sensor / instrument) and carry the kind's glyph and accent colour, so the
// palette reads as a parts tray instead of a list of strings. Grouping is
// presentational only — the registry order inside a group is preserved and
// third-party kinds land under "Extensions" with the generic chip glyph.
import { useMemo, useState } from 'react';
import { paletteEntries } from './paletteEntries';
import { filterPaletteEntries } from './paletteFilter';
import { useMarketplaceStore } from '../../store/marketplaceStore';
import { useT } from '../../i18n';
import { PartIconTile } from '../parts/PartIcon';
import {
  CATEGORY_ACCENT,
  CATEGORY_LABEL_KEY,
  CATEGORY_ORDER,
  PART_COPY,
  partVisual,
  type PartCategory,
} from '../parts/partVisuals';

interface PaletteRow {
  kind: string;
  /** Localized name — also the field `filterPaletteEntries` searches. */
  label: string;
  version: string;
  name: string;
  role: string;
  category: PartCategory;
}

export function Palette() {
  // paletteEntries() reads the live module registry; registryTick re-runs it
  // when a catalog load mirrored new remote kinds into this process (P5.2).
  const registryTick = useMarketplaceStore((s) => s.registryTick);
  const [query, setQuery] = useState('');
  const t = useT();
  const entries = useMemo(() => paletteEntries(), [registryTick]);
  // Search the name the user actually sees, while keeping the machine kind
  // searchable too (filterPaletteEntries already matches `kind`).
  const rows = useMemo<PaletteRow[]>(
    () =>
      entries.map((e) => {
        const copy = PART_COPY[e.kind];
        const name = copy === undefined ? e.label : t(copy.name);
        return {
          kind: e.kind,
          label: name,
          version: e.version,
          name,
          role: copy === undefined ? t('part.category.other') : t(copy.role),
          category: partVisual(e.kind).category,
        };
      }),
    [entries, t],
  );
  const visible = useMemo(
    () => filterPaletteEntries(rows, query) as PaletteRow[],
    [rows, query],
  );
  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        items: visible.filter((r) => r.category === category),
      })).filter((g) => g.items.length > 0),
    [visible],
  );
  const onDragStart = (e: React.DragEvent, kind: string) => {
    // react-konva Stage drag events don't have dataTransfer; we use a window scratch var.
    (window as unknown as { __bb_drag_kind?: string }).__bb_drag_kind = kind;
    void e;
  };

  return (
    <aside className="flex min-h-0 flex-1 flex-col px-2 pt-2.5 pb-2">
      <div className="flex items-baseline justify-between px-1">
        <h3 className="text-[13px] font-semibold tracking-tight text-bb-ink">{t('palette.title')}</h3>
        <span className="rounded-full bg-white px-1.5 py-px text-[10px] tabular-nums text-bb-muted ring-1 ring-bb-line">
          {visible.length}
        </span>
      </div>
      <div className="relative mt-2">
        <input
          className="h-8 w-full rounded-md border border-bb-line bg-white pl-7 pr-2 text-xs text-bb-ink outline-none placeholder:text-slate-400 focus:border-bb-primary focus:ring-2 focus:ring-bb-primary/15"
          value={query}
          placeholder={t('palette.searchPlaceholder')}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <svg
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="6" />
          <path d="m16 16 4 4" />
        </svg>
      </div>
      <p className="px-1 pt-1.5 pb-1 text-[10px] leading-3 text-slate-400">{t('palette.hint')}</p>

      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {groups.map((group) => (
          <section key={group.category} className="pt-1.5 first:pt-0">
            <header className="flex items-center gap-1.5 px-1 pb-0.5 pt-1">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: CATEGORY_ACCENT[group.category] }}
              />
              <span className="text-[10px] font-medium uppercase tracking-wider text-bb-muted">
                {t(CATEGORY_LABEL_KEY[group.category])}
              </span>
              <span className="ml-auto text-[9px] tabular-nums text-slate-400">{group.items.length}</span>
            </header>
            <div className="flex flex-col gap-0.5">
              {group.items.map((row) => (
                <div
                  key={row.kind}
                  draggable
                  onDragStart={(e) => onDragStart(e, row.kind)}
                  title={`${row.kind} v${row.version}`}
                  className="group flex cursor-grab items-center gap-2 rounded-lg border border-transparent bg-white px-1.5 py-1
                    shadow-[0_1px_0_rgba(15,23,42,0.03)] transition-all duration-100
                    hover:border-bb-line hover:shadow-sm active:cursor-grabbing active:scale-[0.985]"
                >
                  <PartIconTile kind={row.kind} size={29} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1">
                      <span className="truncate text-[11px] font-medium leading-4 text-bb-ink">
                        {row.name}
                      </span>
                      <span className="shrink-0 text-[8.5px] leading-3 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100">
                        v{row.version}
                      </span>
                    </span>
                    <span className="block truncate text-[9.5px] leading-3 text-bb-muted">{row.role}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
        {visible.length === 0 && (
          <div className="px-2 py-6 text-center text-[11px] text-slate-400">{t('palette.noMatch')}</div>
        )}
      </div>
    </aside>
  );
}
