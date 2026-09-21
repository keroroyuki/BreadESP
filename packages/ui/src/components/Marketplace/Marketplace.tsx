// PRD: §F-EXT-3 — Local peripheral catalog panel (dev-plan P5.2, the "offline
// marketplace"). Lists the packages discovered in the local peripherals root
// (~/.breadesp/peripherals by default) with their manifest metadata and
// status, and loads one into the Bridge registry on explicit click — after
// which its kinds appear in the palette above (registryTick re-render).
// All display decisions live in marketplaceDraft.ts (pure, unit-tested).
import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useMarketplaceStore } from '../../store/marketplaceStore';
import { canLoad, catalogSummary, entrySubtitle, entryTitle, kindsLine, statusLabel } from './marketplaceDraft';

const STATUS_COLORS: Record<string, { fg: string; bg: string; border: string }> = {
  loaded: { fg: '#166534', bg: '#f0fdf4', border: '#bbf7d0' },
  ready: { fg: '#1e40af', bg: '#eff6ff', border: '#bfdbfe' },
  incompatible: { fg: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  invalid: { fg: '#991b1b', bg: '#fef2f2', border: '#fecaca' },
};

export function Marketplace() {
  const rootDir = useMarketplaceStore((s) => s.rootDir);
  const entries = useMarketplaceStore((s) => s.entries);
  const scanning = useMarketplaceStore((s) => s.scanning);
  const loading = useMarketplaceStore((s) => s.loading);
  const error = useMarketplaceStore((s) => s.error);
  const notice = useMarketplaceStore((s) => s.notice);
  const scan = useMarketplaceStore((s) => s.scan);
  const load = useMarketplaceStore((s) => s.load);

  // Scan on mount: feeds the panel and re-mirrors kinds the Bridge session
  // already loaded (a renderer reload loses this process's registry stubs).
  useEffect(() => {
    void useMarketplaceStore.getState().scan();
  }, []);

  return (
    <section style={panel}>
      <div style={headRow}>
        <h3 style={h3}>Peripheral catalog</h3>
        <button style={btn} disabled={scanning} onClick={() => void scan()}>
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </div>
      {rootDir !== null && (
        <div style={rootLine} title={rootDir}>in {rootDir}</div>
      )}
      {entries.map((e) => {
        const label = statusLabel(e);
        const colors = STATUS_COLORS[label] ?? STATUS_COLORS.invalid;
        const subtitle = entrySubtitle(e);
        const kinds = kindsLine(e);
        return (
          <div key={e.dir} style={entryCard}>
            <div style={entryHead}>
              <span style={entryTitleStyle}>{entryTitle(e)}</span>
              <span style={{ ...badge, color: colors.fg, background: colors.bg, borderColor: colors.border }}>
                {label}
              </span>
            </div>
            {subtitle !== null && <div style={subLine}>{subtitle}</div>}
            {e.manifest?.description !== undefined && <div style={descLine}>{e.manifest.description}</div>}
            {kinds !== null && <div style={kindsLineStyle}>{kinds}</div>}
            {e.issues.map((issue) => (
              <div key={issue} style={issueLine}>{issue}</div>
            ))}
            {canLoad(e) && (
              <button style={loadBtn} disabled={loading[e.dir] === true} onClick={() => void load(e.dir)}>
                {loading[e.dir] === true ? 'Loading…' : 'Load'}
              </button>
            )}
          </div>
        );
      })}
      {rootDir !== null && entries.length === 0 && !scanning && (
        <div style={emptyLine}>
          No packages found. Drop a folder with a breadesp-peripheral.json manifest into the directory above.
        </div>
      )}
      {entries.length > 0 && <div style={summaryLine}>{catalogSummary(entries)}</div>}
      {notice !== null && <div style={noticeLine}>{notice}</div>}
      {error !== null && <div style={errorLine}>{error}</div>}
    </section>
  );
}

const panel: CSSProperties = {
  borderTop: '1px solid #ccc',
  padding: 8,
  maxHeight: '45%',
  overflowY: 'auto',
  fontSize: 12,
};
const headRow: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' };
const h3: CSSProperties = { margin: '0 0 6px', fontSize: 13 };
const rootLine: CSSProperties = {
  color: '#94a3b8',
  fontSize: 10,
  fontFamily: 'ui-monospace, monospace',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  marginBottom: 6,
};
const entryCard: CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 4,
  padding: 6,
  marginBottom: 6,
  background: '#fff',
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
};
const entryHead: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 };
const entryTitleStyle: CSSProperties = { fontWeight: 600, color: '#1f2937' };
const badge: CSSProperties = {
  fontSize: 9,
  border: '1px solid',
  borderRadius: 3,
  padding: '0 4px',
  flexShrink: 0,
  textTransform: 'uppercase',
};
const subLine: CSSProperties = { color: '#64748b', fontFamily: 'ui-monospace, monospace', fontSize: 10 };
const descLine: CSSProperties = { color: '#475569' };
const kindsLineStyle: CSSProperties = { color: '#334155', fontFamily: 'ui-monospace, monospace', fontSize: 10 };
const issueLine: CSSProperties = { color: '#991b1b', fontSize: 11 };
const emptyLine: CSSProperties = { color: '#64748b', lineHeight: 1.4 };
const summaryLine: CSSProperties = { color: '#64748b', marginTop: 2 };
const noticeLine: CSSProperties = { color: '#166534', marginTop: 4 };
const errorLine: CSSProperties = { color: '#991b1b', marginTop: 4 };
const btn: CSSProperties = { padding: '2px 8px', fontSize: 11, cursor: 'pointer' };
const loadBtn: CSSProperties = { ...btn, alignSelf: 'flex-start' };
