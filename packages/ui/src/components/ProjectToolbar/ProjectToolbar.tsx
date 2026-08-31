// PRD: §F-PROJ-2, §F-BB-6 — Project lifecycle toolbar (new/open/save/saveAs/close).
// The dir field is a plain path input for MVP (native directory picker is a
// TODO(PRD §F-PROJ-2)); every action is a `proj:*` IPC round-trip and errors
// surface as short English messages.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { bridge } from '../../ipc/bridge';
import { toLayoutFile, toNetlistFile, useProjectStore } from '../../store/projectStore';

export function ProjectToolbar() {
  const dir = useProjectStore((s) => s.dir);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Keep the input in sync with the store after open/new/save-as.
  useEffect(() => {
    setInput(dir ?? '');
  }, [dir]);

  const target = input.trim();

  const run = (label: string, fn: () => Promise<void>): void => {
    setBusy(true);
    setMsg(null);
    fn()
      .then(() => setMsg(`${label} ok`))
      .catch((err: unknown) =>
        setMsg(`${label} failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setBusy(false));
  };

  const requireTarget = (label: string): boolean => {
    if (target !== '') return true;
    setMsg(`${label} failed: enter a project directory first`);
    return false;
  };

  const onNew = (): void => {
    if (!requireTarget('New')) return;
    run('New', async () => {
      await bridge.proj.new({ dir: target });
      useProjectStore.getState().resetProject(target);
    });
  };

  const onOpen = (): void => {
    if (!requireTarget('Open')) return;
    run('Open', async () => {
      const data = await bridge.proj.open({ dir: target });
      useProjectStore.getState().loadProject(data);
    });
  };

  const onSave = (): void => {
    if (dir === null) {
      setMsg('Save failed: no project open');
      return;
    }
    run('Save', async () => {
      const { netlist, layout } = useProjectStore.getState();
      await bridge.proj.save({ netlist: toNetlistFile(netlist), layout: toLayoutFile(layout) });
    });
  };

  const onSaveAs = (): void => {
    if (!requireTarget('Save as')) return;
    run('Save as', async () => {
      const { netlist, layout } = useProjectStore.getState();
      await bridge.proj.saveAs({ dir: target, netlist: toNetlistFile(netlist), layout: toLayoutFile(layout) });
      useProjectStore.getState().setDir(target);
    });
  };

  const onClose = (): void => {
    run('Close', async () => {
      await bridge.proj.close();
      useProjectStore.getState().resetProject(null);
    });
  };

  return (
    <div style={bar}>
      <input
        style={inputStyle}
        value={input}
        placeholder="project directory (.breadesp)"
        spellCheck={false}
        onChange={(e) => setInput(e.target.value)}
      />
      <button style={btn} disabled={busy} onClick={onNew}>New</button>
      <button style={btn} disabled={busy} onClick={onOpen}>Open</button>
      <button style={btn} disabled={busy || dir === null} onClick={onSave}>Save</button>
      <button style={btn} disabled={busy} onClick={onSaveAs}>Save as</button>
      <button style={btn} disabled={busy || dir === null} onClick={onClose}>Close</button>
      <span style={msgStyle}>{msg ?? (dir !== null ? `project: ${dir}` : 'no project open')}</span>
    </div>
  );
}

const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderBottom: '1px solid #ccc',
  background: '#f8fafc',
};

const inputStyle: CSSProperties = {
  width: 320,
  padding: '4px 8px',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
};

const btn: CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
};

const msgStyle: CSSProperties = {
  marginLeft: 8,
  fontSize: 12,
  color: '#475569',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
