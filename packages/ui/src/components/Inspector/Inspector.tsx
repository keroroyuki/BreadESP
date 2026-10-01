// PRD: §F-DBG-1..3 — Debug panel (dev-plan task P1.9).
// Attach/detach the debugger, manage breakpoints, step/continue, and inspect
// the stop frame's variables, registers and watched globals. All state lives
// in debuggerStore; this component is a thin view over it.
import { useState } from 'react';
import { useDebuggerStore } from '../../store/debuggerStore';
import { useT } from '../../i18n';

export function Inspector() {
  const dbg = useDebuggerStore();
  const t = useT();
  const [at, setAt] = useState('app_main');
  const [cond, setCond] = useState('');
  const [watchExpr, setWatchExpr] = useState('');
  const [wpExpr, setWpExpr] = useState('');
  const [wpMode, setWpMode] = useState<'write' | 'read' | 'access'>('write');

  const canRun = dbg.phase === 'attached';
  // T4.4: the width is owned by the RightPanel column (300px).
  return (
    <aside style={{ width: '100%', borderLeft: '1px solid #ccc', padding: 8, overflow: 'auto' }}>
      <h3 style={h3}>{t('debug.title')}</h3>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        {dbg.phase === 'detached' ? (
          <button onClick={() => dbg.connect()}>{t('debug.attach')}</button>
        ) : (
          <button onClick={() => dbg.disconnect()}>{t('debug.detach')}</button>
        )}
        <span style={muted}>{dbg.phase}</span>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button disabled={!canRun} onClick={() => dbg.run()}>{t('debug.continue')}</button>
        <button disabled={!canRun} onClick={() => dbg.step()}>{t('debug.stepIn')}</button>
        <button disabled={!canRun} onClick={() => dbg.stepOver()}>{t('debug.stepOver')}</button>
      </div>

      {dbg.stop && (
        <div style={muted}>
          {t('debug.stopped', {
            info: `${dbg.stop.reason ?? '?'} @ ${dbg.stop.frame?.func ?? dbg.stop.frame?.addr ?? '?'}`,
          })}
        </div>
      )}
      {dbg.error && <div style={err}>{dbg.error}</div>}

      <label style={label}>{t('debug.breakpoints')}</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <input value={at} onChange={(e) => setAt(e.target.value)} style={input} />
        <button disabled={dbg.phase === 'detached'} onClick={() => dbg.addBreakpoint(at)}>{t('debug.set')}</button>
        {dbg.breakpoints.length > 0 && <button onClick={() => dbg.clearBreakpoints()}>{t('debug.clear')}</button>}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <input
          value={cond}
          placeholder={t('debug.condPlaceholder')}
          onChange={(e) => setCond(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dbg.phase !== 'detached' && cond.trim() !== '') {
              void dbg.addConditionalBreakpoint(at, cond); setCond('');
            }
          }}
          style={input}
        />
        <button
          disabled={dbg.phase === 'detached' || cond.trim() === ''}
          onClick={() => { void dbg.addConditionalBreakpoint(at, cond); setCond(''); }}
        >
          {t('debug.if')}
        </button>
      </div>
      {dbg.breakpoints.map((bp) => (
        <div key={bp.id} style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
          <span style={muted}>
            #{bp.id} {bp.kind === 'watchpoint' ? 'watch' : 'bp'} {bp.location ?? ''} {bp.address ?? ''}
            {bp.cond !== null ? ` if (${bp.cond})` : ''}
          </span>
          <button style={delBtn} onClick={() => dbg.removeBreakpoint(bp.id)}>x</button>
        </div>
      ))}

      <label style={label}>{t('debug.watchpoints')}</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <input
          value={wpExpr}
          placeholder="led_state"
          onChange={(e) => setWpExpr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dbg.phase !== 'detached' && wpExpr.trim() !== '') {
              void dbg.addWatchpoint(wpExpr, wpMode); setWpExpr('');
            }
          }}
          style={input}
        />
        <select value={wpMode} onChange={(e) => setWpMode(e.target.value as 'write' | 'read' | 'access')}>
          <option value="write">write</option>
          <option value="read">read</option>
          <option value="access">access</option>
        </select>
        <button
          disabled={dbg.phase === 'detached' || wpExpr.trim() === ''}
          onClick={() => { void dbg.addWatchpoint(wpExpr, wpMode); setWpExpr(''); }}
        >
          {t('debug.add')}
        </button>
      </div>

      <label style={label}>{t('debug.watch')}</label>
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
          {t('debug.add')}
        </button>
      </div>
      {dbg.watches.map((w) => (
        <div key={w.expr} style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
          <span style={muted}>{w.expr} = {w.value ?? '?'}</span>
          <button style={delBtn} onClick={() => dbg.removeWatch(w.expr)}>x</button>
        </div>
      ))}

      <label style={label}>{t('debug.variables')}</label>
      {dbg.vars.length === 0 && <div style={muted}>{t('debug.noFrame')}</div>}
      {dbg.vars.map((v) => (
        <div key={v.name} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{v.name}{v.scope === 'arg' ? ' (arg)' : ''}</span>
          <span style={muted}>{v.value ?? '…'}</span>
        </div>
      ))}

      <label style={label}>{t('debug.registers')}</label>
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
