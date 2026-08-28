// PRD: §F-BB-2 — Peripheral palette. Drag to place on the breadboard.
// MVP set per PRD §8: led, button, ssd1306.
const PALETTE: { kind: string; label: string }[] = [
  { kind: 'led', label: 'LED' },
  { kind: 'button', label: 'Push Button' },
  { kind: 'ssd1306', label: 'SSD1306 OLED' },
];

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
        {PALETTE.map((p) => (
          <div
            key={p.kind}
            draggable
            onDragStart={(e) => onDragStart(e, p.kind)}
            style={item}
          >
            {p.label}
          </div>
        ))}
      </div>
    </aside>
  );
}

const panel: React.CSSProperties = { width: 180, borderRight: '1px solid #ccc', padding: 8 };
const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 13 };
const item: React.CSSProperties = { padding: 8, border: '1px solid #ddd', borderRadius: 4, cursor: 'grab', background: '#fff' };
