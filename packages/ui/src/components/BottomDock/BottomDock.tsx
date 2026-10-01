// T3.6 — collapsible bottom dock hosting the four instrument panels
// (dev-plan UI pass). Each panel toggles independently; the whole dock
// collapses to its 28px strip. The hosted panels (SerialConsole /
// Oscilloscope / ScreenView / WaveGen) render zero-change; this component
// only adds the wrapper each one needs: a fixed min-width so a pair never
// squeezes, with horizontal scroll inside the dock when the window is
// narrower than the visible set.
import { useEffect, useState } from 'react';
import { useT, type MessageKey } from '../../i18n';
import {
  DOCK_PANEL_ORDER,
  DOCK_STORAGE_KEY,
  DEFAULT_DOCK_VISIBLE,
  parseDockVisible,
  serializeDockVisible,
  toggleDockPanel,
  type DockPanelId,
} from './dockPrefs';
import { SerialConsole } from '../SerialConsole/SerialConsole';
import { Oscilloscope } from '../Oscilloscope/Oscilloscope';
import { ScreenView } from '../ScreenView/ScreenView';
import { WaveGen } from '../WaveGen/WaveGen';

/** Per-panel floor width (px): the content each panel needs to stay usable. */
const PANEL_MIN_WIDTH: Record<DockPanelId, number> = {
  serial: 360,
  scope: 440,
  screen: 270,
  wavegen: 300,
};

/** Dock content height below the 28px strip (matches the old 220px + strip). */
const CONTENT_HEIGHT = 192;

function readStored(): DockPanelId[] {
  try {
    return parseDockVisible(localStorage.getItem(DOCK_STORAGE_KEY));
  } catch {
    return [...DEFAULT_DOCK_VISIBLE];
  }
}

function writeStored(visible: readonly DockPanelId[]): void {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, serializeDockVisible(visible));
  } catch {
    // A throwing storage (private mode) must not break the dock.
  }
}

export function BottomDock() {
  const [visible, setVisible] = useState<DockPanelId[]>(readStored);
  const [collapsed, setCollapsed] = useState(false);
  const t = useT();

  useEffect(() => {
    writeStored(visible);
  }, [visible]);

  const toggle = (id: DockPanelId): void => setVisible((v) => toggleDockPanel(v, id));

  return (
    <section className="flex shrink-0 flex-col border-t border-bb-line bg-bb-canvas">
      <div className="flex h-7 items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="mr-1 inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs font-medium text-bb-ink cursor-pointer hover:bg-slate-100"
          title={collapsed ? t('dock.expand') : t('dock.collapse')}
        >
          <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
          {collapsed ? t('dock.expand') : t('dock.collapse')}
        </button>
        {DOCK_PANEL_ORDER.map((id) => {
          const labelKey: MessageKey = `dock.${id}`;
          const on = visible.includes(id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(id)}
              className={`inline-flex h-6 items-center rounded border px-2 text-xs cursor-pointer ${
                on
                  ? 'border-bb-primary bg-bb-primary text-white'
                  : 'border-bb-line bg-white text-bb-muted hover:bg-slate-50'
              }`}
            >
              {t(labelKey)}
            </button>
          );
        })}
      </div>
      {!collapsed && (
        <div
          className="flex overflow-x-auto"
          style={{ height: CONTENT_HEIGHT }}
        >
          {visible.map((id) => (
            <div
              key={id}
              className="flex min-w-0 shrink-0 flex-col border-r border-bb-line last:border-r-0"
              style={{ minWidth: PANEL_MIN_WIDTH[id], width: `${100 / Math.max(visible.length, 1)}%` }}
            >
              {id === 'serial' && <SerialConsole />}
              {id === 'scope' && <Oscilloscope />}
              {id === 'screen' && <ScreenView />}
              {id === 'wavegen' && <WaveGen />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
