// PRD: §F-PROJ-2 — pure draft logic for the new-project wizard
// (dev-plan task P4.2). The component holds a WizardDraft; all validation and
// template-list derivation lives here so it is unit-testable without a DOM.
// Templates themselves come from @breadesp/netlist (single source of truth,
// shared with the shell-side ProjectManager writer).
import { templatesForChip } from '@breadesp/netlist';
import type { ChipKind, ProjectTemplate } from '@breadesp/netlist';

export const WIZARD_CHIPS: ChipKind[] = ['esp32', 'esp32s3', 'esp32c3', 'esp32c6'];

export interface WizardDraft {
  /** Target .breadesp directory (absolute path typed by the user). */
  dir: string;
  chip: ChipKind;
  templateId: string;
}

/** Fresh draft: MVP chip (PRD §8), blank template, optional pre-filled dir. */
export function createWizardDraft(initialDir?: string): WizardDraft {
  return { dir: initialDir ?? '', chip: 'esp32', templateId: 'empty' };
}

/** Templates the draft's chip can use, registry order preserved. */
export function draftTemplates(draft: WizardDraft): ProjectTemplate[] {
  return templatesForChip(draft.chip);
}

/**
 * Apply a patch. Switching chips resets the template to 'empty' when the
 * current template does not support the new chip ('empty' supports every
 * chip, so the draft is always left in a selectable state).
 */
export function patchWizardDraft(draft: WizardDraft, patch: Partial<WizardDraft>): WizardDraft {
  const next: WizardDraft = { ...draft, ...patch };
  if (!templatesForChip(next.chip).some((t) => t.id === next.templateId)) {
    next.templateId = 'empty';
  }
  return next;
}

/**
 * First blocking problem with the draft, or null when Create may fire.
 * dir is only checked for non-emptiness here; existence/clobber rules are
 * enforced by the Bridge ([BB-124]/[BB-125] surface in the wizard on reject).
 */
export function wizardDraftError(draft: WizardDraft): string | null {
  if (draft.dir.trim() === '') return 'project directory is required';
  if (!templatesForChip(draft.chip).some((t) => t.id === draft.templateId)) {
    return `template "${draft.templateId}" is not available for ${draft.chip}`;
  }
  return null;
}
