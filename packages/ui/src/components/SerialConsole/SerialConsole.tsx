// PRD: §F-SER-1 — UART0 console.
import { useEffect } from 'react';
import { bridge } from '../../ipc/bridge';
import { useSimulationStore } from '../../store/simulationStore';

export function SerialConsole() {
  const uart = useSimulationStore((s) => s.uart);

  useEffect(() => {
    // sim:uart push channel (Bridge -> UI via preload, PRD §6.6).
    const unsubUart = bridge.sim.onUart((s) => useSimulationStore.getState().appendUart(s));
    return unsubUart;
  }, []);

  return (
    <div style={{ flex: 1, padding: 8, overflow: 'auto', fontFamily: 'monospace', fontSize: 12, background: '#111', color: '#0f0' }}>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{uart || '[UART0 idle]'}</pre>
    </div>
  );
}
