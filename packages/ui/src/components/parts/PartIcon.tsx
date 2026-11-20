// Shared glyph renderer for peripheral kinds. The same 24×24 path drives the
// palette tile, the 2D canvas header and the 3D nameplate, so a part looks the
// same everywhere it appears.
import type { CSSProperties } from 'react';
import { CATEGORY_ACCENT, CATEGORY_TINT, partVisual } from './partVisuals';

export interface PartIconProps {
  kind: string;
  size?: number;
  /** Override the category accent (e.g. muted when disabled). */
  color?: string;
  strokeWidth?: number;
}

export function PartIcon({ kind, size = 18, color, strokeWidth = 1.7 }: PartIconProps) {
  const visual = partVisual(kind);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? CATEGORY_ACCENT[visual.category]}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={visual.icon} />
    </svg>
  );
}

/** Palette tile: rounded, category-tinted square behind the glyph. */
export function PartIconTile({ kind, size = 34 }: { kind: string; size?: number }) {
  const visual = partVisual(kind);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: 9,
    background: CATEGORY_TINT[visual.category],
    border: `1px solid ${CATEGORY_ACCENT[visual.category]}22`,
    color: CATEGORY_ACCENT[visual.category],
  };
  return (
    <span className="flex shrink-0 items-center justify-center" style={style}>
      <PartIcon kind={kind} size={Math.round(size * 0.58)} />
    </span>
  );
}
