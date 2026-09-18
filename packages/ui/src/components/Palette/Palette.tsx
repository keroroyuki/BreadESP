// PRD: §F-BB-2, §F-EXT-1 — Peripheral palette. Drag to place on the breadboard.
// The list is registry-driven (dev-plan P5.1): every registered factory —
// built-in or third-party — appears automatically with its displayName and
// version; no per-kind UI code is required for a peripheral to be placeable.
import { paletteEntries } from './paletteEntries';

export function Palette() {
  const onDragStart = (e: React.DragEvent, kind: string) => {
    // react-konva Stage drag events don't have dataTransfer; we use a window scratch var.
    (window as unknown as { __bb_drag_kind?: string }).__bb_drag_kind = kind;
    void e;
  };
  return (
    <aside style={panel}>
      <h3 style={h3}>Peripherals</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {paletteEntries().map((p) => (
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
      </div>
    </aside>
  );
}

const panel: React.CSSProperties = { width: 180, borderRight: '1px solid #ccc', padding: 8 };
const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 13 };
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
