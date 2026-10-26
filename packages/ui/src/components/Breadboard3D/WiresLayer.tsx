// 3D wiring: the netlist's wires as slack cables, now selectable/deletable in 3D
// (step 4) with the same click semantics as the 2D canvas: first click selects,
// clicking the selected wire deletes it.
import { QuadraticBezierLine } from '@react-three/drei';
import { useProjectStore } from '../../store/projectStore';
import { useSelectionStore } from '../../store/selectionStore';
import { toast } from '../../store/toastStore';
import { tNow } from '../../i18n';
import { endpointAnchor, type Vec3 } from './wiring/anchors';

export function WiresLayer() {
  const netlist = useProjectStore((s) => s.netlist);
  const layout = useProjectStore((s) => s.layout);
  const removeWire = useProjectStore((s) => s.removeWire);
  const selectedWireId = useSelectionStore((s) => s.wireId);
  const selectWire = useSelectionStore((s) => s.selectWire);

  const pickWire = (wireId: string): void => {
    if (useSelectionStore.getState().wireId === wireId) {
      removeWire(wireId);
      selectWire(null);
      toast.info(tNow('canvas.removedWire'));
    } else {
      selectWire(wireId);
      toast.info(tNow('canvas.wireSelected'));
    }
  };

  return (
    <>
      {netlist.wires.map((w) => {
        const a = endpointAnchor(w.from, layout);
        const b = endpointAnchor(w.to, layout);
        // Same rule as the 2D canvas: an endpoint that is not on the board makes the
        // wire undrawable rather than a line to nowhere.
        if (a === null || b === null) return null;
        const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const mid: Vec3 = [
          (a[0] + b[0]) / 2,
          Math.max(a[1], b[1]) + 24 + span * 0.14,
          (a[2] + b[2]) / 2,
        ];
        const selected = selectedWireId === w.id;
        return (
          <QuadraticBezierLine
            key={w.id}
            start={a}
            end={b}
            mid={mid}
            color={selected ? '#dc2626' : '#475569'}
            lineWidth={selected ? 4 : 2.4}
            onPointerDown={(e) => {
              e.stopPropagation();
              pickWire(w.id);
            }}
            onPointerOver={() => {
              document.body.style.cursor = 'pointer';
            }}
            onPointerOut={() => {
              document.body.style.cursor = '';
            }}
          />
        );
      })}
    </>
  );
}
