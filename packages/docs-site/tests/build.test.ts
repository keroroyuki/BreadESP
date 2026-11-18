// PRD: §F-DOC-1/3/4, dev-plan P5.4 — build orchestration tests over real temp
// fixture repos, plus the whole-repo build against the actual workspace docs
// (the literal F-DOC-1/F-DOC-3 acceptance: the real site builds with zero link
// violations and rewrites every cross-document link).
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, checkSite, SITE_MARKER } from '../src/build.js';
import { breadespSite, REPO_ROOT } from '../src/site.js';
import type { DocsSite } from '../src/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-docs-build-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function makeRoot(): string {
  const dir = join(tmp, `root-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Minimal but complete fixture repo: every pinned manifest source plus two
 * tutorials, with cross-links in both directions and one anchor link.
 */
function makeFixtureRepo(overrides: { aExtra?: string; prdExtra?: string; withImage?: boolean } = {}): string {
  const root = makeRoot();
  mkdirSync(join(root, 'docs', 'tutorials'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'tutorials', '01-start.md'),
    `---\ntitle: Start here\ndescription: First card.\n---\n# Start\n\nGo to [guide](../peripheral-sdk.md) and [next](02-next.md#details).\n${overrides.aExtra ?? ''}`,
    'utf8',
  );
  writeFileSync(
    join(root, 'docs', 'tutorials', '02-next.md'),
    `---\ntitle: Next steps\ndescription: Second card.\n---\n# Next\n\n## Details\n\nBack to [start](01-start.md).\n`,
    'utf8',
  );
  writeFileSync(join(root, 'README.md'), '# Fixture Repo\n\nSee [PRD](docs/en/PRD.md).\n', 'utf8');
  writeFileSync(join(root, 'docs', 'README.zh-CN.md'), '# 仓库概览\n\n见 [PRD](../PRD.md)。\n', 'utf8');
  writeFileSync(join(root, 'PRD.md'), `# PRD\n\n## 6. Contracts\n\nBody.\n${overrides.prdExtra ?? ''}`, 'utf8');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n- entry\n', 'utf8');
  for (const doc of ['architecture', 'dap', 'peripheral-sdk', 'dev-plan']) {
    writeFileSync(join(root, 'docs', `${doc}.md`), `# ${doc}\n\nBody with [PRD](../PRD.md#6-contracts) link.\n`, 'utf8');
  }
  // English mirrors: every pinned page plus two tutorials (docs/en/).
  mkdirSync(join(root, 'docs', 'en', 'tutorials'), { recursive: true });
  writeFileSync(join(root, 'docs', 'en', 'tutorials', '01-start.md'), '# Start EN\n\nGo to [guide](../peripheral-sdk.md).\n', 'utf8');
  writeFileSync(join(root, 'docs', 'en', 'tutorials', '02-next.md'), '# Next EN\n\nBack to [start](01-start.md).\n', 'utf8');
  writeFileSync(join(root, 'docs', 'en', 'PRD.md'), '# PRD\n\n## 6. Contracts\n\nBody.\n', 'utf8');
  writeFileSync(join(root, 'docs', 'en', 'CHANGELOG.md'), '# Changelog\n\n- entry\n', 'utf8');
  for (const doc of ['architecture', 'dap', 'peripheral-sdk', 'dev-plan']) {
    writeFileSync(join(root, 'docs', 'en', `${doc}.md`), `# ${doc}\n\nBody.\n`, 'utf8');
  }
  if (overrides.withImage) {
    mkdirSync(join(root, 'docs', 'images'), { recursive: true });
    writeFileSync(join(root, 'docs', 'images', 'board.png'), 'fake-png-bytes', 'utf8');
  }
  return root;
}

