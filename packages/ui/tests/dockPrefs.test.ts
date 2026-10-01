// T3.6 — dock visibility contract: parse/serialize round-trip, tolerance for
// unknown/duplicate ids, canonical reordering on toggle, default view.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DOCK_VISIBLE,
  DOCK_PANEL_ORDER,
  parseDockVisible,
  serializeDockVisible,
  toggleDockPanel,
  type DockPanelId,
} from '../src/components/BottomDock/dockPrefs';

describe('parseDockVisible', () => {
  it('returns the default view for a null (first run)', () => {
    expect(parseDockVisible(null)).toEqual([...DEFAULT_DOCK_VISIBLE]);
  });

  it('returns an empty dock for an empty string (user hid everything)', () => {
    expect(parseDockVisible('')).toEqual([]);
  });

  it('round-trips a serialized list', () => {
    const visible: DockPanelId[] = ['serial', 'screen'];
    expect(parseDockVisible(serializeDockVisible(visible))).toEqual(visible);
  });

  it('drops unknown ids instead of throwing', () => {
    expect(parseDockVisible('serial,vt100,scope')).toEqual(['serial', 'scope']);
  });

  it('deduplicates and normalizes to the canonical order', () => {
    expect(parseDockVisible('scope,scope,serial')).toEqual(['serial', 'scope']);
  });
});

describe('toggleDockPanel', () => {
  it('removes a visible panel', () => {
    expect(toggleDockPanel(['serial', 'scope'], 'scope')).toEqual(['serial']);
  });

  it('adds an invisible panel at its canonical position', () => {
    // 'screen' sits between 'scope' and 'wavegen' in the canonical order.
    expect(toggleDockPanel(['serial', 'wavegen'], 'screen')).toEqual(['serial', 'screen', 'wavegen']);
  });

  it('toggling the last panel off yields an empty dock', () => {
    expect(toggleDockPanel(['serial'], 'serial')).toEqual([]);
  });

  it('double toggle restores the original list', () => {
    const start: DockPanelId[] = ['serial', 'scope'];
    const once = toggleDockPanel(start, 'wavegen');
    const twice = toggleDockPanel(once, 'wavegen');
    expect(twice).toEqual(start);
  });
});

describe('constants', () => {
  it('the default view only contains known panels in canonical order', () => {
    expect(DEFAULT_DOCK_VISIBLE.every((id) => DOCK_PANEL_ORDER.includes(id))).toBe(true);
    const positions = DEFAULT_DOCK_VISIBLE.map((id) => DOCK_PANEL_ORDER.indexOf(id));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
