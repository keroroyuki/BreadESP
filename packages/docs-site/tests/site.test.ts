// PRD: §F-DOC-1/2, dev-plan P5.4 — site manifest + front matter tests.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { breadespSite, discoverTutorials, loadSite, pageDescription, pageTitle, parseFrontMatter, siteNav } from '../src/site.js';

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-docs-site-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
/** Fresh fixture repo root per test. */
function makeRoot(): string {
  const dir = join(tmp, `root-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTutorial(root: string, name: string, body: string): void {
  mkdirSync(join(root, 'docs', 'tutorials'), { recursive: true });
  writeFileSync(join(root, 'docs', 'tutorials', name), body, 'utf8');
}

describe('breadespSite manifest', () => {
  it('discovers tutorials in byte-sorted filename order with matching routes', () => {
    const root = makeRoot();
    writeTutorial(root, '02-second.md', '# Two\n');
    writeTutorial(root, '01-first.md', '# One\n');
    writeTutorial(root, 'notes.txt', 'not markdown');
    expect(discoverTutorials(root)).toEqual(['01-first.md', '02-second.md']);
    const site = breadespSite(root);
    const tutorials = site.pages.filter((p) => p.section === 'tutorials');
    expect(tutorials.map((p) => p.route)).toEqual(['tutorials/01-first.html', 'tutorials/02-second.html']);
    expect(tutorials[0].sourcePath).toBe('docs/tutorials/01-first.md');
  });

  it('pins the guides and reference pages in a stable order with unique routes', () => {
    const site = breadespSite(makeRoot());
    const pinned = site.pages.filter((p) => p.section !== 'tutorials');
    expect(pinned.map((p) => p.route)).toEqual([
      'guides/readme.html',
      'guides/peripheral-sdk.html',
      'guides/dap.html',
      'reference/prd.html',
      'reference/architecture.html',
      'reference/dev-plan.html',
      'reference/changelog.html',
    ]);
    const routes = site.pages.map((p) => p.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('returns an empty tutorial section when the directory is missing', () => {
    expect(discoverTutorials(makeRoot())).toEqual([]);
  });
});

describe('parseFrontMatter', () => {
  it('parses title/description and returns the stripped body', () => {
    const { meta, body, issues } = parseFrontMatter('---\ntitle: 快速上手\ndescription: 安装与首跑\n---\n# H1\n\ntext\n');
    expect(meta).toEqual({ title: '快速上手', description: '安装与首跑' });
    expect(body.startsWith('# H1')).toBe(true);
    expect(issues).toEqual([]);
  });

  it('unquotes quoted values and normalizes CRLF', () => {
    const { meta, body } = parseFrontMatter('---\r\ntitle: "Quoted: title"\r\n---\r\nbody');
    expect(meta.title).toBe('Quoted: title');
    expect(body).toBe('body');
  });

  it('passes through documents without front matter untouched', () => {
    const { meta, body, issues } = parseFrontMatter('# Just a heading\n');
    expect(meta).toEqual({});
    expect(body).toBe('# Just a heading\n');
    expect(issues).toEqual([]);
  });

  it('fails loudly on unknown keys, malformed lines and unterminated blocks', () => {
    expect(parseFrontMatter('---\norder: 3\n---\nx').issues[0]).toContain("unknown front matter key 'order'");
    expect(parseFrontMatter('---\nnot a pair\n---\nx').issues[0]).toContain("malformed front matter line 'not a pair'");
    expect(parseFrontMatter('---\ntitle: oops\n').issues[0]).toContain('unterminated front matter');
  });
});

describe('loadSite + title/description resolution', () => {
  it('prefers front matter, then manifest navTitle, then the first H1', () => {
    const root = makeRoot();
    writeTutorial(root, '01-a.md', '---\ntitle: From Matter\ndescription: Card text\n---\n# Heading Title\n');
    writeTutorial(root, '02-b.md', '# Heading Only\n');
    writeFileSync(join(root, 'README.md'), '# Repo Heading\n', 'utf8');
    const { pages, issues } = loadSite(breadespSite(root));
    const a = pages.find((p) => p.source.route === 'tutorials/01-a.html')!;
    const b = pages.find((p) => p.source.route === 'tutorials/02-b.html')!;
    const readme = pages.find((p) => p.source.route === 'guides/readme.html')!;
    expect(pageTitle(a)).toBe('From Matter');
    expect(pageDescription(a)).toBe('Card text');
    expect(pageTitle(b)).toBe('Heading Only');
    // The fixture lacks the other pinned sources; their absence is reported.
    expect(issues.some((i) => i.includes('PRD.md: source file not found'))).toBe(true);
    expect(pageTitle(readme)).toBe('Project overview'); // manifest navTitle beats the H1
  });

  it('manifest navTitle wins over the first H1 when front matter is absent', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'README.md'), '# BreadESP — ESP32 虚拟面包板仿真器\n', 'utf8');
    const { pages } = loadSite(breadespSite(root));
    const readme = pages.find((p) => p.source.route === 'guides/readme.html')!;
    expect(pageTitle(readme)).toBe('Project overview');
    expect(pageDescription(readme)).toContain('仓库导览');
  });

  it('reports missing sources as issues without throwing', () => {
    const { pages, issues } = loadSite(breadespSite(makeRoot()));
    expect(pages).toEqual([]);
    expect(issues.some((i) => i.includes('PRD.md: source file not found'))).toBe(true);
    expect(issues.some((i) => i.includes('docs/tutorials'))).toBe(false); // absence is not per-file noise
  });
});

describe('siteNav', () => {
  it('groups pages into sections in manifest order and drops empty sections', () => {
    const root = makeRoot();
    writeTutorial(root, '01-a.md', '---\ntitle: Alpha\n---\n# A\n');
    writeFileSync(join(root, 'PRD.md'), '# PRD\n', 'utf8');
    const { pages } = loadSite(breadespSite(root));
    const nav = siteNav(pages);
    expect(nav.sections.map((s) => s.title)).toEqual(['Tutorials', 'Reference']);
    expect(nav.sections[0].pages).toEqual([{ route: 'tutorials/01-a.html', title: 'Alpha' }]);
    expect(nav.sections[1].pages).toEqual([{ route: 'reference/prd.html', title: 'PRD (source of truth)' }]);
  });
});
