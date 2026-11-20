// T3.3 — external-firmware group of the TopBar. Logic migrated verbatim
// from ExternalFirmware (T1.5) into a Radix Popover so the bar stays one
// row: the trigger carries the at-a-glance state (green dot = a firmware
// .elf is imported), the form lives inside the popover. externalDraft.ts
// and its tests are untouched.
import { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { bridge } from '../../ipc/bridge';
import type { ExampleFirmware, ExternalScanResult } from '../../ipc/bridge';
import { useProjectStore } from '../../store/projectStore';
import { toast } from '../../store/toastStore';
import { useT } from '../../i18n';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { Select } from '../ui/Select';
import {
  candidateLabel,
  formatAge,
  formatBytes,
  kindLabel,
  pickImportCandidate,
  scanSummary,
} from '../ExternalFirmware/externalDraft';

export function FirmwareGroup() {
  const dir = useProjectStore((s) => s.dir);
  const chip = useProjectStore((s) => s.netlist.chip);
  const external = useProjectStore((s) => s.external);
  const firmwareElf = useProjectStore((s) => s.firmwareElf);
  const [input, setInput] = useState('');
  const [scan, setScan] = useState<ExternalScanResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [examples, setExamples] = useState<ExampleFirmware[]>([]);
  const [examplePick, setExamplePick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  // The scan follows the link: a fresh link (or project open with one) pulls
  // the current candidates; unlink/close clears the panel.
  useEffect(() => {
    if (dir === null || external === null) {
      setScan(null);
      setSelected(null);
      return;
    }
    let cancelled = false;
    bridge.proj
      .scanExternal()
      .then((result) => {
        if (cancelled) return;
        setScan(result);
        setSelected(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(t('toast.rescanFailed', { detail: err instanceof Error ? err.message : String(err) }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, external]);

  // P6.1 (PRD §F-PROJ-1): bundled example firmware, filtered to the project's
  // chip. Refresh when a project opens (the arch gate runs again on import).
  useEffect(() => {
    if (dir === null) {
      setExamples([]);
      setExamplePick(null);
      return;
    }
    let cancelled = false;
    bridge.proj
      .listExamples()
      .then((list) => {
        if (cancelled) return;
        setExamples(list);
        setExamplePick(null);
      })
      .catch(() => { if (!cancelled) setExamples([]); });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const run = (okKey: 'toast.linkOk' | 'toast.unlinkOk' | 'toast.rescanOk',
               failKey: 'toast.linkFailed' | 'toast.unlinkFailed' | 'toast.rescanFailed',
               fn: () => Promise<void>): void => {
    setBusy(true);
    fn()
      .then(() => toast.success(t(okKey)))
      .catch((err: unknown) =>
        toast.error(t(failKey, { detail: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusy(false));
  };

  const onLink = (): void => {
    const target = input.trim();
    if (target === '') {
      toast.warning(t('toast.linkNeedDir'));
      return;
    }
    run('toast.linkOk', 'toast.linkFailed', async () => {
      const result = await bridge.proj.linkExternal({ dir: target });
      useProjectStore.getState().setExternal(result.link);
      setScan(result);
      setSelected(null);
    });
  };

  const onUnlink = (): void => {
    run('toast.unlinkOk', 'toast.unlinkFailed', async () => {
      await bridge.proj.unlinkExternal();
      useProjectStore.getState().setExternal(null);
      setScan(null);
      setSelected(null);
    });
  };

  const onRescan = (): void => {
    run('toast.rescanOk', 'toast.rescanFailed', async () => {
      const result = await bridge.proj.scanExternal();
      setScan(result);
      setSelected((prev) => (prev !== null && result.candidates.some((c) => c.path === prev) ? prev : null));
    });
  };

  const onImport = (): void => {
    if (scan === null) return;
    const pick = pickImportCandidate(scan.candidates, selected);
    if (pick === null) {
      toast.warning(t('toast.importNone'));
      return;
    }
    setBusy(true);
    bridge.proj
      .importExternal({ elfPath: pick.path })
      .then((dest) => {
        useProjectStore.getState().setFirmwareElf(dest);
        toast.success(t('toast.importOk', { detail: candidateLabel(pick) }));
      })
      .catch((err: unknown) =>
        toast.error(t('toast.importFailed', { detail: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusy(false));
  };

  const importPick = scan !== null ? pickImportCandidate(scan.candidates, selected) : null;

  // P6.1 (PRD §F-PROJ-1): bundled examples (chip-filtered) + arbitrary file import.
  const chipExamples = examples.filter((e) => e.chip === chip);

  const onImportExample = (): void => {
    const pick = chipExamples.find((e) => e.path === examplePick) ?? chipExamples[0];
    if (pick === undefined) return;
    setBusy(true);
    bridge.proj
      .importFirmware({ elfPath: pick.path })
      .then((dest) => {
        useProjectStore.getState().setFirmwareElf(dest);
        toast.success(t('toast.importFirmwareOk', { detail: pick.name }));
      })
      .catch((err: unknown) =>
        toast.error(t('toast.importFirmwareFailed', { detail: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusy(false));
  };

  const onImportFile = (): void => {
    setBusy(true);
    bridge.proj
      .importFirmwareFile()
      .then((dest) => {
        if (dest === null) return; // user canceled the picker
        useProjectStore.getState().setFirmwareElf(dest);
        toast.success(t('toast.importFirmwareOk', { detail: dest }));
      })
      .catch((err: unknown) =>
        toast.error(t('toast.importFirmwareFailed', { detail: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-bb-line bg-white px-2.5 text-xs font-medium text-bb-ink hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-bb-primary/40 "
          title={firmwareElf !== null ? t('firmware.current', { path: firmwareElf }) : t('firmware.none')}
        >
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${firmwareElf !== null ? 'bg-bb-ok' : 'bg-slate-300'}`}
          />
          {t('firmware.title')}
          {external !== null && (
            <span className="rounded border border-indigo-200 bg-indigo-50 px-1 text-[10px] text-indigo-800">
              {kindLabel(external.kind)}
            </span>
          )}
          <Icon name="chevronDown" size={11} className="text-bb-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className="z-50 w-[460px] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-bb-line bg-white text-xs text-bb-ink shadow-xl"
        >
          <div className="flex flex-col divide-y divide-bb-line">
            {/* What the VM would boot right now — the answer to "will Run work?" */}
            <section className="px-3 py-2.5">
              <SectionTitle icon="chip" text={t('firmware.section.current')} />
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full ${firmwareElf !== null ? 'bg-bb-ok' : 'bg-slate-300'}`}
                />
                <span
                  className={`truncate ${firmwareElf === null ? 'text-bb-muted' : 'font-mono text-bb-ink'}`}
                  title={firmwareElf ?? undefined}
                >
                  {firmwareElf ?? t('firmware.none')}
                </span>
              </div>
            </section>

            <section className="px-3 py-2.5">
              <SectionTitle icon="link" text={t('firmware.section.link')} />
              {dir === null ? (
                // The feature is project-scoped; mirror the old panel's behavior.
                <p className="m-0 text-bb-muted">{t('toolbar.noProject')}</p>
              ) : external === null ? (
                <div className="flex items-center gap-1.5">
                  <input
                    className="h-7 min-w-0 flex-1 rounded border border-bb-line px-2 font-mono text-xs text-bb-ink placeholder:font-sans placeholder:text-bb-muted focus:border-bb-primary focus:outline-none"
                    value={input}
                    placeholder={t('firmware.linkPlaceholder')}
                    spellCheck={false}
                    onChange={(e) => setInput(e.target.value)}
                  />
                  <Button disabled={busy} onClick={onLink}>{t('firmware.link')}</Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 font-semibold text-indigo-800">
                      {kindLabel(external.kind)}
                    </span>
                    <span className="truncate font-mono text-bb-muted" title={external.dir}>{external.dir}</span>
                  </div>
                  {scan !== null && scan.candidates.length > 0 && (
                    <Select
                      block
                      value={selected ?? importPick?.path ?? ''}
                      onChange={(e) => setSelected(e.target.value)}
                    >
                      {scan.candidates.map((c) => (
                        <option key={c.path} value={c.path}>
                          {candidateLabel(c)} · {formatBytes(c.sizeBytes)} · {formatAge(c.mtimeMs, Date.now())}
                          {c.archOk === false ? ` · ${t('firmware.wrongArch')}` : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                  {scan !== null && <span className="text-bb-muted">{scanSummary(scan, Date.now())}</span>}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button variant="primary" disabled={busy || importPick === null} onClick={onImport}>
                      <Icon name="import" size={12} />
                      {t('firmware.import')}
                    </Button>
                    <Button disabled={busy} onClick={onRescan}>
                      <Icon name="refresh" size={12} />
                      {t('firmware.rescan')}
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={onUnlink}>
                      <Icon name="unlink" size={12} />
                      {t('firmware.unlink')}
                    </Button>
                  </div>
                </div>
              )}
            </section>

            {dir !== null && (
              <section className="px-3 py-2.5">
                <SectionTitle icon="folderOpen" text={t('firmware.examples')} />
                {chipExamples.length > 0 ? (
                  <div className="flex items-center gap-1.5">
                    <Select
                      block
                      value={examplePick ?? chipExamples[0]?.path ?? ''}
                      onChange={(e) => setExamplePick(e.target.value)}
                    >
                      {chipExamples.map((e) => (
                        <option key={e.path} value={e.path} title={e.note}>
                          {e.name}{e.note !== undefined ? ` — ${e.note}` : ''}
                        </option>
                      ))}
                    </Select>
                    <Button variant="primary" className="shrink-0" disabled={busy} onClick={onImportExample}>
                      {t('firmware.importExample')}
                    </Button>
                  </div>
                ) : (
                  <span className="text-bb-muted">{t('firmware.noExamples', { chip })}</span>
                )}
                <Button className="mt-2 w-full justify-start" disabled={busy} onClick={onImportFile}>
                  <Icon name="import" size={12} />
                  {t('firmware.importFile')}
                </Button>
              </section>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Section heading inside the popover: icon + quiet uppercase label. */
function SectionTitle({ icon, text }: { icon: IconName; text: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-bb-muted">
      <Icon name={icon} size={12} />
      {text}
    </div>
  );
}
