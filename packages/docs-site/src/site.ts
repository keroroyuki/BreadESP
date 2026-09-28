// PRD: §F-DOC-1/2 — site manifest, front matter, page loading (P5.4).
//
// The manifest is code (not a config file) so the page set type-checks and the
// build stays zero-dependency. Tutorial pages are discovered from
// docs/tutorials/*.md in byte-sorted filename order (the 01-/02-… prefixes are
// the tutorial order, PRD §F-DOC-2); guides/reference pages are pinned.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './markdown.js';
import type { DocsSite, FrontMatter, LoadedPage, PageSource, SiteSectionId } from './types.js';

/** Repo root derived from this module's location (packages/docs-site/src/). */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');

/** Navigation section titles (site chrome is English; content stays as authored). */
export const SITE_SECTIONS: { id: SiteSectionId; title: string }[] = [
  { id: 'tutorials', title: 'Tutorials' },
  { id: 'guides', title: 'Guides' },
  { id: 'reference', title: 'Reference' },
];

/**
 * The canonical BreadESP docs site (PRD §F-DOC-1/2). `rootDir` is the repo
 * root that the repo-relative sourcePath values resolve against.
 */
export function breadespSite(rootDir: string): DocsSite {
  const pages: PageSource[] = [];
  for (const file of discoverTutorials(rootDir)) {
    pages.push({
      sourcePath: `docs/tutorials/${file}`,
      route: `tutorials/${file.replace(/\.md$/i, '')}.html`,
      section: 'tutorials',
    });
  }
  pages.push(
    {
      sourcePath: 'README.md',
      route: 'guides/readme.html',
      section: 'guides',
      navTitle: 'Project overview',
      description: '仓库导览：快速开始、文档地图、包结构与 AI 协作约定。',
    },
    {
      sourcePath: 'docs/peripheral-sdk.md',
      route: 'guides/peripheral-sdk.html',
      section: 'guides',
      navTitle: 'Peripheral SDK guide',
      description: '外设 SDK 完整参考：注册、引脚与路由、快照、版本化、本地目录与脚手架。',
    },
    {
      sourcePath: 'docs/dap.md',
      route: 'guides/dap.html',
      section: 'guides',
      navTitle: 'DAP adapter guide',
      description: 'DAP 适配器完整参考：两种 VS Code 接入方式、参数表与已知边界。',
    },
    {
      sourcePath: 'PRD.md',
      route: 'reference/prd.html',
      section: 'reference',
      navTitle: 'PRD (source of truth)',
      description: '唯一真相源：需求、接口契约（§6）、目录结构（§7）与 AI 工作约定。',
    },
    {
      sourcePath: 'docs/architecture.md',
      route: 'reference/architecture.html',
      section: 'reference',
      navTitle: 'Architecture',
      description: '架构详解：进程模型、DBus 设备、外设路由、调试链路与持久化。',
    },
    {
      sourcePath: 'docs/dev-plan.md',
      route: 'reference/dev-plan.html',
      section: 'reference',
      navTitle: 'Development plan',
      description: '开发计划与规范：里程碑、代码风格、提交规范、测试与验收清单。',
    },
    {
      sourcePath: 'CHANGELOG.md',
      route: 'reference/changelog.html',
      section: 'reference',
      navTitle: 'Changelog',
      description: '变更记录（Keep a Changelog）：每个里程碑的实现与验证摘要。',
    },
  );
  return { rootDir, pages };
}

/** Tutorial sources under docs/tutorials/, byte-sorted (deterministic order). */
export function discoverTutorials(rootDir: string): string[] {
  const dir = join(rootDir, 'docs', 'tutorials');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Parse the optional front-matter block (`---` fenced `key: value` lines at the
 * very start of the file). Strict by design: unknown keys and malformed lines
 * are collected as issues (a typo must fail the build, not silently drop).
 */
export function parseFrontMatter(raw: string): { meta: FrontMatter; body: string; issues: string[] } {
  const normalized = raw.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized, issues: [] };
  const lines = normalized.split('\n');
  const close = lines.indexOf('---', 1);
  if (close === -1) {
    return { meta: {}, body: normalized, issues: ['unterminated front matter (missing closing ---)'] };
  }
  const meta: FrontMatter = {};
  const issues: string[] = [];
  for (const line of lines.slice(1, close)) {
    if (line.trim() === '') continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!m) {
      issues.push(`malformed front matter line '${line}'`);
      continue;
    }
    const value = unquote(m[2].trim());
    if (m[1] === 'title') meta.title = value;
    else if (m[1] === 'description') meta.description = value;
    else issues.push(`unknown front matter key '${m[1]}' (supported: title, description)`);
  }
  return { meta, body: lines.slice(close + 1).join('\n'), issues };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Read and first-pass-render every page in the manifest. Never throws: missing
 * sources and front-matter problems come back as issues for the [BB-241] gate.
 */
export function loadSite(site: DocsSite): { pages: LoadedPage[]; issues: string[] } {
  const pages: LoadedPage[] = [];
  const issues: string[] = [];
  for (const source of site.pages) {
    const path = join(site.rootDir, source.sourcePath);
    if (!existsSync(path)) {
      issues.push(`${source.sourcePath}: source file not found`);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      issues.push(`${source.sourcePath}: unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const { meta, body, issues: metaIssues } = parseFrontMatter(raw);
    for (const issue of metaIssues) issues.push(`${source.sourcePath}: ${issue}`);
    pages.push({ source, meta, body, rendered: renderMarkdown(body) });
  }
  return { pages, issues };
}

/** Title resolution: front matter > manifest navTitle > first H1 > route. */
export function pageTitle(page: LoadedPage): string {
  return page.meta.title ?? page.source.navTitle ?? page.rendered.headings.find((h) => h.level === 1)?.text ?? page.source.route;
}

/** Index-card description: front matter > manifest description. */
export function pageDescription(page: LoadedPage): string {
  return page.meta.description ?? page.source.description ?? '';
}

export interface NavModel {
  sections: { id: SiteSectionId; title: string; pages: { route: string; title: string }[] }[];
}

/** Navigation model in manifest order; empty sections are dropped. */
export function siteNav(pages: LoadedPage[]): NavModel {
  const sections = SITE_SECTIONS.map((s) => ({ ...s, pages: [] as { route: string; title: string }[] }));
  for (const page of pages) {
    const section = sections.find((s) => s.id === page.source.section);
    if (section) section.pages.push({ route: page.source.route, title: pageTitle(page) });
  }
  return { sections: sections.filter((s) => s.pages.length > 0) };
}
