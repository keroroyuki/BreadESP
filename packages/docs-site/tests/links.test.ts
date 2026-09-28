// PRD: §F-DOC-3, dev-plan P5.4 — link resolution/rewriting unit tests.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLinkResolver, normalizePosix, relativeRoute } from '../src/links.js';
import type { DocsSite, LinkIssue, PageSource } from '../src/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-docs-links-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function makeRoot(): string {
  const dir = join(tmp, `root-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PAGE_A: PageSource = { sourcePath: 'docs/a.md', route: 'guides/a.html', section: 'guides' };
const PAGE_B: PageSource = { sourcePath: 'docs/sub/b.md', route: 'guides/b.html', section: 'guides' };
const PAGE_C: PageSource = { sourcePath: 'PRD.md', route: 'reference/prd.html', section: 'reference' };

/** Resolver fixture: three pages, b has the 'details' anchor, c has 's-6'. */
function resolverFor(current: PageSource, root: string): { resolve: (t: string, line?: number) => string; issues: LinkIssue[]; assets: Map<string, string> } {
  const site: DocsSite = { rootDir: root, pages: [PAGE_A, PAGE_B, PAGE_C] };
  const issues: LinkIssue[] = [];
  const assets = new Map<string, string>();
  const anchorsByRoute = new Map([
    ['guides/a.html', new Set(['top'])],
    ['guides/b.html', new Set(['details'])],
    ['reference/prd.html', new Set(['s-6'])],
  ]);
  const routeBySource = new Map([
    ['docs/a.md', 'guides/a.html'],
    ['docs/sub/b.md', 'guides/b.html'],
    ['PRD.md', 'reference/prd.html'],
  ]);
  return { resolve: (t, line = 1) => makeLinkResolver({ site, current, anchorsByRoute, routeBySource, issues, assets })(t, line), issues, assets };
}

describe('relativeRoute', () => {
  it('computes same-dir, child, parent and cross-section hrefs', () => {
    expect(relativeRoute('guides/a.html', 'guides/b.html')).toBe('b.html');
    expect(relativeRoute('guides/a.html', 'reference/prd.html')).toBe('../reference/prd.html');
    expect(relativeRoute('index.html', 'tutorials/01.html')).toBe('tutorials/01.html');
    expect(relativeRoute('tutorials/01.html', 'index.html')).toBe('../index.html');
    expect(relativeRoute('a/b/c.html', 'a/b/d.html')).toBe('d.html');
  });
});

describe('normalizePosix', () => {
  it('resolves dots and dot-dots against the stack', () => {
    expect(normalizePosix('docs/../PRD.md')).toBe('PRD.md');
    expect(normalizePosix('./docs//a.md')).toBe('docs/a.md');
    expect(normalizePosix('../../x.md')).toBe('../../x.md');
  });
});

describe('makeLinkResolver', () => {
  it('rewrites relative page links to route-relative hrefs', () => {
    const { resolve, issues } = resolverFor(PAGE_A, makeRoot());
    expect(resolve('sub/b.md')).toBe('b.html');
    expect(resolve('../PRD.md')).toBe('../reference/prd.html');
    expect(issues).toEqual([]);
  });

  it('preserves and verifies anchors against the target page', () => {
    const { resolve, issues } = resolverFor(PAGE_A, makeRoot());
    expect(resolve('sub/b.md#details')).toBe('b.html#details');
    expect(resolve('../PRD.md#s-6')).toBe('../reference/prd.html#s-6');
    expect(issues).toEqual([]);
    const bad = resolve('sub/b.md#nope', 42);
    expect(bad).toBe('sub/b.md#nope'); // fallback href on failure
    expect(issues).toEqual([{ page: 'guides/a.html', target: 'sub/b.md#nope', line: 42, reason: "anchor '#nope' not found in docs/sub/b.md" }]);
  });

  it('verifies anchor-only links against the current page', () => {
    const { resolve, issues } = resolverFor(PAGE_A, makeRoot());
    expect(resolve('#top')).toBe('#top');
    resolve('#missing');
    expect(issues[0].reason).toContain("anchor '#missing' not found on this page");
  });

  it('passes external links through untouched and unchecked', () => {
    const { resolve, issues } = resolverFor(PAGE_A, makeRoot());
    expect(resolve('https://example.com/x?y=1#z')).toBe('https://example.com/x?y=1#z');
    expect(resolve('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(resolve('//cdn.example.com/x.js')).toBe('//cdn.example.com/x.js');
    expect(issues).toEqual([]);
  });

  it('rejects links escaping the repository root and site-absolute links', () => {
    const { resolve, issues } = resolverFor(PAGE_C, makeRoot());
    resolve('../outside.md');
    resolve('/docs/a.md');
    expect(issues[0].reason).toContain('escapes the repository root');
    expect(issues[1].reason).toContain('site-absolute');
  });

  it('rejects Markdown files outside the site page set', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'stray.md'), '# stray\n', 'utf8');
    const { resolve, issues } = resolverFor(PAGE_A, root);
    resolve('stray.md');
    expect(issues[0].reason).toContain('not part of the docs site page set');
  });

  it('rejects targets that simply do not exist', () => {
    const { resolve, issues } = resolverFor(PAGE_A, makeRoot());
    resolve('ghost.md');
    expect(issues[0].reason).toContain('broken link');
  });

  it('registers existing non-Markdown assets for copying and rewrites to the asset route', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs', 'images'), { recursive: true });
    writeFileSync(join(root, 'docs', 'images', 'board.png'), 'fake-png', 'utf8');
    const { resolve, issues, assets } = resolverFor(PAGE_A, root);
    expect(resolve('images/board.png')).toBe('../assets/docs/images/board.png');
    expect(assets.get('docs/images/board.png')).toBe('assets/docs/images/board.png');
    expect(issues).toEqual([]);
  });

  it('collects multiple violations in one pass instead of failing fast', () => {
    const { resolve, issues } = resolverFor(PAGE_A, makeRoot());
    resolve('ghost.md', 3);
    resolve('#nope', 5);
    resolve('sub/b.md#alsono', 7);
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.line)).toEqual([3, 5, 7]);
  });
});
