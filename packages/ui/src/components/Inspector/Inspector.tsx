// PRD: §F-DBG — Debug panel: breakpoints, step/continue buttons, regs/vars.
import { useState } from 'react';
import { bridge } from '../../ipc/bridge';

export function Inspector() {
  const [at, setAt] = useState('app_main');
  const [bp, setBp] = useState<{ id: number; address: string } | null>(null);
  const [vars, setVars] = useState<Record<string, unknown>>({});
  const [regs, setRegs] = useState<Record<string, unknown>>({});

  return (
    <aside style={{ width: 260, borderLeft: '1px solid #ccc', padding: 8, overflow: 'auto' }}>
      <h3 style={h3}>Debug</h3>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button onClick={() => bridge.dbg.continue()}>Continue</button>
        <button onClick={() => bridge.dbg.step()}>Step</button>
      </div>
      <label style={label}>Breakpoint</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input value={at} onChange={(e) => setAt(e.target.value)} style={input} />
        <button onClick={async () => setBp(await bridge.dbg.setBreakpoint({ at }) as never)}>Set</button>
      </div>
      {bp && <div style={muted}>#{bp.id} @ {bp.address}</div>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button onClick={async () => setVars(await bridge.dbg.vars())}>Vars</button>
        <button onClick={async () => setRegs(await bridge.dbg.regs())}>Regs</button>
      </div>
      <pre style={pre}>{JSON.stringify({ vars, regs }, null, 2)}</pre>
    </aside>
  );
}

const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 13 };
const label: React.CSSProperties = { fontSize: 11, color: '#666' };
const input: React.CSSProperties = { flex: 1, padding: 4 };
const muted: React.CSSProperties = { color: '#666', fontSize: 12 };
const pre: React.CSSProperties = { fontSize: 11, background: '#f3f4f6', padding: 6, margin: 0 };
