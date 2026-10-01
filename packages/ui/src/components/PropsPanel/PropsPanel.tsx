// T4.3 — properties editor for the canvas selection (the RightPanel's
// Properties tab). A selected instance shows its displayName, instanceId and
// a form driven by propsSchema (explicit schemas for the tunable built-ins,
// generic derivation for every registered kind — third-party included).
// Numbers/texts commit on blur or Enter only, so one edit = one undo step
// (F-BB-5 history is not flooded per keystroke); numbers are clamped to the
// schema bounds before they reach the netlist. A kind that is not even
// registered degrades to a read-only JSON view + the pin table; a selected
// wire shows its endpoints with a delete button.
import { useEffect, useState } from 'react';
import { getFactory, registerBuiltins } from '@breadesp/peripherals';
import { useProjectStore } from '../../store/projectStore';
import { useSelectionStore } from '../../store/selectionStore';
import { useT } from '../../i18n';
import { Button } from '../ui/Button';
import { peripheralPins } from '../Breadboard/pinLayout';
import {
  clampNumberField,
  fieldsForInstance,
  type PropFieldView,
} from './propsSchema';

/** Number -> input text; an unset number shows an empty box. */
const numText = (v: unknown): string =>
  typeof v === 'number' ? String(v) : '';

export function PropsPanel() {
  const instanceId = useSelectionStore((s) => s.instanceId);
  const wireId = useSelectionStore((s) => s.wireId);
  const netlist = useProjectStore((s) => s.netlist);
  const updatePeripheralProps = useProjectStore((s) => s.updatePeripheralProps);
  const removeWire = useProjectStore((s) => s.removeWire);
  const selectWire = useSelectionStore((s) => s.selectWire);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const t = useT();

  const instance = instanceId !== null
    ? netlist.peripherals.find((p) => p.instanceId === instanceId) ?? null
    : null;
  const wire = wireId !== null
    ? netlist.wires.find((w) => w.id === wireId) ?? null
    : null;

  // Pending edits belong to one selection; a new pick starts clean.
  useEffect(() => {
    setDraft({});
  }, [instanceId, wireId]);

  /** Commit one field into the instance props (a single history entry). */
  const commit = (field: PropFieldView, raw: string): void => {
    if (instanceId === null) return;
    if (field.type === 'number') {
      const v = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(v)) return; // keep the last valid value
      updatePeripheralProps(instanceId, { [field.key]: clampNumberField(field, v) });
    } else if (field.type === 'select') {
      const isBool = typeof field.value === 'boolean' || typeof field.fallback === 'boolean';
      updatePeripheralProps(instanceId, { [field.key]: isBool ? raw === 'true' : raw });
    } else {
      updatePeripheralProps(instanceId, { [field.key]: raw });
    }
  };

  const clearDraftKey = (key: string): void => {
    setDraft((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  if (instance !== null && instanceId !== null) {
    registerBuiltins();
    const factory = getFactory(instance.kind);
    const fields = fieldsForInstance(instance.kind, instance.props);
    const pins = peripheralPins(instance.kind);
    return (
      <div className="flex flex-col gap-3 p-2 text-xs text-bb-ink">
        <header>
          <div className="text-sm font-semibold">{factory?.displayName ?? instance.kind}</div>
          <div className="font-mono text-[11px] text-bb-muted">{instanceId}</div>
        </header>

        {factory === undefined && (
          <p className="rounded bg-amber-50 border border-amber-200 px-2 py-1 text-bb-muted">
            {t('props.unknownKind')}
          </p>
        )}

        {fields.map((f) => {
          if (f.type === 'select') {
            const current = String(f.value ?? f.fallback ?? f.choices[0]?.value ?? '');
            return (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-bb-muted">{f.label}</span>
                <select
                  className="h-7 rounded border border-bb-line bg-white px-1"
                  value={current}
                  disabled={factory === undefined}
                  onChange={(e) => commit(f, e.target.value)}
                >
                  {f.choices.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </label>
            );
          }
          const shown = draft[f.key] ?? (f.type === 'number'
            ? numText(f.value ?? f.fallback)
            : typeof (f.value ?? f.fallback) === 'string' ? String(f.value ?? f.fallback) : '');
          return (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-bb-muted">{f.label}</span>
              <input
                className="h-7 rounded border border-bb-line bg-white px-2 font-mono focus:border-bb-primary focus:outline-none"
                value={shown}
                spellCheck={false}
                disabled={factory === undefined}
                onChange={(e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value }))}
                onBlur={() => {
                  commit(f, shown);
                  clearDraftKey(f.key);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
            </label>
          );
        })}

        {factory !== undefined && fields.length === 0 && (
          <p className="text-bb-muted">{t('props.noneSelected')}</p>
        )}

        {factory === undefined && instance.props !== undefined && (
          <details>
            <summary className="cursor-pointer text-bb-muted">{t('props.rawProps')}</summary>
            <pre className="mt-1 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px]">
              {JSON.stringify(instance.props, null, 2)}
            </pre>
          </details>
        )}

        <section>
          <h4 className="mb-1 font-semibold">{t('props.pins')}</h4>
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead>
              <tr className="text-bb-muted">
                <th className="border-b border-bb-line text-left font-medium">{t('props.pin')}</th>
                <th className="border-b border-bb-line text-left font-medium">{t('props.role')}</th>
              </tr>
            </thead>
            <tbody>
              {pins.map((p) => (
                <tr key={p.id}>
                  <td className="border-b border-slate-100 py-0.5">{p.id}</td>
                  <td className="border-b border-slate-100 py-0.5">{p.role}</td>
                </tr>
              ))}
              {pins.length === 0 && (
                <tr><td colSpan={2} className="py-0.5 text-bb-muted">—</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    );
  }

  if (wire !== null && wireId !== null) {
    return (
      <div className="flex flex-col gap-2 p-2 text-xs text-bb-ink">
        <header>
          <div className="text-sm font-semibold">{t('props.endpoints')}</div>
          <div className="font-mono text-[11px] text-bb-muted">{wireId}</div>
        </header>
        <div className="rounded border border-bb-line bg-white p-2 font-mono text-[11px]">
          <div>{wire.from.instanceId}.{wire.from.pin}</div>
          <div className="text-bb-muted">↕</div>
          <div>{wire.to.instanceId}.{wire.to.pin}</div>
        </div>
        <Button
          variant="danger"
          onClick={() => {
            removeWire(wireId);
            selectWire(null);
          }}
        >
          {t('common.delete')}
        </Button>
      </div>
    );
  }

  return <p className="p-3 text-xs text-bb-muted">{t('props.noneSelected')}</p>;
}
