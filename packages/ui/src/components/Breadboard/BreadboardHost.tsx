// Canvas host: renders the 2D Konva editor or the 3D modelled view, plus the mode
// switcher. Extracted from App so the shell keeps rendering one centre column and
// does not need to know which canvas is active.
//
// The 3D canvas is loaded lazily: it is the only consumer of three.js/drei (~1 MB
// minified), so a 2D session never parses or compiles that code, and switching to
// 3D shows the loading placeholder rather than freezing the frame that starts the
// download.
import { lazy, Suspense } from 'react';
import type { CSSProperties } from 'react';
import { useT } from '../../i18n';
import { useViewModeStore } from '../../store/viewModeStore';
import { BreadboardCanvas } from './BreadboardCanvas';
import { ViewModeToggle } from '../Breadboard3D/ViewModeToggle';

const Canvas3D = lazy(async () => {
  const module = await import('../Breadboard3D/Canvas3D');
  return { default: module.Canvas3D };
});

export function BreadboardHost() {
  const mode = useViewModeStore((s) => s.mode);
  const t = useT();
  return (
    <div style={host}>
      {mode === '2d' ? (
        <BreadboardCanvas />
      ) : (
        <Suspense
          fallback={
            <div style={loading} className="flex items-center justify-center text-xs text-bb-muted">
              {t('canvas3d.loading')}
            </div>
          }
        >
          <Canvas3D />
        </Suspense>
      )}
      <ViewModeToggle />
    </div>
  );
}

const host: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  position: 'relative',
};

const loading: CSSProperties = {
  flex: 1,
  minHeight: 0,
  background: '#dfe6ef',
};
