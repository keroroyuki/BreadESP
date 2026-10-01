// PRD: §4, §F-BB — Top-level layout. One TopBar row over a main row of three
// columns (palette+catalog | breadboard canvas | right panel), with the
// collapsible BottomDock beneath and a global ToastHost overlay.
import { useEffect } from 'react';
import type { RenderSnapshot } from '@breadesp/peripherals';
import { useSimulationStore } from './store/simulationStore';
import { sharedBuzzerEngine, toneFromSnapshot } from './audio/BuzzerAudio';
import { audioFromSnapshot, sharedSpeakerEngine } from './audio/SpeakerAudio';
import { useProjectStore } from './store/projectStore';
import { useDebuggerStore } from './store/debuggerStore';
import { useCaptureStore } from './store/captureStore';
import { bridge } from './ipc/bridge';
import { BreadboardCanvas } from './components/Breadboard/BreadboardCanvas';
import { Palette } from './components/Palette/Palette';
import { Marketplace } from './components/Marketplace/Marketplace';
import { RightPanel } from './components/RightPanel/RightPanel';
import { TopBar } from './components/TopBar/TopBar';
import { BottomDock } from './components/BottomDock/BottomDock';
import { ToastHost } from './components/Toast/ToastHost';

export function App() {
  const netlist = useProjectStore((s) => s.netlist);

  useEffect(() => {
    // Subscribe to peripheral snapshots (Bridge -> UI).
    const unsubSnap = bridge.per.onSnapshot((s) => useSimulationStore.getState().applySnapshot(s as never));
    const unsubStatus = bridge.sim.onStatus((s) => useSimulationStore.getState().setStatus(s as never));
    // P2.6 (PRD §F-SIM-2): authoritative speed changes pushed by the Bridge.
    const unsubSpeed = bridge.sim.onSpeed((f) => useSimulationStore.getState().setSpeed(f));
    // Debugger pushes (dev-plan task P1.9): async stops refresh the panel.
    const unsubStopped = bridge.dbg.onStopped((info) => useDebuggerStore.getState().onStop(info));
    const unsubRunning = bridge.dbg.onRunning(() => useDebuggerStore.getState().onRunning());
    const unsubExit = bridge.dbg.onExit((code) => useDebuggerStore.getState().onExit(code));
    return () => { unsubSnap(); unsubStatus(); unsubSpeed(); unsubStopped(); unsubRunning(); unsubExit(); };
  }, []);

  useEffect(() => {
    // UI edits the netlist -> Bridge rebuilds peripheral instances + routing
    // (PRD §4.2 steps 1-2). Moving nodes only changes the layout, so this
    // effect does not re-fire on drag (F-BB-4 separation).
    bridge.bb.applyNetlist(netlist).catch((err) => {
      console.error('[BB-UI] applyNetlist failed:', err);
    });
    // P3.2: a mic instance removed from the netlist must stop capturing —
    // otherwise its getUserMedia stream would keep the host mic open.
    useCaptureStore.getState().reconcile(new Set(netlist.peripherals.map((p) => p.instanceId)));
  }, [netlist]);

  // Buzzer + speaker audio (dev-plan tasks P2.3/P2.4): 'tone' snapshots
  // addressed at buzzer instances drive WebAudio square-wave voices, 'audio'
  // snapshots addressed at speaker instances queue PCM for playback.
  // Subscribing to the raw store (not React state) keeps audio latency off
  // the render path.
  useEffect(() => {
    const buzzerEngine = sharedBuzzerEngine();
    const speakerEngine = sharedSpeakerEngine();
    const kindOf = (instanceId: string): string | undefined =>
      useProjectStore.getState().netlist.peripherals.find(
        (p) => p.instanceId === instanceId,
      )?.kind;
    const apply = (snap: RenderSnapshot): void => {
      const kind = kindOf(snap.instanceId);
      if (kind === 'buzzer') buzzerEngine.update(snap.instanceId, toneFromSnapshot(snap));
      else if (kind === 'speaker') speakerEngine.push(snap.instanceId, audioFromSnapshot(snap));
    };
    const unsub = useSimulationStore.subscribe((state, prev) => {
      if (state.snapshots === prev.snapshots) return;
      for (const [id, snap] of Object.entries(state.snapshots)) {
        if (prev.snapshots[id] !== snap) apply(snap);
      }
    });
    return () => {
      unsub();
      buzzerEngine.dispose();
      speakerEngine.dispose();
    };
  }, []);

  return (
    <div style={layout}>
      {/* T3.2/T3.7: one TopBar row replaces the header + three stacked toolbars. */}
      <TopBar />
      <div style={main}>
        <div style={leftCol}>
          <Palette />
          <Marketplace />
        </div>
        <BreadboardCanvas />
        {/* T4.4: right column = Properties / Debug tabs (Inspector inside). */}
        <RightPanel />
      </div>
      {/* T3.6: toggleable, collapsible dock hosts the four instrument panels. */}
      <BottomDock />
      <ToastHost />
    </div>
  );
}

const layout: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' };
const main: React.CSSProperties = { display: 'flex', flex: 1, minHeight: 0 };
// P5.2: the left column stacks the palette over the local peripheral catalog.
const leftCol: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 200,
  minHeight: 0,
  borderRight: '1px solid #ccc',
};
