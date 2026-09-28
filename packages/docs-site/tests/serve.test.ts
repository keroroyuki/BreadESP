// PRD: §F-DOC-5, dev-plan P5.4 — preview server tests over a real loopback
// socket (port 0 = ephemeral) against a real built fixture site.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../src/build.js';
import { serveDocs } from '../src/serve.js';
import { breadespSite } from '../src/site.js';
import type { RunningServer } from '../src/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-docs-serve-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let server: RunningServer | null = null;
afterAll(async () => {
  await server?.close();
});

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(url, init);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

describe('serveDocs', () => {
  it('serves the built site with correct MIME and no-store over real HTTP', async () => {
    // Build a minimal fixture site (one tutorial + all pinned sources).
    const root = join(tmp, 'repo');
    mkdirSync(join(root, 'docs', 'tutorials'), { recursive: true });
    writeFileSync(join(root, 'docs', 'tutorials', '01-a.md'), '# Alpha\n\nhello\n', 'utf8');
    writeFileSync(join(root, 'README.md'), '# R\n', 'utf8');
    writeFileSync(join(root, 'PRD.md'), '# P\n', 'utf8');
    writeFileSync(join(root, 'CHANGELOG.md'), '# C\n', 'utf8');
    for (const doc of ['architecture', 'dap', 'peripheral-sdk', 'dev-plan']) {
      writeFileSync(join(root, 'docs', `${doc}.md`), `# ${doc}\n`, 'utf8');
    }
    const outDir = join(root, 'out');
    writeFileSync(join(root, 'marker.css'), 'body{}', 'utf8'); // not served: outside outDir
    buildSite(breadespSite(root), outDir);
    writeFileSync(join(outDir, 'extra.css'), 'body { color: red; }', 'utf8');

    server = await serveDocs(outDir, { port: 0 });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const index = await fetchText(`${server.url}`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(index.body).toContain('BreadESP Docs');

    const page = await fetchText(`${server.url}tutorials/01-a.html`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<h1 id="alpha">Alpha</h1>');

    const css = await fetchText(`${server.url}extra.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('maps / and directories to index.html', async () => {
    const res = await fetchText(`${server!.url}tutorials/`);
    expect(res.status).toBe(404); // tutorials/ has no index.html of its own
    const root = await fetchText(`${server!.url}/`);
    expect(root.status).toBe(200);
  });

  it('rejects traversal attempts (plain, backslash and URL-encoded) with 403', async () => {
    for (const path of ['/../package.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json']) {
      const res = await fetch(`${server!.url}${path}`);
      await res.arrayBuffer(); // drain
      // Node's fetch normalizes '/..' away before sending; the encoded forms
      // reach the server and must be rejected.
      expect([403, 404]).toContain(res.status);
    }
    const encoded = await fetchText(`${server!.url}%2e%2e%2fpackage.json`);
    expect(encoded.status).toBe(403);
  });

  it('returns 404 for missing files and 405 for non-GET methods', async () => {
    expect((await fetchText(`${server!.url}nope.html`)).status).toBe(404);
    const res = await fetch(`${server!.url}index.html`, { method: 'POST', body: 'x' });
    await res.text();
    expect(res.status).toBe(405);
  });

  it('answers HEAD with headers and no body', async () => {
    const res = await fetch(`${server!.url}index.html`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await res.text()).toBe('');
  });
});
