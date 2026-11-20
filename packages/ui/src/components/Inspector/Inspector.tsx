// PRD: §F-DBG-1..3 — Debug panel (dev-plan task P1.9).
// Attach/detach the debugger, manage breakpoints, step/continue, and inspect
// the stop frame's variables, registers and watched globals. All state lives
// in debuggerStore; this component is a thin view over it.
//
// Restyled to the shared chrome vocabulary (Button/Icon/Select + bb-* tokens):
// this panel used to be raw <button>/<input> with inline styles, so the Debug
// tab looked like a different application from the canvas it debugs. Sections
// now follow the order of a debugging session: connect → run → breakpoints →
// watchpoints → inspect.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useDebuggerStore } from '../../store/debuggerStore';
import { useT, type MessageKey } from '../../i18n';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';

/** Connection phase → localized label (unknown phases fall through verbatim). */
const PHASE_KEYS: Record<string, MessageKey> = {
  detached: 'debug.phase.detached',
  connecting: 'debug.phase.connecting',
  attached: 'debug.phase.attached',
  running: 'debug.phase.running',
};

const PHASE_DOT: Record<string, string> = {
  detached: 'bg-slate-400',
  connecting: 'bg-bb-warn',
  running: 'bg-bb-ok',
  attached: 'bg-bb-primary',
};

const inputCls =
  'h-7 min-w-0 flex-1 rounded border border-bb-line bg-white px-2 font-mono text-xs text-bb-ink placeholder:font-sans placeholder:text-bb-muted focus:border-bb-primary focus:outline-none disabled:bg-slate-100';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-bb-muted">{title}</h4>
      {children}
    </section>
  );
}

/** A removable row (breakpoint / watchpoint / watch). */
function Row({ text, onRemove, removeLabel }: { text: string; onRemove: () => void; removeLabel: string }) {
  return (
    <div className="group flex items-center gap-1.5 rounded border border-bb-line bg-white px-2 py-1">
      <span className="truncate font-mono text-[11px] text-bb-ink" title={text}>{text}</span>
      <button
        type="button"
        title={removeLabel}
        aria-label={removeLabel}
        onClick={onRemove}
        className="ml-auto cursor-pointer rounded border-0 bg-transparent p-0.5 text-bb-muted opacity-60 transition-opacity hover:bg-red-50 hover:text-bb-danger group-hover:opacity-100"
      >
        <Icon name="trash" size={12} />
      </button>
    </div>
  );
}

