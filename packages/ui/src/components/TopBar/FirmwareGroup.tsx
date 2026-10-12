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
          className="inline-flex h-7 items-center gap-1.5 rounded border border-bb-line bg-white px-2.5 text-xs font-medium text-bb-ink cursor-pointer hover:bg-slate-50"
          title={firmwareElf !== null ? t('firmware.current', { path: firmwareElf }) : t('firmware.none')}
        >
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${firmwareElf !== null ? 'bg-bb-ok' : 'bg-slate-300'}`}
          />
          {t('firmware.title')}
          {external !== null && (
            <span className="rounded bg-indigo-50 border border-indigo-200 px-1 text-[10px] text-indigo-800">
              {kindLabel(external.kind)}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className="z-50 w-[420px] rounded-md border border-bb-line bg-white p-3 shadow-lg text-xs text-bb-ink"
        >
          <Popover.Arrow className="fill-bb-line" />
          {dir === null ? (
            // The feature is project-scoped; mirror the old panel's behavior.
            <p className="text-bb-muted">{t('toolbar.noProject')}</p>
          ) : external === null ? (
            <div className="flex items-center gap-2">
              <input
                className="h-7 flex-1 rounded border border-bb-line px-2 font-mono text-xs"
                value={input}
                placeholder="PlatformIO/ESP-IDF project directory"
                spellCheck={false}
                onChange={(e) => setInput(e.target.value)}
              />
              <Button disabled={busy} onClick={onLink}>Link</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="rounded bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 font-semibold text-indigo-800">
                  {kindLabel(external.kind)}
                </span>
                <span className="truncate font-mono text-bb-muted" title={external.dir}>{external.dir}</span>
              </div>
              {scan !== null && scan.candidates.length > 0 && (
                <select
                  className="h-7 rounded border border-bb-line bg-white px-1 text-xs"
                  value={selected ?? importPick?.path ?? ''}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {scan.candidates.map((c) => (
                    <option key={c.path} value={c.path}>
                      {candidateLabel(c)} · {formatBytes(c.sizeBytes)} · {formatAge(c.mtimeMs, Date.now())}
                      {c.archOk === false ? ' · wrong arch' : ''}
                    </option>
                  ))}
                </select>
              )}
              {scan !== null && <span className="text-bb-muted">{scanSummary(scan, Date.now())}</span>}
              <div className="flex items-center gap-2">
                <Button variant="primary" disabled={busy || importPick === null} onClick={onImport}>Import</Button>
                <Button disabled={busy} onClick={onRescan}>Rescan</Button>
                <Button variant="danger" disabled={busy} onClick={onUnlink}>Unlink</Button>
              </div>
            </div>
          )}
          <p className="mt-2 truncate text-bb-muted">
            {firmwareElf !== null ? t('firmware.current', { path: firmwareElf }) : t('firmware.none')}
          </p>
          {dir !== null && (
            <div className="flex flex-col gap-2 border-t border-bb-line pt-2">
              <span className="font-medium">{t('firmware.examples')}</span>
              {chipExamples.length > 0 ? (
                <div className="flex items-center gap-2">
                  <select
                    className="h-7 min-w-0 flex-1 rounded border border-bb-line bg-white px-1 text-xs"
                    value={examplePick ?? chipExamples[0]?.path ?? ''}
                    onChange={(e) => setExamplePick(e.target.value)}
                  >
                    {chipExamples.map((e) => (
                      <option key={e.path} value={e.path} title={e.note}>
                        {e.name}{e.note !== undefined ? ` — ${e.note}` : ''}
                      </option>
                    ))}
                  </select>
                  <Button variant="primary" disabled={busy} onClick={onImportExample}>
                    {t('firmware.importExample')}
                  </Button>
                </div>
              ) : (
                <span className="text-bb-muted">{t('firmware.noExamples', { chip })}</span>
              )}
              <Button disabled={busy} onClick={onImportFile}>{t('firmware.importFile')}</Button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
