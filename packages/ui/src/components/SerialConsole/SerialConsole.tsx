// PRD: §F-SER-1, §F-SER-2 — UART0 console: output stream + line input injection.
// T5.1: user-facing strings go through the i18n dictionary.
import { useEffect, useState } from 'react';
import { bridge } from '../../ipc/bridge';
import { useSimulationStore } from '../../store/simulationStore';
import { useT } from '../../i18n';

// uart-echo.elf caps a line at 127 bytes; stay under it so nothing is dropped.
const INPUT_MAX = 120;

/** Statuses under which a QEMU process exists and accepts stdin bytes. */
function sendable(status: string): boolean {
  return status === 'loaded' || status === 'running' || status === 'paused';
}

export function SerialConsole() {
  const uart = useSimulationStore((s) => s.uart);
  const status = useSimulationStore((s) => s.status);
  const [input, setInput] = useState('');
  const t = useT();

  useEffect(() => {
    // sim:uart push channel (Bridge -> UI via preload, PRD §6.6).
    const unsubUart = bridge.sim.onUart((s) => useSimulationStore.getState().appendUart(s));
    return unsubUart;
  }, []);

  // Enter sends (PRD §F-SER-2). LF-only terminator: the Windows stdio backend
  // drops '\r' bytes (char-win-stdio.c), so CRLF would starve line readers.
  const send = () => {
    bridge.sim.sendUart({ data: `${input}\n` }).catch((err) => {
      console.error('[BB-UI] sendUart failed:', err);
    });
    setInput('');
  };

  const canSend = sendable(status);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ flex: 1, padding: 8, overflow: 'auto', fontFamily: 'monospace', fontSize: 12, background: '#111', color: '#0f0' }}>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{uart || t('serial.idle')}</pre>
      </div>
      <div style={{ display: 'flex', padding: 4, background: '#111' }}>
        <input
          style={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 12, background: '#000', color: '#0f0', border: '1px solid #333', padding: '2px 6px' }}
          placeholder={canSend ? t('serial.placeholder') : t('serial.placeholderDisabled')}
          value={input}
          maxLength={INPUT_MAX}
          disabled={!canSend}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button style={{ marginLeft: 4 }} disabled={!canSend} onClick={send}>{t('serial.send')}</button>
      </div>
    </div>
  );
}