describe('buildSite on a fixture repo', () => {
  it('renders every page + index, rewrites links and copies assets', () => {
    const root = makeFixtureRepo({ withImage: true });
    // Add an image link to one tutorial.
    const tut = join(root, 'docs', 'tutorials', '01-start.md');
    writeFileSync(tut, readFileSync(tut, 'utf8') + '\n![board](../images/board.png)\n', 'utf8');
    const outDir = join(root, 'out');
    const report = buildSite(breadespSite(root), outDir);

    expect(report.pageCount).toBe(18); // 9 zh pages + 9 English mirrors
    expect(report.files).toContain('index.html');
    expect(report.files).toContain('tutorials/01-start.html');
    expect(report.files).toContain('reference/prd.html');
    expect(report.files).toContain('assets/docs/images/board.png');
    expect(report.files).toContain(SITE_MARKER);
    expect(readFileSync(join(outDir, 'assets', 'docs', 'images', 'board.png'), 'utf8')).toBe('fake-png-bytes');

    const tutHtml = readFileSync(join(outDir, 'tutorials', '01-start.html'), 'utf8');
    // Cross-page rewrite: ../peripheral-sdk.md → ../guides/peripheral-sdk.html
    expect(tutHtml).toContain('href="../guides/peripheral-sdk.html"');
    // Anchor link to a sibling page keeps the verified fragment.
    expect(tutHtml).toContain('href="02-next.html#details"');
    // Image asset rewrite (one level up from tutorials/).
    expect(tutHtml).toContain('src="../assets/docs/images/board.png"');
    // The dev-plan fixture's anchor into the PRD fixture resolves and rewrites.
    const devplanHtml = readFileSync(join(outDir, 'reference', 'dev-plan.html'), 'utf8');
    expect(devplanHtml).toContain('href="prd.html#6-contracts"');
  });

  it('renders nav with the active page marked and per-page TOCs from h2/h3', () => {
    const root = makeFixtureRepo();
    const outDir = join(root, 'out');
    buildSite(breadespSite(root), outDir);
    const html = readFileSync(join(outDir, 'tutorials', '02-next.html'), 'utf8');
    expect(html).toContain('class="active" aria-current="page"');
    expect(html).toContain('本页目录');
    expect(html).toContain('href="#details"');
    // The nav links out of a nested route are relative (../reference/...).
    expect(html).toContain('href="../reference/prd.html"');
    // Front-matter title is used in the nav and the <title>.
    expect(html).toContain('<title>Next steps · BreadESP Docs</title>');
    // The language switch points at the English mirror of this page.
    expect(html).toContain('href="../en/tutorials/02-next.html"');
  });

  it('builds a landing index with section cards and descriptions', () => {
    const root = makeFixtureRepo();
    const outDir = join(root, 'out');
    buildSite(breadespSite(root), outDir);
    const index = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(index).toContain('教程');
    expect(index).toContain('指南');
    expect(index).toContain('参考');
    expect(index).toContain('href="tutorials/01-start.html"');
    expect(index).toContain('First card.');
    expect(index).toContain('BreadESP Docs');
    // The English index lives under en/ and links its own page set.
    const enIndex = readFileSync(join(outDir, 'en', 'index.html'), 'utf8');
    expect(enIndex).toContain('Tutorials');
    expect(enIndex).toContain('href="tutorials/01-start.html"');
    expect(enIndex).toContain('href="../index.html"'); // language switch back to zh
  });

  it('is byte-reproducible across two builds (F-DOC-4)', () => {
    const root = makeFixtureRepo({ withImage: true });
    const outA = join(root, 'out-a');
    const outB = join(root, 'out-b');
    const reportA = buildSite(breadespSite(root), outA);
    const reportB = buildSite(breadespSite(root), outB);
    expect(reportA.files).toEqual(reportB.files);
    for (const file of reportA.files) {
      expect(readFileSync(join(outB, file), 'utf8')).toBe(readFileSync(join(outA, file), 'utf8'));
    }
  });

  it('cleans stale files on rebuild but refuses a foreign non-empty directory ([BB-242])', () => {
    const root = makeFixtureRepo();
    const outDir = join(root, 'out');
    buildSite(breadespSite(root), outDir);
    // Stale file from a "previous" build vanishes after a rebuild.
    writeFileSync(join(outDir, 'stale.html'), 'stale', 'utf8');
    buildSite(breadespSite(root), outDir);
    expect(existsSync(join(outDir, 'stale.html'))).toBe(false);

    const foreign = join(root, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'keep.me'), 'precious', 'utf8');
    expect(() => buildSite(breadespSite(root), foreign)).toThrow(/\[BB-242\].*refusing to clean/);
    expect(readFileSync(join(foreign, 'keep.me'), 'utf8')).toBe('precious'); // untouched
  });

  it('fails the build with one coded [BB-241] listing every violation, before any write', () => {
    const root = makeFixtureRepo({ aExtra: '\n[ghost](missing.md) and [bad anchor](02-next.md#nope).\n' });
    const outDir = join(root, 'out');
    let caught: unknown;
    try {
      buildSite(breadespSite(root), outDir);
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;
    expect(message).toContain('[BB-241] docs site content validation failed (2 issues)');
    expect(message).toContain("broken link: 'docs/tutorials/missing.md' does not exist");
    expect(message).toContain("anchor '#nope' not found in docs/tutorials/02-next.md");
    expect(existsSync(outDir)).toBe(false); // gate runs before prepareOutDir
  });

  it('reports missing sources and an empty tutorials section via [BB-241]', () => {
    const root = makeRoot(); // nothing at all
    expect(() => checkSite(breadespSite(root))).toThrow(/\[BB-241\][\s\S]*no tutorial pages discovered/);
  });

  it('checkSite validates without writing anything', () => {
    const root = makeFixtureRepo();
    const result = checkSite(breadespSite(root));
    expect(result.pageCount).toBe(18);
    expect(result.linkCount).toBeGreaterThan(0);
    expect(readdirSync(root)).not.toContain('out');
  });
});

