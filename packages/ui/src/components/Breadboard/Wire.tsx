// PRD: §F-BB — Wire rendering (visual representation of a Netlist Wire).
// MVP: simple bezier between two instance anchors.
export interface WireProps { x1: number; y1: number; x2: number; y2: number; }
export function wirePath(p: WireProps): string {
  const mx = (p.x1 + p.x2) / 2;
  return `M${p.x1},${p.y1} C${mx},${p.y1} ${mx},${p.y2} ${p.x2},${p.y2}`;
}
