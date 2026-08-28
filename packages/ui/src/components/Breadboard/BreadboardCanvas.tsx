// PRD: §F-BB-1 — Breadboard canvas. Renders peripheral instances and wires (Konva).
// Drop handling: palette items set window.__bb_drag_kind; on drop we place a peripheral.
import { Fragment } from 'react';
import { Stage, Layer, Rect, Text } from 'react-konva';
import { useProjectStore } from '../../store/projectStore';

export function BreadboardCanvas() {
  const layout = useProjectStore((s) => s.layout);
  const addPeripheral = useProjectStore((s) => s.addPeripheral);

  const onDrop = (e: React.DragEvent) => {
    const kind = (window as unknown as { __bb_drag_kind?: string }).__bb_drag_kind;
    if (!kind) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    addPeripheral(kind, e.clientX - rect.left, e.clientY - rect.top);
  };

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      style={{ flex: 1, background: '#fafafa' }}
    >
      <Stage width={800} height={500}>
        <Layer>
          <Rect x={0} y={0} width={800} height={500} fill="#fafafa" stroke="#ddd" />
          {layout.map((it) => (
            <Fragment key={it.instanceId}>
              <Rect x={it.x} y={it.y} width={120} height={60} fill="#fff" stroke="#888" cornerRadius={6} />
              <Text x={it.x + 8} y={it.y + 22} text={`${it.kind}\n${it.instanceId}`} fontSize={12} />
            </Fragment>
          ))}
        </Layer>
      </Stage>
    </div>
  );
}
