// PRD: §F-PROJ-2 — New-project wizard (dev-plan task P4.2). Modal flow:
// pick a chip (PRD §6.5 ChipKind), pick a template (@breadesp/netlist
// registry), enter the target directory; Create round-trips `proj:new` and
// hydrates the project store from the Bridge-validated ProjectData.
//
// This is the first dialog a new user meets, so it carries the same visual
// language as the rest of the chrome (bb-* tokens, shared Button/Icon) rather
// than the inline-styled box it started as. Template copy is localized by id
// with a fallback to the registry text, so a third-party template still renders.
import { useEffect, useState } from 'react';
import type { ChipKind } from '@breadesp/netlist';
import { bridge } from '../../ipc/bridge';
import { useProjectStore } from '../../store/projectStore';
import { useT, type MessageKey } from '../../i18n';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import {
  createWizardDraft,
  draftTemplates,
  patchWizardDraft,
  WIZARD_CHIPS,
  wizardDraftProblem,
  type WizardDraft,
} from './wizardDraft';

/** Localized template copy, keyed by registry id. */
const TEMPLATE_COPY: Record<string, { name: MessageKey; desc: MessageKey }> = {
  empty: { name: 'wizard.tpl.empty.name', desc: 'wizard.tpl.empty.desc' },
  'blink-led': { name: 'wizard.tpl.blinkLed.name', desc: 'wizard.tpl.blinkLed.desc' },
  'oled-ssd1306': { name: 'wizard.tpl.oled.name', desc: 'wizard.tpl.oled.desc' },
};

/** Chip glyph: a package outline with its pin rows. */
function ChipMark({ active }: { active: boolean }) {
  return <Icon name="chip" size={13} className={active ? 'text-bb-primary' : 'text-bb-muted'} />;
}

export interface ProjectWizardProps {
  /** Pre-filled directory (carried over from the toolbar input). */
  initialDir: string;
  /** created=true after a successful create, false on cancel. */
  onClose: (created: boolean) => void;
}

export function ProjectWizard({ initialDir, onClose }: ProjectWizardProps) {
  const t = useT();
  const [draft, setDraft] = useState<WizardDraft>(() => createWizardDraft(initialDir));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (p: Partial<WizardDraft>): void => {
    setDraft((d) => patchWizardDraft(d, p));
    setError(null);
  };

  const problem = wizardDraftProblem(draft);
  const problemText =
    problem === null
      ? null
      : problem.kind === 'dirRequired'
        ? t('wizard.error.dirRequired')
        : t('wizard.error.templateUnavailable', { template: problem.templateId, chip: problem.chip });
  const cancel = (): void => onClose(false);

  // Escape closes, mirroring the Close button. The dialog is hand-rolled (no
  // Radix Root here), so the key is bound explicitly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onCreate = (): void => {
    if (problem !== null || busy) return;
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
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/45 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('wizard.title')}
        className="flex w-[540px] max-w-full flex-col overflow-hidden rounded-xl border border-bb-line bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-bb-line px-4 py-3">
          <div className="min-w-0">
            <h3 className="m-0 text-sm font-semibold text-bb-ink">{t('wizard.title')}</h3>
            <p className="m-0 mt-0.5 text-[11px] leading-4 text-bb-muted">{t('wizard.subtitle')}</p>
          </div>
          <Button className="w-7 px-0" title={t('common.close')} aria-label={t('common.close')} onClick={cancel}>
            <Icon name="close" size={13} />
          </Button>
        </header>

        <div className="flex flex-col gap-3.5 px-4 py-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold text-bb-ink" htmlFor="wizard-dir">
              {t('wizard.dir')}
            </label>
            <span className="relative flex items-center">
              <Icon name="folder" size={13} className="pointer-events-none absolute left-2 text-bb-muted" />
              <input
                id="wizard-dir"
                autoFocus
                className="h-8 w-full rounded border border-bb-line bg-white pl-7 pr-2 font-mono text-xs text-bb-ink placeholder:font-sans placeholder:text-bb-muted focus:border-bb-primary focus:outline-none"
                value={draft.dir}
                placeholder={t('wizard.dirPlaceholder')}
                spellCheck={false}
                onChange={(e) => patch({ dir: e.target.value })}
              />
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold text-bb-ink">{t('wizard.chip')}</span>
            <div className="inline-flex w-fit items-center gap-0.5 rounded-md border border-bb-line bg-slate-100 p-0.5">
              {WIZARD_CHIPS.map((c: ChipKind) => {
                const active = draft.chip === c;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={active}
                    onClick={() => patch({ chip: c })}
                    className={`inline-flex cursor-pointer items-center gap-1 rounded border-0 px-2.5 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-bb-primary/40 ${
                      active
                        ? 'bg-white font-medium text-bb-ink shadow-sm'
                        : 'bg-transparent text-bb-muted hover:text-bb-ink'
                    }`}
                  >
                    <ChipMark active={active} />
                    {c}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold text-bb-ink">{t('wizard.template')}</span>
            <div className="flex flex-col gap-1.5">
              {draftTemplates(draft).map((tmpl) => {
                const copy = TEMPLATE_COPY[tmpl.id];
                const name = copy === undefined ? tmpl.displayName : t(copy.name);
                const desc = copy === undefined ? tmpl.description : t(copy.desc);
                const active = draft.templateId === tmpl.id;
                return (
                  <button
                    key={tmpl.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => patch({ templateId: tmpl.id })}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-bb-primary/40 ${
                      active
                        ? 'border-bb-primary bg-blue-50/70'
                        : 'border-bb-line bg-white hover:border-slate-400 hover:bg-slate-50'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        active ? 'border-bb-primary bg-bb-primary text-white' : 'border-slate-300 bg-white'
                      }`}
                    >
                      {active && <Icon name="check" size={10} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-bb-ink">{name}</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-bb-muted">{desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {error !== null && (
            <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
              <Icon name="alert" size={13} className="mt-px shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
          {error === null && problemText !== null && (
            <div className="flex items-start gap-2 rounded border border-bb-line bg-slate-50 px-2.5 py-2 text-[11px] text-bb-muted">
              <Icon name="info" size={13} className="mt-px shrink-0" />
              <span>{problemText}</span>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-bb-line bg-slate-50/70 px-4 py-3">
          <Button onClick={cancel} disabled={busy}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            className="px-3"
            busy={busy}
            disabled={problem !== null}
            onClick={onCreate}
          >
            {busy ? t('wizard.creating') : t('wizard.create')}
          </Button>
        </footer>
      </div>
    </div>
  );
}
