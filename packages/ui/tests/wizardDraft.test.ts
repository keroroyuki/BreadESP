// PRD: §F-PROJ-2 — new-project wizard draft logic (dev-plan task P4.2).
import { describe, expect, it } from 'vitest';
import { listTemplates } from '@breadesp/netlist';
import type { ChipKind } from '@breadesp/netlist';
import {
  createWizardDraft,
  draftTemplates,
  patchWizardDraft,
  WIZARD_CHIPS,
  wizardDraftError,
} from '../src/components/ProjectWizard/wizardDraft';

describe('wizardDraft (P4.2)', () => {
  it('starts on the MVP chip with the empty template and an optional dir', () => {
    expect(createWizardDraft()).toEqual({ dir: '', chip: 'esp32', templateId: 'empty' });
    expect(createWizardDraft('/tmp/x')).toEqual({ dir: '/tmp/x', chip: 'esp32', templateId: 'empty' });
  });

  it('offers every registry chip and the full template list per chip', () => {
    expect(WIZARD_CHIPS).toEqual(['esp32', 'esp32s3', 'esp32c3', 'esp32c6']);
    for (const chip of WIZARD_CHIPS) {
      expect(draftTemplates({ dir: '', chip, templateId: 'empty' }).map((t) => t.id)).toEqual(
        listTemplates().map((t) => t.id),
      );
    }
  });

  it('patch merges fields and keeps a supported template across chip switches', () => {
    const d0 = createWizardDraft('/tmp/x');
    const d1 = patchWizardDraft(d0, { templateId: 'blink-led' });
    expect(d1.templateId).toBe('blink-led');
    const d2 = patchWizardDraft(d1, { chip: 'esp32s3' });
    expect(d2).toEqual({ dir: '/tmp/x', chip: 'esp32s3', templateId: 'blink-led' });
    // The original draft is untouched (immutable updates).
    expect(d0.templateId).toBe('empty');
  });

  it('resets to the empty template when a chip switch loses template support', () => {
    // Out-of-contract chip (boundary): no template supports it, so the patch
    // falls back to 'empty' rather than leaving a dangling selection.
    const d = patchWizardDraft(createWizardDraft(), { chip: 'esp32h2' as ChipKind, templateId: 'blink-led' });
    expect(d.templateId).toBe('empty');
    expect(wizardDraftError({ ...d, dir: '/tmp/x' })).toBe('template "empty" is not available for esp32h2');
  });

  it('blocks Create on an empty directory and clears once filled', () => {
    expect(wizardDraftError(createWizardDraft())).toBe('project directory is required');
    expect(wizardDraftError(createWizardDraft('   '))).toBe('project directory is required');
    expect(wizardDraftError(createWizardDraft('/tmp/proj'))).toBeNull();
  });

  it('accepts every chip × template combination the registry offers', () => {
    for (const chip of WIZARD_CHIPS) {
      for (const t of draftTemplates({ dir: '/tmp/p', chip, templateId: 'empty' })) {
        expect(wizardDraftError({ dir: '/tmp/p', chip, templateId: t.id })).toBeNull();
      }
    }
  });
});
