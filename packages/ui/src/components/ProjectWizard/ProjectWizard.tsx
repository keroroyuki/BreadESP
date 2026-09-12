// PRD: §F-PROJ-2 — New-project wizard (dev-plan task P4.2). Modal flow:
// pick a chip (PRD §6.5 ChipKind), pick a template (@breadesp/netlist
// registry), enter the target directory; Create round-trips `proj:new` and
// hydrates the project store from the Bridge-validated ProjectData.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { ChipKind } from '@breadesp/netlist';
import { bridge } from '../../ipc/bridge';
import { useProjectStore } from '../../store/projectStore';
import {
  createWizardDraft,
  draftTemplates,
  patchWizardDraft,
  WIZARD_CHIPS,
  wizardDraftError,
  type WizardDraft,
} from './wizardDraft';

export interface ProjectWizardProps {
  /** Pre-filled directory (carried over from the toolbar input). */
  initialDir: string;
  /** created=true after a successful create, false on cancel. */
  onClose: (created: boolean) => void;
}

export function ProjectWizard({ initialDir, onClose }: ProjectWizardProps) {
  const [draft, setDraft] = useState<WizardDraft>(() => createWizardDraft(initialDir));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (p: Partial<WizardDraft>): void => {
    setDraft((d) => patchWizardDraft(d, p));
    setError(null);
  };

  const draftError = wizardDraftError(draft);

  const onCreate = (): void => {
    if (draftError !== null || busy) return;
    setBusy(true);
    setError(null);
    bridge.proj
      .new({ dir: draft.dir.trim(), chip: draft.chip, template: draft.templateId })
      .then((data) => {
        useProjectStore.getState().loadProject(data);
        onClose(true);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  };

  return (
    <div style={overlay} role="dialog" aria-label="New project wizard">
      <div style={modal}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>New Project</h3>

        <label style={label}>Project directory</label>
        <input
          style={input}
          value={draft.dir}
          placeholder="path/to/my-project (.breadesp)"
          spellCheck={false}
          onChange={(e) => patch({ dir: e.target.value })}
        />

        <label style={label}>Chip</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {WIZARD_CHIPS.map((c: ChipKind) => (
            <button
              key={c}
              style={draft.chip === c ? chipBtnActive : chipBtn}
              onClick={() => patch({ chip: c })}
            >
              {c}
            </button>
          ))}
        </div>

        <label style={label}>Template</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {draftTemplates(draft).map((t) => (
            <button
              key={t.id}
              style={draft.templateId === t.id ? tplActive : tpl}
              onClick={() => patch({ templateId: t.id })}
            >
              <strong>{t.displayName}</strong>
              <span style={{ fontSize: 11, color: '#64748b' }}>{t.description}</span>
            </button>
          ))}
        </div>

        {error !== null && <div style={errBox}>{error}</div>}
        {error === null && draftError !== null && <div style={hintBox}>{draftError}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button style={btn} disabled={busy} onClick={() => onClose(false)}>Cancel</button>
          <button style={btnPrimary} disabled={busy || draftError !== null} onClick={onCreate}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const modal: CSSProperties = {
  width: 420,
  background: '#fff',
  borderRadius: 8,
  padding: 16,
  boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
  display: 'flex',
  flexDirection: 'column',
};

const label: CSSProperties = { fontSize: 12, fontWeight: 600, margin: '10px 0 4px', color: '#334155' };

const input: CSSProperties = {
  padding: '6px 8px',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
  border: '1px solid #cbd5e1',
  borderRadius: 4,
};

const chipBtn: CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  background: '#fff',
};

const chipBtnActive: CSSProperties = { ...chipBtn, border: '1px solid #2563eb', background: '#dbeafe' };

const tpl: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  padding: 8,
  fontSize: 12,
  cursor: 'pointer',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  background: '#fff',
  textAlign: 'left',
};

const tplActive: CSSProperties = { ...tpl, border: '1px solid #2563eb', background: '#eff6ff' };

const btn: CSSProperties = { padding: '5px 12px', fontSize: 12, cursor: 'pointer' };

const btnPrimary: CSSProperties = {
  ...btn,
  background: '#2563eb',
  color: '#fff',
  border: '1px solid #2563eb',
  borderRadius: 4,
};

const errBox: CSSProperties = { marginTop: 10, fontSize: 12, color: '#b91c1c' };

const hintBox: CSSProperties = { marginTop: 10, fontSize: 12, color: '#64748b' };
