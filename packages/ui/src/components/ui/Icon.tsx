// Shared line-icon set — one 24×24 grid, `currentColor`, 1.8 stroke.
//
// Why a component instead of glyphs: the bar used to mix `↶ ↷ ⟲ ▸ ▾ ⌖` with
// three different SVG drawings, so the same control looked different in every
// locale and font (and some glyphs fell back to a serif box). One grid keeps
// optical weight constant wherever an action appears.
import type { CSSProperties } from 'react';

export type IconName =
  | 'undo'
  | 'redo'
  | 'reset'
  | 'folder'
  | 'folderOpen'
  | 'save'
  | 'saveAs'
  | 'close'
  | 'more'
  | 'chevronDown'
  | 'chevronRight'
  | 'play'
  | 'pause'
  | 'plus'
  | 'link'
  | 'unlink'
  | 'import'
  | 'refresh'
  | 'chip'
  | 'sliders'
  | 'trash'
  | 'check'
  | 'alert'
  | 'info';

interface Glyph {
  /** SVG path commands, stroked with `currentColor` unless `filled` is set. */
  paths: string[];
  /** Filled glyphs (transport controls) read better solid at 12–14 px. */
  filled?: boolean;
}

const GLYPHS: Record<IconName, Glyph> = {
  // History: the arrow tail curves back over itself, which reads as "undo"
  // without needing the mirrored variant.
  undo: { paths: ['M4 9.5h9.5a5 5 0 0 1 0 10H9', 'M8 5.5 4 9.5l4 4'] },
  redo: { paths: ['M20 9.5h-9.5a5 5 0 0 0 0 10H15', 'M16 5.5l4 4-4 4'] },
  reset: { paths: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4v4.2h-4.2'] },

  folder: {
    paths: [
      'M3.2 7.6A1.6 1.6 0 0 1 4.8 6h3.6l1.8 2.2h8A1.6 1.6 0 0 1 19.8 9.8v7.6a1.6 1.6 0 0 1-1.6 1.6H4.8a1.6 1.6 0 0 1-1.6-1.6z',
    ],
  },
  folderOpen: {
    paths: [
      'M3.2 7.6A1.6 1.6 0 0 1 4.8 6h3.6l1.8 2.2h7.4a1.6 1.6 0 0 1 1.6 1.6v1.4',
      'M3.2 8.4l1 9.2a1.6 1.6 0 0 0 1.6 1.4h11.4a1.6 1.6 0 0 0 1.6-1.3l1-6.1a1.2 1.2 0 0 0-1.2-1.4H5.6z',
    ],
  },
  save: {
    paths: ['M5.4 4.5h10.4L19.5 8.2v11.3H4.5V4.5z', 'M8 4.5v4.2h6.4', 'M8 19.5v-6h8v6'],
  },
  // Save-as = save + a pencil mark in the corner; distinct at 14 px from save.
  saveAs: {
    paths: [
      'M5.4 4.5h9.6l3.5 3.5v5',
      'M4.5 4.5v15h7',
      'M8 4.5v4.2h6',
      'M20 12.4l-6.2 6.2-2.8.6.6-2.8 6.2-6.2a1.6 1.6 0 0 1 2.2 2.2z',
    ],
  },
  close: { paths: ['M6.4 6.4l11.2 11.2', 'M17.6 6.4 6.4 17.6'] },
  more: { paths: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'] },
  chevronDown: { paths: ['M6.5 9.5 12 15l5.5-5.5'] },
  chevronRight: { paths: ['M9.5 6.5 15 12l-5.5 5.5'] },

  play: { paths: ['M8 5.3v13.4L18.6 12z'], filled: true },
  pause: { paths: ['M7.6 5h3.2v14H7.6z', 'M13.2 5h3.2v14h-3.2z'], filled: true },

  plus: { paths: ['M12 5.2v13.6', 'M5.2 12h13.6'] },
  link: {
    paths: [
      'M10.2 13.8a4.2 4.2 0 0 0 5.9 0l2.1-2.1a4.2 4.2 0 0 0-5.9-5.9l-1.2 1.2',
      'M13.8 10.2a4.2 4.2 0 0 0-5.9 0l-2.1 2.1a4.2 4.2 0 0 0 5.9 5.9l1.2-1.2',
    ],
  },
  unlink: {
    paths: [
      'M9 15l-1.4 1.4a4.2 4.2 0 0 1-5.9-5.9L4 8.2',
      'M15 9l1.4-1.4a4.2 4.2 0 0 1 5.9 5.9L20 15.8',
      'M4 4l16 16',
    ],
  },
  import: { paths: ['M12 4v10.2', 'M7.6 10.4 12 14.8l4.4-4.4', 'M4.5 19.5h15'] },
  refresh: { paths: ['M19.5 12a7.5 7.5 0 1 1-2.6-5.7', 'M19.5 4v4.4h-4.4'] },
  chip: { paths: ['M7 7h10v10H7z', 'M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3'] },
  sliders: { paths: ['M4 8h10M18 8h2M4 16h4M12 16h8', 'M14 5.6v4.8M8 13.6v4.8'] },
  trash: { paths: ['M5 7h14', 'M9.5 7V4.8h5V7', 'M6.6 7l.8 12.4h9.2L17.4 7', 'M10.4 10.6v6M13.6 10.6v6'] },
  check: { paths: ['M5 12.6l4.6 4.6L19 6.4'] },
  alert: { paths: ['M12 4.6 21 19.4H3z', 'M12 10v4.2', 'M12 17h.01'] },
  info: { paths: ['M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8z', 'M12 11v5.4', 'M12 7.8h.01'] },
};

export interface IconProps {
  name: IconName;
  /** Edge length in px (the viewBox is always 24). */
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Icons are decorative by default; pass a label when it carries meaning alone. */
  label?: string;
}

export function Icon({ name, size = 14, className = '', style, label }: IconProps) {
  const glyph = GLYPHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      style={style}
      fill={glyph.filled === true ? 'currentColor' : 'none'}
      stroke={glyph.filled === true ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined}
    >
      {glyph.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
