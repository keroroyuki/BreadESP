// PRD: §4, §F-BB — Top-level layout. Three columns: palette | breadboard | inspector.
import { useEffect } from 'react';
import { useSimulationStore } from './store/simulationStore';
import { useProjectStore } from './store/projectStore';
import { bridge } from './ipc/bridge';
import { BreadboardCanvas } from './components/Breadboard/BreadboardCanvas';
import { Palette } from './components/Palette/Palette';
import { Inspector } from './components/Inspector/Inspector';
import { ProjectToolbar } from './components/ProjectToolbar/ProjectToolbar';
import { SerialConsole } from './components/SerialConsole/SerialConsole';
import { ScreenView } from './components/ScreenView/ScreenView';

export function App() {
  const status = useSimulationStore((s) => s.status);
  const netlist = useProjectStore((s) => s.netlist);

  useEffect(() => {
    // Subscribe to peripheral snapshots (Bridge -> UI).
    const unsubSnap = bridge.per.onSnapshot((s) => useSimulationStore.getState().applySnapshot(s as never));
    const unsubStatus = bridge.sim.onStatus((s) => useSimulationStore.getState().setStatus(s as never));
    return () => { unsubSnap(); unsubStatus(); };
  }, []);

  useEffect(() => {
    // UI edits the netlist -> Bridge rebuilds peripheral instances + routing
    // (PRD §4.2 steps 1-2). Moving nodes only changes the layout, so this
    // effect does not re-fire on drag (F-BB-4 separation).
    bridge.bb.applyNetlist(netlist).catch((err) => {
      console.error('[BB-UI] applyNetlist failed:', err);
    });
  }, [netlist]);

  return (
    <div style={layout}>
      <header style={header}>
        <strong>BreadESP</strong>
        <span style={{ marginLeft: 12 }}>sim: {status}</span>
      </header>
      <ProjectToolbar />
      <div style={main}>
        <Palette />
        <BreadboardCanvas />
        <Inspector />
      </div>
      <div style={bottom}>
        <SerialConsole />
        <ScreenView />
      </div>
    </div>
  );
}

const layout: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' };
const header: React.CSSProperties = { padding: 8, borderBottom: '1px solid #ccc', background: '#1f2937', color: '#fff' };
const main: React.CSSProperties = { display: 'flex', flex: 1, minHeight: 0 };
const bottom: React.CSSProperties = { display: 'flex', height: 220, borderTop: '1px solid #ccc' };
