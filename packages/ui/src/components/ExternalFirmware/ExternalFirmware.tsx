// PRD: §F-PROJ-3 — External firmware panel (dev-plan task P4.3). Associates
// the open .breadesp project with a PlatformIO/ESP-IDF project directory,
// lists the auto-discovered build/*.elf candidates (newest first, archOk
// flagged against the project chip) and imports a pick as firmware.elf.
// All IPC errors surface as short English messages.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { bridge } from '../../ipc/bridge';
import type { ExternalScanResult } from '../../ipc/bridge';
import { useProjectStore } from '../../store/projectStore';
import {
  candidateLabel,
  formatAge,
  formatBytes,
  kindLabel,
  pickImportCandidate,
  scanSummary,
} from './externalDraft';

export function ExternalFirmware() {
  const dir = useProjectStore((s) => s.dir);
  const external = useProjectStore((s) => s.external);
  const firmwareElf = useProjectStore((s) => s.firmwareElf);
  const [input, setInput] = useState('');
  const [scan, setScan] = useState<ExternalScanResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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
        if (!cancelled) setMsg(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [dir, external]);

  if (dir === null) return null; // the feature is project-scoped

  const run = (label: string, fn: () => Promise<void>): void => {
    setBusy(true);
    setMsg(null);
    fn()
      .catch((err: unknown) => setMsg(`${label} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  const onLink = (): void => {
    const target = input.trim();
    if (target === '') {
      setMsg('Link failed: enter a PlatformIO/ESP-IDF project directory first');
      return;
    }
    run('Link', async () => {
      const result = await bridge.proj.linkExternal({ dir: target });
      useProjectStore.getState().setExternal(result.link);
      setScan(result);
      setSelected(null);
    });
  };

  const onUnlink = (): void => {
    run('Unlink', async () => {
      await bridge.proj.unlinkExternal();
      useProjectStore.getState().setExternal(null);
      setScan(null);
      setSelected(null);
    });
  };

  const onRescan = (): void => {
    run('Rescan', async () => {
      const result = await bridge.proj.scanExternal();
      setScan(result);
      setSelected((prev) => (prev !== null && result.candidates.some((c) => c.path === prev) ? prev : null));
    });
  };

  const onImport = (): void => {
    if (scan === null) return;
    const pick = pickImportCandidate(scan.candidates, selected);
    if (pick === null) {
      setMsg('Import failed: no build/*.elf discovered yet');
      return;
    }
    run('Import', async () => {
      const dest = await bridge.proj.importExternal({ elfPath: pick.path });
      useProjectStore.getState().setFirmwareElf(dest);
      setMsg(`Import ok: firmware.elf updated from ${candidateLabel(pick)}`);
    });
  };

  const importPick = scan !== null ? pickImportCandidate(scan.candidates, selected) : null;

  return (
    <div style={bar}>
      <span style={title}>External firmware</span>
      {external === null ? (
        <>
          <input
            style={inputStyle}
            value={input}
            placeholder="PlatformIO/ESP-IDF project directory"
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
          />
          <button style={btn} disabled={busy} onClick={onLink}>Link</button>
        </>
      ) : (
        <>
          <span style={linkBadge}>{kindLabel(external.kind)}</span>
          <span style={linkDir} title={external.dir}>{external.dir}</span>
          {scan !== null && scan.candidates.length > 0 && (
            <select
              style={selectStyle}
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
          {scan !== null && <span style={summary}>{scanSummary(scan, Date.now())}</span>}
          <button style={btn} disabled={busy || importPick === null} onClick={onImport}>Import</button>
          <button style={btn} disabled={busy} onClick={onRescan}>Rescan</button>
          <button style={btn} disabled={busy} onClick={onUnlink}>Unlink</button>
        </>
      )}
      <span style={msgStyle}>
        {msg ?? (firmwareElf !== null ? `firmware: ${firmwareElf}` : 'no firmware imported')}
      </span>
    </div>
  );
}

const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 10px',
  borderBottom: '1px solid #e2e8f0',
  background: '#fdfefe',
  fontSize: 12,
};

const title: CSSProperties = { fontWeight: 600, color: '#334155' };

const inputStyle: CSSProperties = {
  width: 320,
  padding: '3px 8px',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
};

const linkBadge: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 4,
  background: '#eef2ff',
  border: '1px solid #c7d2fe',
  color: '#3730a3',
  fontWeight: 600,
};

const linkDir: CSSProperties = {
  maxWidth: 260,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: '#475569',
  fontFamily: 'ui-monospace, monospace',
};

const selectStyle: CSSProperties = { maxWidth: 300, fontSize: 12 };

const summary: CSSProperties = { color: '#64748b' };

const btn: CSSProperties = { padding: '3px 10px', fontSize: 12, cursor: 'pointer' };

const msgStyle: CSSProperties = {
  marginLeft: 8,
  color: '#475569',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
