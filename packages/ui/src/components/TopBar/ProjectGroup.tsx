// T3.2 — project lifecycle group of the TopBar. Logic migrated verbatim
// from ProjectToolbar (T1.3): the dir input is a plain path field (native
// picker is a PRD §F-PROJ-2 TODO), every action is a `proj:*` IPC
// round-trip with toast feedback, and "New" opens the project wizard
// (dev-plan P4.2).
//
// Layout: the three actions a beginner reaches for every session (new / open /
// save) stay on the bar as icon+label; "save as" and "close" are rare and
// destructive-flavoured, so they live behind a "⋯" menu. Five equally weighted
// text buttons made the row read as a wall of words and pushed the simulation
// controls off a 1080 px window.
import { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { bridge } from '../../ipc/bridge';
import { toLayoutFile, toNetlistFile, useProjectStore } from '../../store/projectStore';
import { toast } from '../../store/toastStore';
import { useT } from '../../i18n';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ProjectWizard } from '../ProjectWizard/ProjectWizard';

export function ProjectGroup() {
  const dir = useProjectStore((s) => s.dir);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
    setMenuOpen(false);
    if (!requireTarget(t('toolbar.saveAs'))) return;
    run('toast.saveAsOk', 'toast.saveAsFailed', async () => {
      const { netlist, layout } = useProjectStore.getState();
      await bridge.proj.saveAs({ dir: target, netlist: toNetlistFile(netlist), layout: toLayoutFile(layout) });
      useProjectStore.getState().setDir(target);
    });
  };

  const onClose = (): void => {
    setMenuOpen(false);
    run('toast.closeOk', 'toast.closeFailed', async () => {
      await bridge.proj.close();
      useProjectStore.getState().resetProject(null);
    });
  };

  return (
    <div className="flex items-center gap-1.5">
      {/* Path field: the folder glyph says "this is where the project lives"
          before the placeholder is read, and the open-project state is shown by
          a filled field rather than by having to parse the path. */}
      <span className="relative inline-flex items-center">
        <Icon
          name="folder"
          size={13}
          className={`pointer-events-none absolute left-2 ${dir === null ? 'text-bb-muted' : 'text-bb-primary'}`}
        />
        <input
          className="h-7 w-44 rounded border border-bb-line bg-white pl-7 pr-2 font-mono text-xs text-bb-ink placeholder:font-sans placeholder:text-bb-muted focus:border-bb-primary focus:outline-none"
          value={input}
          placeholder={t('toolbar.dirPlaceholder')}
          spellCheck={false}
          title={dir ?? t('toolbar.noProject')}
          onChange={(e) => setInput(e.target.value)}
        />
      </span>
      <Button disabled={busy} title={t('toolbar.new')} onClick={() => setWizardOpen(true)}>
        <Icon name="plus" size={13} />
        {t('toolbar.new')}
      </Button>
      <Button disabled={busy} title={t('toolbar.open')} onClick={onOpen}>
        <Icon name="folderOpen" size={13} />
        {t('toolbar.open')}
      </Button>
      <Button disabled={busy || dir === null} title={t('toolbar.save')} onClick={onSave}>
        <Icon name="save" size={13} />
        {t('toolbar.save')}
      </Button>
      <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Popover.Trigger asChild>
          <Button className="w-7 px-0" title={t('toolbar.more')} aria-label={t('toolbar.more')}>
            <Icon name="more" size={15} />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            sideOffset={6}
            align="end"
            className="z-50 w-40 rounded-md border border-bb-line bg-white p-1 shadow-lg"
          >
            <button
              type="button"
              disabled={busy}
              onClick={onSaveAs}
              className="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left text-xs text-bb-ink hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:cursor-not-allowed disabled:text-bb-muted"
            >
              <Icon name="saveAs" size={13} className="text-bb-muted" />
              {t('toolbar.saveAs')}
            </button>
            <button
              type="button"
              disabled={busy || dir === null}
              onClick={onClose}
              className="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left text-xs text-bb-danger hover:bg-red-50 focus:bg-red-50 focus:outline-none disabled:cursor-not-allowed disabled:text-bb-muted"
            >
              <Icon name="close" size={13} />
              {t('toolbar.close')}
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {wizardOpen && <ProjectWizard initialDir={input.trim()} onClose={onWizardClose} />}
    </div>
  );
}
