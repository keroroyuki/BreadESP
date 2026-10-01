// PRD: §F-BB-2, §F-EXT-1 — Peripheral palette. Drag to place on the breadboard.
// The list is registry-driven (dev-plan P5.1): every registered factory —
// built-in or third-party — appears automatically with its displayName and
// version; no per-kind UI code is required for a peripheral to be placeable.
// P5.2: re-renders when a catalog load mirrors new kinds into the registry.
// T3.1: instant search over label/kind (paletteFilter, pure) with a result
// counter; the blank query keeps the full registry order.
import { useMemo, useState } from 'react';
import { paletteEntries } from './paletteEntries';
import { filterPaletteEntries } from './paletteFilter';
import { useMarketplaceStore } from '../../store/marketplaceStore';
import { useT } from '../../i18n';

export function Palette() {
  // paletteEntries() reads the live module registry; registryTick re-runs it
  // when a catalog load mirrored new remote kinds into this process (P5.2).
  const registryTick = useMarketplaceStore((s) => s.registryTick);
  const [query, setQuery] = useState('');
  const t = useT();
  const entries = useMemo(() => paletteEntries(), [registryTick]);
  const visible = useMemo(() => filterPaletteEntries(entries, query), [entries, query]);
  const onDragStart = (e: React.DragEvent, kind: string) => {
    // react-konva Stage drag events don't have dataTransfer; we use a window scratch var.
    (window as unknown as { __bb_drag_kind?: string }).__bb_drag_kind = kind;
    void e;
  };
  return (
    <aside style={panel}>
      <h3 style={h3}>{t('palette.title')}</h3>
      <input
        style={search}
        value={query}
        placeholder={t('palette.searchPlaceholder')}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div style={{ color: '#94a3b8', fontSize: 10, margin: '4px 0 8px' }}>
        {t('palette.count', { n: visible.length })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map((p) => (
          <div
            key={p.kind}
            draggable
            onDragStart={(e) => onDragStart(e, p.kind)}
            style={item}
            title={`${p.kind} v${p.version}`}
          >
            <span>{p.label}</span>
            <span style={badge}>v{p.version}</span>
          </div>
        ))}
        {visible.length === 0 && <div style={empty}>{t('palette.noMatch')}</div>}
      </div>
    </aside>
  );
}

const panel: React.CSSProperties = { padding: 8, flex: 1, minHeight: 0, overflowY: 'auto' };
const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 13 };
const search: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 8px',
  fontSize: 12,
};
const empty: React.CSSProperties = { color: '#94a3b8', fontSize: 11, padding: 4 };
const item: React.CSSProperties = {
  padding: 8,
  border: '1px solid #ddd',
  borderRadius: 4,
  cursor: 'grab',
  background: '#fff',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 6,
};
const badge: React.CSSProperties = { fontSize: 9, color: '#94a3b8', flexShrink: 0 };
