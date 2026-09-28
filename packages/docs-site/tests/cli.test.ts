// PRD: §F-DOC-1/5, dev-plan P5.4 — docs CLI tests (arg parsing, exit codes,
// IO capture) plus a real serve round-trip driven through runDocsCli.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCS_USAGE, parseDocsArgs, runDocsCli, type DocsCliIO } from '../src/cli.js';

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-docs-cli-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
/** Minimal complete fixture repo (all pinned sources + one tutorial). */
function makeRoot(): string {
  const dir = join(tmp, `root-${seq++}`);
  mkdirSync(join(dir, 'docs', 'tutorials'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'tutorials', '01-a.md'), '---\ntitle: Alpha\n---\n# Alpha\n', 'utf8');
  writeFileSync(join(dir, 'README.md'), '# R\n', 'utf8');
  writeFileSync(join(dir, 'PRD.md'), '# P\n', 'utf8');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# C\n', 'utf8');
  for (const doc of ['architecture', 'dap', 'peripheral-sdk', 'dev-plan']) {
    writeFileSync(join(dir, 'docs', `${doc}.md`), `# ${doc}\n`, 'utf8');
  }
  return dir;
}

function captureIo(repoRoot: string, signal?: AbortSignal): DocsCliIO & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    repoRoot,
    ...(signal !== undefined ? { signal } : {}),
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

describe('parseDocsArgs', () => {
  it('parses the three commands with defaults', () => {
    expect(parseDocsArgs(['build'])).toEqual({ command: 'build', help: false });
    expect(parseDocsArgs(['check'])).toEqual({ command: 'check', help: false });
    expect(parseDocsArgs(['serve'])).toEqual({ command: 'serve', help: false });
    expect(parseDocsArgs(['serve', '--port', '8080'])).toEqual({ command: 'serve', help: false, port: 8080 });
    expect(parseDocsArgs(['build', '--out', 'elsewhere'])).toEqual({ command: 'build', help: false, out: 'elsewhere' });
  });

  it('rejects usage errors as coded [BB-240] strings', () => {
    expect(parseDocsArgs([]).error).toBe('[BB-240] missing command (expected build|check|serve)');
    expect(parseDocsArgs(['nope']).error).toContain("[BB-240] unknown command 'nope'");
    expect(parseDocsArgs(['build', '--nope']).error).toBe("[BB-240] unknown option '--nope'");
    expect(parseDocsArgs(['build', '--out']).error).toBe('[BB-240] option --out needs a value');
    expect(parseDocsArgs(['serve', '--port', 'abc']).error).toContain("[BB-240] --port expects an integer 0-65535");
    expect(parseDocsArgs(['serve', '--port', '70000']).error).toContain('[BB-240] --port expects an integer 0-65535');
    expect(parseDocsArgs(['build', 'check']).error).toContain("[BB-240] unexpected extra command 'check'");
    expect(parseDocsArgs(['check', '--out', 'x']).error).toContain('[BB-240] check takes no --out/--port');
    expect(parseDocsArgs(['build', '--port', '80']).error).toContain('[BB-240] --port only applies to serve');
  });

  it('--help short-circuits from any position', () => {
    expect(parseDocsArgs(['--help']).help).toBe(true);
    expect(parseDocsArgs(['serve', '-h']).help).toBe(true);
  });
});

describe('runDocsCli', () => {
  it('prints usage on stdout with exit 0 for --help', async () => {
    const io = captureIo(makeRoot());
    expect(await runDocsCli(['--help'], io)).toBe(0);
    expect(io.outLines.join('\n')).toContain('pnpm docs:build');
    expect(io.errLines).toEqual([]);
  });

  it('prints the coded usage error + usage on stderr with exit 2', async () => {
    const io = captureIo(makeRoot());
    expect(await runDocsCli([], io)).toBe(2);
    expect(io.errLines[0]).toBe('[BB-240] missing command (expected build|check|serve)');
    expect(io.errLines.join('\n')).toContain(DOCS_USAGE.trim().split('\n')[0]);
  });

  it('builds into the default docs/site and reports the summary', async () => {
    const root = makeRoot();
    const io = captureIo(root);
    expect(await runDocsCli(['build'], io)).toBe(0);
    expect(io.outLines[0]).toMatch(/^Built 8 pages \+ index \(10 files, \d+ links checked\) into /);
    expect(existsSync(join(root, 'docs', 'site', 'index.html'))).toBe(true);
    expect(existsSync(join(root, 'docs', 'site', 'tutorials', '01-a.html'))).toBe(true);
  });

  it('honors --out for the build target', async () => {
    const root = makeRoot();
    const io = captureIo(root);
    expect(await runDocsCli(['build', '--out', 'public'], io)).toBe(0);
    expect(existsSync(join(root, 'public', 'index.html'))).toBe(true);
    expect(existsSync(join(root, 'docs', 'site'))).toBe(false);
  });

  it('check passes a valid repo and fails a broken one with [BB-241] on stderr', async () => {
    const good = captureIo(makeRoot());
    expect(await runDocsCli(['check'], good)).toBe(0);
    expect(good.outLines[0]).toMatch(/^OK: 8 pages, \d+ links checked\.$/);

    const badRoot = makeRoot();
    writeFileSync(join(badRoot, 'docs', 'tutorials', '01-a.md'), '# Alpha\n\n[ghost](missing.md)\n', 'utf8');
    const bad = captureIo(badRoot);
    expect(await runDocsCli(['check'], bad)).toBe(2);
    expect(bad.errLines.join('\n')).toContain('[BB-241]');
    expect(bad.errLines.join('\n')).toContain('missing.md');
    // check never writes.
    expect(existsSync(join(badRoot, 'docs', 'site'))).toBe(false);
  });

  it('serve rebuilds then serves over real HTTP until the stop signal', async () => {
    const root = makeRoot();
    const controller = new AbortController();
    const io = captureIo(root, controller.signal);
    const run = runDocsCli(['serve', '--port', '0', '--out', 'prev'], io);

    // Wait for the "Serving ..." line, then fetch the index for real.
    const deadline = Date.now() + 10_000;
    while (!io.outLines.some((l) => l.startsWith('Serving BreadESP docs at ')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const serving = io.outLines.find((l) => l.startsWith('Serving BreadESP docs at '));
    expect(serving).toBeDefined();
    const url = /at (http:\/\/\S+)/.exec(serving!)![1];
    const res = await fetch(`${url}tutorials/01-a.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1 id="alpha">Alpha</h1>');

    controller.abort();
    expect(await run).toBe(0);
    expect(existsSync(join(root, 'prev', 'index.html'))).toBe(true); // serve rebuilt first
  }, 15_000);
});
