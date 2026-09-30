// Dev orchestrator (PRD §4 dev loop): Vite renderer dev server + Electron main.
// Zero-dependency by design (PRD §0 tooling). Boots the UI dev server, waits
// for port 5173, then launches Electron in packages/shell with
// VITE_DEV_SERVER_URL so main.ts loads the HMR renderer instead of ui/dist.
// Both children are tied together: either one exiting tears the other down.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const uiDir = join(root, 'packages', 'ui');
const shellDir = join(root, 'packages', 'shell');
const DEV_URL = 'http://localhost:5173';
const PORT = 5173;

/** Prefix every log line with the child's tag so streams stay readable. */
function pipe(tag, child) {
  const fwd = (stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line) process.stdout.write(`[${tag}] ${line}\n`);
    });
  };
  fwd(child.stdout);
  fwd(child.stderr);
}

async function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const sock = connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); res(true); });
      sock.once('error', () => res(false));
    });
    if (ok) return;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`vite dev server did not open :${port} within ${timeoutMs / 1000}s`);
}

// 1. Renderer: node <ui>/node_modules/vite/bin/vite.js (avoids .cmd shims).
const vite = spawn(process.execPath, [join(uiDir, 'node_modules', 'vite', 'bin', 'vite.js')], {
  cwd: uiDir,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
pipe('vite', vite);

let electron = null;
const teardown = (code) => {
  vite.kill();
  if (electron) electron.kill();
  process.exit(code ?? 0);
};
process.on('SIGINT', () => teardown(0));
process.on('SIGTERM', () => teardown(0));
vite.once('exit', (code) => { if (electron) teardown(code ?? 0); });

// 2. Main: resolve the electron binary from the shell workspace, run it on dist.
await waitForPort(PORT);
const require = createRequire(join(shellDir, 'package.json'));
const electronPath = require('electron'); // npm pkg exports the binary path outside Electron
console.log(`[dev] vite ready on ${DEV_URL} — launching electron`);
electron = spawn(electronPath, ['.'], {
  cwd: shellDir,
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
  stdio: ['ignore', 'pipe', 'pipe'],
});
pipe('electron', electron);
electron.once('exit', (code) => teardown(code ?? 0));