describe('whole-repo build (the real BreadESP docs)', () => {
  const realSite: DocsSite = breadespSite(REPO_ROOT);

  it('passes the link gate with zero violations', () => {
    const result = checkSite(realSite);
    // 13 Chinese pages + 13 English mirrors (PRD §F-DOC-1/2 page set).
    expect(result.pageCount).toBe(26);
    expect(result.linkCount).toBeGreaterThan(80);
  });

  it('builds every page and rewrites the known cross-document links', () => {
    const outDir = join(tmp, 'real-site');
    const report = buildSite(realSite, outDir);
    expect(report.pageCount).toBe(26);
    expect(report.files).toEqual(
      expect.arrayContaining([
        SITE_MARKER,
        'index.html',
        'en/index.html',
        'tutorials/01-getting-started.html',
        'tutorials/06-vscode-dap.html',
        'guides/readme.html',
        'guides/peripheral-sdk.html',
        'guides/dap.html',
        'reference/prd.html',
        'reference/architecture.html',
        'reference/dev-plan.html',
        'reference/changelog.html',
        'en/tutorials/01-getting-started.html',
        'en/guides/readme.html',
        'en/reference/prd.html',
      ]),
    );
    // README's ./docs/dev-plan.md becomes a route href, not a repo path.
    const readme = readFileSync(join(outDir, 'guides', 'readme.html'), 'utf8');
    expect(readme).toContain('href="../reference/dev-plan.html"');
    expect(readme).not.toContain('href="./docs/dev-plan.md"');
    // The English overview is the repo README and links the English page set.
    const enReadme = readFileSync(join(outDir, 'en', 'guides', 'readme.html'), 'utf8');
    expect(enReadme).toContain('href="../../reference/dev-plan.html"');
    expect(enReadme).toContain('href="../../tutorials/01-getting-started.html"');
    // dev-plan's TOC self-anchors survived the GitHub-compatible slugger.
    const devplan = readFileSync(join(outDir, 'reference', 'dev-plan.html'), 'utf8');
    expect(devplan).toContain('id="12-验收检查清单"');
    expect(devplan).toContain('href="#12-验收检查清单"');
    // Tutorial cross-links resolved through the site.
    const tut2 = readFileSync(join(outDir, 'tutorials', '02-first-project.html'), 'utf8');
    expect(tut2).toContain('href="03-debugging.html"');
    expect(tut2).toContain('href="../reference/architecture.html"');
    // Raw HTML in the sources is escaped, never passed through.
    expect(readFileSync(join(outDir, 'reference', 'prd.html'), 'utf8')).not.toContain('<script>');
  });
});
