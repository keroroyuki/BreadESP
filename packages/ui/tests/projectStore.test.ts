// PRD: §F-BB-4, §F-PROJ-1, §F-BB-5 — netlist/layout separation invariants of the
// UI store, plus the undo/redo history contract. Wiring edits must never touch
// the visual half; moves must never touch the logic half; both serialize
// independently (netlist.json / layout.json). Undo/redo snapshots both halves
// and MUST retain at least 20 steps (F-BB-5).
import { describe, it, expect, beforeEach } from 'vitest';
import { MCU_INSTANCE_ID, validateNetlist, type LayoutFile, type Netlist } from '@breadesp/netlist';
import { UNDO_LIMIT, toLayoutFile, toNetlistFile, useProjectStore } from '../src/store/projectStore';

const emptyNetlist = (): Netlist => ({ version: 1, chip: 'esp32', peripherals: [], wires: [] });

const reset = (): void => {
  // Full reset incl. P4.3 external-firmware state so tests never leak it.
  useProjectStore.getState().resetProject(null);
};

describe('projectStore', () => {
  beforeEach(reset);

  it('places a dropped peripheral in both netlist and layout with a deterministic id', () => {
    const id = useProjectStore.getState().addPeripheral('led', 10, 20);
    const { netlist, layout } = useProjectStore.getState();
    expect(id).toBe('led-1');
    expect(netlist.peripherals).toEqual([{ instanceId: 'led-1', kind: 'led' }]);
    expect(layout).toEqual([{ instanceId: 'led-1', x: 10, y: 20, kind: 'led' }]);
  });

  it('skips ids already used by a loaded project', () => {
    useProjectStore.getState().setNetlist({
      version: 1,
      chip: 'esp32',
      peripherals: [{ instanceId: 'led-1', kind: 'led' }],
      wires: [],
    });
    const id = useProjectStore.getState().addPeripheral('led', 0, 0);
    expect(id).toBe('led-2');
  });

  it('moving an instance changes only the layout (netlist object untouched)', () => {
    useProjectStore.getState().addPeripheral('led', 10, 20);
    const netlistBefore = useProjectStore.getState().netlist;
    useProjectStore.getState().movePeripheral('led-1', 300, 200);
    const { netlist, layout } = useProjectStore.getState();
    expect(netlist).toBe(netlistBefore); // identity preserved: no logic edit happened
    expect(layout[0]).toEqual({ instanceId: 'led-1', x: 300, y: 200, kind: 'led' });
  });

  it('wiring changes only the netlist (layout array untouched)', () => {
    useProjectStore.getState().addPeripheral('led', 10, 20);
    const layoutBefore = useProjectStore.getState().layout;
    const id = useProjectStore.getState().addWire(
      { instanceId: 'led-1', pin: 'A' },
      { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' },
    );
    const { netlist, layout } = useProjectStore.getState();
    expect(id).toBe('wire-1');
    expect(layout).toBe(layoutBefore); // identity preserved: no visual edit happened
    expect(netlist.wires).toEqual([
      {
        id: 'wire-1',
        from: { instanceId: 'led-1', pin: 'A' },
        to: { instanceId: 'mcu', pin: 'GPIO2' },
      },
    ]);
  });

  it('rejects self-loop and duplicate wires (in both endpoint orders)', () => {
    const st = useProjectStore.getState();
    st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' });
    expect(st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' })).toBeNull();
    expect(st.addWire({ instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' }, { instanceId: 'led-1', pin: 'A' })).toBeNull();
    expect(st.addWire({ instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' })).toBeNull();
    expect(useProjectStore.getState().netlist.wires).toHaveLength(1);
  });

  it('removing a wire touches only the netlist', () => {
    const st = useProjectStore.getState();
    st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' });
    st.addWire({ instanceId: 'led-1', pin: 'K' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO4' });
    useProjectStore.getState().removeWire('wire-1');
    const { netlist } = useProjectStore.getState();
    expect(netlist.wires.map((w) => w.id)).toEqual(['wire-2']);
  });

  it('removing an instance also removes its wires so the netlist stays valid', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('led', 0, 0);
    st.addPeripheral('button', 100, 0);
    st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' });
    st.addWire({ instanceId: 'button-1', pin: '1' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO4' });
    useProjectStore.getState().removePeripheral('led-1');
    const { netlist, layout } = useProjectStore.getState();
    expect(netlist.peripherals.map((p) => p.instanceId)).toEqual(['button-1']);
    expect(netlist.wires.map((w) => w.id)).toEqual(['wire-2']);
    expect(layout.map((l) => l.instanceId)).toEqual(['button-1']);
    expect(validateNetlist(netlist).ok).toBe(true);
  });

  it('keeps the netlist valid through a full edit sequence', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('led', 0, 0);
    st.addPeripheral('button', 100, 0);
    st.addPeripheral('ssd1306', 200, 0);
    st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' });
    st.addWire({ instanceId: 'button-1', pin: '1' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO4' });
    st.addWire({ instanceId: 'ssd1306-1', pin: 'SDA' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO21' });
    st.movePeripheral('led-1', 55, 66);
    st.removePeripheral('button-1');
    const { ok, issues } = validateNetlist(useProjectStore.getState().netlist);
    expect(ok).toBe(true);
    expect(issues).toEqual([]);
  });

  it('serializes the netlist and layout as disjoint halves', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('led', 10, 20);
    st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' });
    const net = toNetlistFile(useProjectStore.getState().netlist);
    const lay = toLayoutFile(useProjectStore.getState().layout);
    // Logic half carries wiring only — never coordinates.
    expect(JSON.stringify(net)).not.toContain('"x":');
    expect(JSON.stringify(net)).not.toContain('"y":');
    // Visual half carries positions only — never wires or peripheral logic.
    expect(JSON.stringify(lay)).not.toContain('"wires"');
    expect(JSON.stringify(lay)).not.toContain('"peripherals"');
    expect(lay.items).toEqual([{ instanceId: 'led-1', x: 10, y: 20, kind: 'led' }]);
    // Both halves round-trip through JSON (IPC / persistence boundary, PRD §6.6).
    expect(JSON.parse(JSON.stringify(net))).toEqual(useProjectStore.getState().netlist);
    expect(JSON.parse(JSON.stringify(lay))).toEqual(lay);
  });
});

describe('projectStore.updatePeripheralProps (P3.3, PRD §F-PER-7)', () => {
  beforeEach(reset);

  it('merges a props patch into the instance, preserving existing props', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('mic', 0, 0);
    st.updatePeripheralProps('mic-1', { bus: 1 });
    st.updatePeripheralProps('mic-1', { waveform: 'square', freqHz: 880 });
    const per = useProjectStore.getState().netlist.peripherals[0];
    expect(per.props).toEqual({ bus: 1, waveform: 'square', freqHz: 880 });
  });

  it('is a logic-only edit: layout identity untouched, netlist stays valid', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('mic', 10, 20);
    const layoutBefore = useProjectStore.getState().layout;
    st.updatePeripheralProps('mic-1', { waveform: 'noise', amplitude: 0.7 });
    const { netlist, layout } = useProjectStore.getState();
    expect(layout).toBe(layoutBefore); // identity preserved: no visual edit happened
    expect(validateNetlist(netlist).ok).toBe(true);
  });

  it('ignores unknown instanceIds (netlist identity unchanged)', () => {
    useProjectStore.getState().addPeripheral('mic', 0, 0);
    const netlistBefore = useProjectStore.getState().netlist;
    useProjectStore.getState().updatePeripheralProps('mic-99', { waveform: 'noise' });
    expect(useProjectStore.getState().netlist).toBe(netlistBefore);
  });

  it('props persist through the netlist serialization half', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('mic', 0, 0);
    st.updatePeripheralProps('mic-1', { waveform: 'square', freqHz: 880, sampleRate: 44100, bits: 24, channels: 2 });
    const net = toNetlistFile(useProjectStore.getState().netlist);
    const roundTripped = JSON.parse(JSON.stringify(net)) as Netlist;
    expect(roundTripped.peripherals[0].props).toEqual({
      waveform: 'square', freqHz: 880, sampleRate: 44100, bits: 24, channels: 2,
    });
  });
});

describe('project load/reset (P1.8)', () => {
  beforeEach(reset);

  const LOADED_NETLIST: Netlist = {
    version: 1,
    chip: 'esp32',
    peripherals: [
      { instanceId: 'led-1', kind: 'led' },
      { instanceId: 'ssd1306-1', kind: 'ssd1306' },
    ],
    wires: [{ id: 'wire-1', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'led-1', pin: 'A' } }],
  };
  const LOADED_LAYOUT: LayoutFile = {
    version: 1,
    items: [
      { instanceId: 'led-1', x: 30, y: 40, kind: 'led' },
      { instanceId: 'ssd1306-1', x: 210, y: 90, kind: 'ssd1306' },
    ],
  };

  it('loadProject hydrates dir and both halves without cross-contamination', () => {
    useProjectStore.getState().loadProject({ dir: '/tmp/demo', netlist: LOADED_NETLIST, layout: LOADED_LAYOUT });
    const { dir, netlist, layout } = useProjectStore.getState();
    expect(dir).toBe('/tmp/demo');
    expect(netlist).toEqual(LOADED_NETLIST);
    expect(layout).toEqual(LOADED_LAYOUT.items);
    // The loaded layout file itself is left untouched (store holds items only).
    expect(LOADED_LAYOUT.items).toHaveLength(2);
    expect(validateNetlist(netlist).ok).toBe(true);
  });

  it('editing a loaded project continues from the loaded ids', () => {
    useProjectStore.getState().loadProject({ dir: '/tmp/demo', netlist: LOADED_NETLIST, layout: LOADED_LAYOUT });
    const st = useProjectStore.getState();
    const id = st.addPeripheral('led', 5, 5);
    const wireId = st.addWire({ instanceId: 'ssd1306-1', pin: 'SDA' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO21' });
    expect(id).toBe('led-2'); // loaded led-1 is taken
    expect(wireId).toBe('wire-2'); // loaded wire-1 is taken
    const { netlist, layout } = useProjectStore.getState();
    expect(netlist.peripherals.map((p) => p.instanceId)).toEqual(['led-1', 'ssd1306-1', 'led-2']);
    expect(layout.map((l) => l.instanceId)).toEqual(['led-1', 'ssd1306-1', 'led-2']);
    expect(validateNetlist(netlist).ok).toBe(true);
  });

  it('loaded state serializes back to disk-shaped halves (save round-trip)', () => {
    useProjectStore.getState().loadProject({ dir: '/tmp/demo', netlist: LOADED_NETLIST, layout: LOADED_LAYOUT });
    const { netlist, layout } = useProjectStore.getState();
    const net = toNetlistFile(netlist);
    const lay = toLayoutFile(layout);
    // The exact shapes persisted by ProjectManager.saveProject.
    expect(JSON.parse(JSON.stringify(net))).toEqual(LOADED_NETLIST);
    expect(JSON.parse(JSON.stringify(lay))).toEqual(LOADED_LAYOUT);
    expect(JSON.stringify(net)).not.toContain('"x":');
    expect(JSON.stringify(lay)).not.toContain('"wires"');
  });

  it('resetProject clears both halves and the dir', () => {
    useProjectStore.getState().loadProject({ dir: '/tmp/demo', netlist: LOADED_NETLIST, layout: LOADED_LAYOUT });
    useProjectStore.getState().resetProject(null);
    expect(useProjectStore.getState().dir).toBeNull();
    expect(useProjectStore.getState().netlist).toEqual(emptyNetlist());
    expect(useProjectStore.getState().layout).toEqual([]);
  });

  it('resetProject(dir) points at a fresh skeleton without old state', () => {
    useProjectStore.getState().loadProject({ dir: '/tmp/demo', netlist: LOADED_NETLIST, layout: LOADED_LAYOUT });
    useProjectStore.getState().resetProject('/tmp/fresh');
    expect(useProjectStore.getState().dir).toBe('/tmp/fresh');
    expect(useProjectStore.getState().netlist.peripherals).toEqual([]);
    expect(useProjectStore.getState().netlist.wires).toEqual([]);
    expect(useProjectStore.getState().layout).toEqual([]);
  });
});

describe('projectStore undo/redo (PRD §F-BB-5)', () => {
  beforeEach(reset);

  it('undo walks a mixed edit sequence all the way back to the empty board, staying valid', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('led', 10, 20);
    st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' });
    st.movePeripheral('led-1', 55, 66);
    st.updatePeripheralProps('led-1', { brightness: 0.5 });
    st.removeWire('wire-1');
    st.removePeripheral('led-1');
    expect(useProjectStore.getState().past).toHaveLength(6);

    for (let i = 0; i < 6; i++) {
      useProjectStore.getState().undo();
      const { netlist, layout } = useProjectStore.getState();
      expect(validateNetlist(netlist).ok).toBe(true);
      // The halves stay in lockstep: instance ids appear on both sides or neither.
      expect(netlist.peripherals.map((p) => p.instanceId)).toEqual(layout.map((l) => l.instanceId));
    }
    const { netlist, layout } = useProjectStore.getState();
    expect(netlist).toEqual(emptyNetlist());
    expect(layout).toEqual([]);
  });

  it('redo re-applies undone work; a fresh edit invalidates the redo stack', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('led', 10, 20);
    st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' });
    st.movePeripheral('led-1', 55, 66);

    useProjectStore.getState().undo();
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().layout[0]).toEqual({ instanceId: 'led-1', x: 10, y: 20, kind: 'led' });
    expect(useProjectStore.getState().netlist.wires).toEqual([]);

    useProjectStore.getState().redo();
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().layout[0]).toEqual({ instanceId: 'led-1', x: 55, y: 66, kind: 'led' });
    expect(useProjectStore.getState().netlist.wires).toHaveLength(1);
    expect(useProjectStore.getState().future).toEqual([]);

    // Undo one step, then branch: the new edit must retire the redo future.
    useProjectStore.getState().undo();
    useProjectStore.getState().addPeripheral('button', 0, 0);
    expect(useProjectStore.getState().future).toEqual([]);
    expect(useProjectStore.getState().redo).toBeDefined();
    const layoutBefore = useProjectStore.getState().layout;
    useProjectStore.getState().redo(); // no-op: future is gone
    expect(useProjectStore.getState().layout).toBe(layoutBefore);
  });

  it('retains at least 20 undo steps (F-BB-5): 25 edits -> 20 undos, further undo is a no-op', () => {
    const st = useProjectStore.getState();
    for (let i = 0; i < 25; i++) st.addPeripheral('led', i, 0);
    expect(UNDO_LIMIT).toBeGreaterThanOrEqual(20);
    expect(useProjectStore.getState().past).toHaveLength(UNDO_LIMIT);

    for (let i = 0; i < UNDO_LIMIT; i++) useProjectStore.getState().undo();
    const { netlist, past } = useProjectStore.getState();
    expect(past).toEqual([]);
    // The 25 edits dropped the 5 oldest snapshots: back to the state after edit 5.
    expect(netlist.peripherals).toHaveLength(5);

    const before = useProjectStore.getState().netlist;
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().netlist).toBe(before); // empty stack: identity untouched
  });

  it('coalesces a drag (per-frame moves of one instance) into a single undo step', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('led', 10, 20); // step 1
    st.movePeripheral('led-1', 11, 21); // drag frame 1
    st.movePeripheral('led-1', 12, 22); // drag frame 2
    st.movePeripheral('led-1', 13, 23); // drag frame 3
    expect(useProjectStore.getState().past).toHaveLength(2);

    // Undoing the drag restores the pre-drag position in one step (10, 20).
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().layout[0]).toEqual({ instanceId: 'led-1', x: 10, y: 20, kind: 'led' });

    // A move of a different instance ends the run: two more distinct steps.
    useProjectStore.getState().redo();
    st.movePeripheral('led-1', 40, 40); // new drag on the same instance
    st.addPeripheral('button', 0, 0);
    st.movePeripheral('button-1', 5, 5);
    expect(useProjectStore.getState().past).toHaveLength(5); // 2 + move + place + move
  });

  it('rejected edits (self-loop / duplicate wire, unknown instance) never push history', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('led', 0, 0);
    st.updatePeripheralProps('led-99', { waveform: 'noise' });
    expect(st.addWire({ instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' })).toBeNull();
    st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' });
    expect(st.addWire({ instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' }, { instanceId: 'led-1', pin: 'A' })).toBeNull();
    expect(useProjectStore.getState().past).toHaveLength(2); // place + wire, nothing else
  });

  it('undo and redo are no-ops on empty stacks (state identity untouched)', () => {
    const before = useProjectStore.getState();
    before.undo();
    before.redo();
    const after = useProjectStore.getState();
    expect(after.netlist).toBe(before.netlist);
    expect(after.layout).toBe(before.layout);
    expect(after.past).toEqual([]);
    expect(after.future).toEqual([]);
  });

  it('loading or resetting a project never inherits the previous project history', () => {
    const st = useProjectStore.getState();
    st.addPeripheral('led', 0, 0);
    st.addWire({ instanceId: 'led-1', pin: 'A' }, { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' });
    useProjectStore.getState().undo(); // future now holds one entry
    expect(useProjectStore.getState().future).toHaveLength(1);

    useProjectStore.getState().loadProject({
      dir: '/tmp/other',
      netlist: emptyNetlist(),
      layout: { version: 1, items: [] },
    });
    expect(useProjectStore.getState().past).toEqual([]);
    expect(useProjectStore.getState().future).toEqual([]);
    const netlistBefore = useProjectStore.getState().netlist;
    useProjectStore.getState().undo();
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().netlist).toBe(netlistBefore);

    useProjectStore.getState().resetProject(null);
    expect(useProjectStore.getState().past).toEqual([]);
    expect(useProjectStore.getState().future).toEqual([]);
  });
});

describe('projectStore external firmware state (P4.3, PRD §F-PROJ-3)', () => {
  beforeEach(reset);

  const LINK = { kind: 'platformio' as const, dir: '/tmp/pio-app' };

  it('loadProject hydrates the external link and firmware path when present', () => {
    useProjectStore.getState().loadProject({
      dir: '/tmp/demo',
      netlist: emptyNetlist(),
      layout: { version: 1, items: [] },
      external: LINK,
      firmwareElf: '/tmp/demo/firmware.elf',
    });
    expect(useProjectStore.getState().external).toEqual(LINK);
    expect(useProjectStore.getState().firmwareElf).toBe('/tmp/demo/firmware.elf');
  });

  it('loadProject defaults both to null for pre-P4.3 projects (backward compatible)', () => {
    useProjectStore.getState().setExternal(LINK);
    useProjectStore.getState().setFirmwareElf('/tmp/old/firmware.elf');
    useProjectStore.getState().loadProject({
      dir: '/tmp/demo',
      netlist: emptyNetlist(),
      layout: { version: 1, items: [] },
    });
    expect(useProjectStore.getState().external).toBeNull();
    expect(useProjectStore.getState().firmwareElf).toBeNull();
  });

  it('setExternal/setFirmwareElf track the panel actions; resetProject clears them', () => {
    useProjectStore.getState().setExternal(LINK);
    useProjectStore.getState().setFirmwareElf('/tmp/demo/firmware.elf');
    expect(useProjectStore.getState().external).toEqual(LINK);
    useProjectStore.getState().setExternal(null);
    expect(useProjectStore.getState().external).toBeNull();
    useProjectStore.getState().setExternal(LINK);
    useProjectStore.getState().resetProject(null);
    expect(useProjectStore.getState().external).toBeNull();
    expect(useProjectStore.getState().firmwareElf).toBeNull();
  });
});
