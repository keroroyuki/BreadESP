// PRD: §F-SER-1 — UART0 console.
import { useEffect } from 'react';
import { bridge } from '../../ipc/bridge';
import { useSimulationStore } from '../../store/simulationStore';

export function SerialConsole() {
  const uart = useSimulationStore((s) => s.uart);
  const appendUart = useSimulationStore((s) => s.appendUart);

  useEffect(() => {
    // sim:uart is sent from Bridge as a custom event; we reuse the ipcRenderer 'on' via preload?
    // Preload doesn't expose uart subscribe yet; TODO(PRD §F-SER-2): add sim:onUart in preload.
    // For now, appendUart is called from a future uart subscriber.
    void appendUart;
  }, [appendUart]);

  return (
    <div style={{ flex: 1, padding: 8, overflow: 'auto', fontFamily: 'monospace', fontSize: 12, background: '#111', color: '#0f0' }}>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{uart || '[UART0 idle]'}</pre>
    </div>
  );
}

// Wires the uart event from Bridge to the store. Called once at app start.
export function attachUartForwarder(): void {
  const ipc = (window as unknown as { require?: (m: string) => { ipcRenderer: { on: (c: string, cb: (e: unknown, s: string) => void) => void } } });
  // In Electron with contextIsolation the renderer cannot require('electron'); UART forwarding
  // should be added to preload as sim:onUart. This stub is a placeholder until preload is extended.
  void ipc; void bridge;
}
