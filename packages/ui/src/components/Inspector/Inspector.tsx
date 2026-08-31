// PRD: §F-DBG-1..3 — Debug panel (dev-plan task P1.9).
// Attach/detach the debugger, manage breakpoints, step/continue, and inspect
// the stop frame's variables, registers and watched globals. All state lives
// in debuggerStore; this component is a thin view over it.
import { useState } from 'react';
import { useDebuggerStore } from '../../store/debuggerStore';

export function Inspector() {
  const dbg = useDebuggerStore();
  const [at, setAt] = useState('app_main');
  const [watchExpr, setWatchExpr] = useState('');

  const canRun = dbg.phase === 'attached';
  return (
    <aside style={{ width: 280, borderLeft: '1px solid #ccc', padding: 8, overflow: 'auto' }}>
      <h3 style={h3}>Debug</h3>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        {dbg.phase === 'detached' ? (
          <button onClick={() => dbg.connect()}>Attach</button>
        ) : (
          <button onClick={() => dbg.disconnect()}>Detach</button>
        )}
        <span style={muted}>{dbg.phase}</span>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button disabled={!canRun} onClick={() => dbg.run()}>Continue</button>
        <button disabled={!canRun} onClick={() => dbg.step()}>Step In</button>
        <button disabled={!canRun} onClick={() => dbg.stepOver()}>Step Over</button>
      </div>

      {dbg.stop && (
        <div style={muted}>
          stopped: {dbg.stop.reason ?? '?'} @ {dbg.stop.frame?.func ?? dbg.stop.frame?.addr ?? '?'}
        </div>
      )}
      {dbg.error && <div style={err}>{dbg.error}</div>}

      <label style={label}>Breakpoints</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <input value={at} onChange={(e) => setAt(e.target.value)} style={input} />
        <button disabled={dbg.phase === 'detached'} onClick={() => dbg.addBreakpoint(at)}>Set</button>
        {dbg.breakpoints.length > 0 && <button onClick={() => dbg.clearBreakpoints()}>Clear</button>}
      </div>
      {dbg.breakpoints.map((bp) => (
        <div key={bp.id} style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
          <span style={muted}>#{bp.id} {bp.location ?? ''} {bp.address ?? ''}</span>
          <button style={delBtn} onClick={() => dbg.removeBreakpoint(bp.id)}>x</button>
        </div>
      ))}

      <label style={label}>Watch (globals/expressions)</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <input
          value={watchExpr}
          placeholder="led_state"
          onChange={(e) => setWatchExpr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dbg.phase !== 'detached') { void dbg.addWatch(watchExpr); setWatchExpr(''); }
          }}
          style={input}
        />
        <button
          disabled={dbg.phase === 'detached'}
          onClick={() => { void dbg.addWatch(watchExpr); setWatchExpr(''); }}
        >
          Add
        </button>
      </div>
      {dbg.watches.map((w) => (
        <div key={w.expr} style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
          <span style={muted}>{w.expr} = {w.value ?? '?'}</span>
          <button style={delBtn} onClick={() => dbg.removeWatch(w.expr)}>x</button>
        </div>
      ))}

      <label style={label}>Variables</label>
      {dbg.vars.length === 0 && <div style={muted}>(no frame)</div>}
      {dbg.vars.map((v) => (
        <div key={v.name} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{v.name}{v.scope === 'arg' ? ' (arg)' : ''}</span>
          <span style={muted}>{v.value ?? '…'}</span>
        </div>
      ))}

      <label style={label}>Registers</label>
      <div style={pre}>
        {Object.entries(dbg.regs).map(([name, value]) => `${name} = ${value}`).join('\n')}
      </div>
    </aside>
  );
}

const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 13 };
const label: React.CSSProperties = { display: 'block', fontSize: 11, color: '#666', margin: '10px 0 4px' };
const input: React.CSSProperties = { flex: 1, padding: 4, minWidth: 0 };
const muted: React.CSSProperties = { color: '#666', fontSize: 12 };
const err: React.CSSProperties = { color: '#b91c1c', fontSize: 11, margin: '4px 0' };
const pre: React.CSSProperties = { fontSize: 11, background: '#f3f4f6', padding: 6, margin: 0, whiteSpace: 'pre' };
const delBtn: React.CSSProperties = { marginLeft: 'auto', padding: '0 6px', fontSize: 11 };