export function Inspector() {
  const dbg = useDebuggerStore();
  const t = useT();
  const [at, setAt] = useState('app_main');
  const [cond, setCond] = useState('');
  const [watchExpr, setWatchExpr] = useState('');
  const [wpExpr, setWpExpr] = useState('');
  const [wpMode, setWpMode] = useState<'write' | 'read' | 'access'>('write');

  const canRun = dbg.phase === 'attached';
  const detached = dbg.phase === 'detached';
  const phaseKey = PHASE_KEYS[dbg.phase];
  const phaseLabel = phaseKey === undefined ? dbg.phase : t(phaseKey);

  return (
    <div className="flex flex-col gap-3.5 p-3">
      {/* Connection: one row that answers "am I attached?" and offers the action. */}
      <div className="flex items-center justify-between gap-2 rounded-md border border-bb-line bg-slate-50 px-2 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-bb-ink">
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOT[dbg.phase] ?? 'bg-slate-400'}`} />
          <span className="truncate">{phaseLabel}</span>
        </span>
        {detached ? (
          <Button variant="primary" onClick={() => dbg.connect()}>
            <Icon name="link" size={12} />
            {t('debug.attach')}
          </Button>
        ) : (
          <Button onClick={() => dbg.disconnect()}>
            <Icon name="unlink" size={12} />
            {t('debug.detach')}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <Button className="flex-1" variant="primary" disabled={!canRun} onClick={() => dbg.run()}>
          <Icon name="play" size={10} />
          {t('debug.continue')}
        </Button>
        <Button className="flex-1" disabled={!canRun} onClick={() => dbg.step()}>
          {t('debug.stepIn')}
        </Button>
        <Button className="flex-1" disabled={!canRun} onClick={() => dbg.stepOver()}>
          {t('debug.stepOver')}
        </Button>
      </div>

      {dbg.stop && (
        <div className="rounded border border-blue-200 bg-blue-50 px-2 py-1.5 font-mono text-[11px] leading-4 text-blue-900">
          {t('debug.stopped', {
            info: `${dbg.stop.reason ?? '?'} @ ${dbg.stop.frame?.func ?? dbg.stop.frame?.addr ?? '?'}`,
          })}
        </div>
      )}
      {dbg.error && (
        <div className="flex items-start gap-1.5 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
          <Icon name="alert" size={12} className="mt-px shrink-0" />
          <span className="break-words">{dbg.error}</span>
        </div>
      )}

      <Section title={t('debug.breakpoints')}>
        <div className="flex items-center gap-1.5">
          <input
            className={inputCls}
            value={at}
            spellCheck={false}
            onChange={(e) => setAt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !detached) dbg.addBreakpoint(at);
            }}
          />
          <Button disabled={detached} onClick={() => dbg.addBreakpoint(at)}>{t('debug.set')}</Button>
          {dbg.breakpoints.length > 0 && (
            <Button variant="ghost" onClick={() => dbg.clearBreakpoints()}>{t('debug.clear')}</Button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            className={inputCls}
            value={cond}
            placeholder={t('debug.condPlaceholder')}
            onChange={(e) => setCond(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !detached && cond.trim() !== '') {
                void dbg.addConditionalBreakpoint(at, cond);
                setCond('');
              }
            }}
          />
          <Button
            disabled={detached || cond.trim() === ''}
            onClick={() => { void dbg.addConditionalBreakpoint(at, cond); setCond(''); }}
          >
            {t('debug.if')}
          </Button>
        </div>
        {dbg.breakpoints.map((bp) => (
          <Row
            key={bp.id}
            removeLabel={t('common.delete')}
            onRemove={() => dbg.removeBreakpoint(bp.id)}
            text={`#${bp.id} ${bp.kind === 'watchpoint' ? 'watch' : 'bp'} ${bp.location ?? ''} ${bp.address ?? ''}${
              bp.cond !== null ? ` if (${bp.cond})` : ''
            }`.replace(/\s+/g, ' ').trim()}
          />
        ))}
      </Section>

      <Section title={t('debug.watchpoints')}>
        <div className="flex items-center gap-1.5">
          <input
            className={inputCls}
            value={wpExpr}
            placeholder="led_state"
            spellCheck={false}
            onChange={(e) => setWpExpr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !detached && wpExpr.trim() !== '') {
                void dbg.addWatchpoint(wpExpr, wpMode);
                setWpExpr('');
              }
            }}
          />
          <Select value={wpMode} onChange={(e) => setWpMode(e.target.value as 'write' | 'read' | 'access')}>
            <option value="write">write</option>
            <option value="read">read</option>
            <option value="access">access</option>
          </Select>
          <Button
            disabled={detached || wpExpr.trim() === ''}
            onClick={() => { void dbg.addWatchpoint(wpExpr, wpMode); setWpExpr(''); }}
          >
            {t('debug.add')}
          </Button>
        </div>
      </Section>

      <Section title={t('debug.watch')}>
        <div className="flex items-center gap-1.5">
          <input
            className={inputCls}
            value={watchExpr}
            placeholder="led_state"
            spellCheck={false}
            onChange={(e) => setWatchExpr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !detached) {
                void dbg.addWatch(watchExpr);
                setWatchExpr('');
              }
            }}
          />
          <Button
            disabled={detached}
            onClick={() => { void dbg.addWatch(watchExpr); setWatchExpr(''); }}
          >
            {t('debug.add')}
          </Button>
        </div>
        {dbg.watches.map((w) => (
          <Row
            key={w.expr}
            removeLabel={t('common.delete')}
            onRemove={() => dbg.removeWatch(w.expr)}
            text={`${w.expr} = ${w.value ?? '?'}`}
          />
        ))}
      </Section>

      <Section title={t('debug.variables')}>
        {dbg.vars.length === 0 ? (
          <span className="text-[11px] text-bb-muted">{t('debug.noFrame')}</span>
        ) : (
          <div className="overflow-hidden rounded border border-bb-line">
            {dbg.vars.map((v, i) => (
              <div
                key={v.name}
                className={`flex items-baseline gap-2 px-2 py-1 text-[11px] ${i % 2 === 1 ? 'bg-slate-50' : 'bg-white'}`}
              >
                <span className="min-w-0 truncate font-mono text-bb-ink" title={v.name}>
                  {v.name}
                  {v.scope === 'arg' && <span className="ml-1 font-sans text-bb-muted">arg</span>}
                </span>
                <span className="ml-auto shrink-0 font-mono text-bb-muted">{v.value ?? '…'}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('debug.registers')}>
        <pre className="m-0 max-h-40 overflow-auto rounded border border-bb-line bg-slate-50 p-2 font-mono text-[11px] leading-4 text-bb-ink">
          {Object.entries(dbg.regs).map(([name, value]) => `${name} = ${value}`).join('\n') || '—'}
        </pre>
      </Section>
    </div>
  );
}
