// T3.2 — project lifecycle group of the TopBar. Logic migrated verbatim
// from ProjectToolbar (T1.3): the dir input is a plain path field (native
// picker is a PRD §F-PROJ-2 TODO), every action is a `proj:*` IPC
// round-trip with toast feedback, and "New" opens the project wizard
// (dev-plan P4.2). The input is narrower here — the bar is one row now.
import { useEffect, useState } from 'react';
import { bridge } from '../../ipc/bridge';
import { toLayoutFile, toNetlistFile, useProjectStore } from '../../store/projectStore';
import { toast } from '../../store/toastStore';
import { useT } from '../../i18n';
import { Button } from '../ui/Button';
import { ProjectWizard } from '../ProjectWizard/ProjectWizard';

export function ProjectGroup() {
  const dir = useProjectStore((s) => s.dir);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const t = useT();

  // Keep the input in sync with the store after open/new/save-as.
  useEffect(() => {
    setInput(dir ?? '');
  }, [dir]);

  const target = input.trim();

  const run = (okKey: 'toast.openOk' | 'toast.saveOk' | 'toast.saveAsOk' | 'toast.closeOk',
               failKey: 'toast.openFailed' | 'toast.saveFailed' | 'toast.saveAsFailed' | 'toast.closeFailed',
               fn: () => Promise<void>): void => {
    setBusy(true);
    fn()
      .then(() => toast.success(t(okKey)))
      .catch((err: unknown) =>
        toast.error(t(failKey, { detail: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusy(false));
  };

  const requireTarget = (action: string): boolean => {
    if (target !== '') return true;
    toast.warning(t('toast.needDir', { action }));
    return false;
  };

  const onWizardClose = (created: boolean): void => {
    setWizardOpen(false);
    if (created) toast.success(t('toast.newOk'));
  };

  const onOpen = (): void => {
    if (!requireTarget(t('toolbar.open'))) return;
    run('toast.openOk', 'toast.openFailed', async () => {
      const data = await bridge.proj.open({ dir: target });
      useProjectStore.getState().loadProject(data);
    });
  };

  const onSave = (): void => {
    if (dir === null) {
      toast.warning(t('toast.saveNoProject'));
      return;
    }
    run('toast.saveOk', 'toast.saveFailed', async () => {
      const { netlist, layout } = useProjectStore.getState();
      await bridge.proj.save({ netlist: toNetlistFile(netlist), layout: toLayoutFile(layout) });
    });
  };

  const onSaveAs = (): void => {
    if (!requireTarget(t('toolbar.saveAs'))) return;
    run('toast.saveAsOk', 'toast.saveAsFailed', async () => {
      const { netlist, layout } = useProjectStore.getState();
      await bridge.proj.saveAs({ dir: target, netlist: toNetlistFile(netlist), layout: toLayoutFile(layout) });
      useProjectStore.getState().setDir(target);
    });
  };

  const onClose = (): void => {
    run('toast.closeOk', 'toast.closeFailed', async () => {
      await bridge.proj.close();
      useProjectStore.getState().resetProject(null);
    });
  };

  return (
    <div className="flex items-center gap-1.5">
      <input
        className="h-7 w-44 rounded border border-bb-line bg-white px-2 font-mono text-xs text-bb-ink placeholder:text-bb-muted focus:border-bb-primary focus:outline-none"
        value={input}
        placeholder={t('toolbar.dirPlaceholder')}
        spellCheck={false}
        onChange={(e) => setInput(e.target.value)}
      />
      <Button disabled={busy} onClick={() => setWizardOpen(true)}>{t('toolbar.new')}</Button>
      <Button disabled={busy} onClick={onOpen}>{t('toolbar.open')}</Button>
      <Button disabled={busy || dir === null} onClick={onSave}>{t('toolbar.save')}</Button>
      <Button disabled={busy} onClick={onSaveAs}>{t('toolbar.saveAs')}</Button>
      <Button disabled={busy || dir === null} variant="danger" onClick={onClose}>{t('toolbar.close')}</Button>
      {wizardOpen && <ProjectWizard initialDir={input.trim()} onClose={onWizardClose} />}
    </div>
  );
}
