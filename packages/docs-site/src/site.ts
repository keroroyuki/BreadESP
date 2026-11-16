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
import type { DocsSite, FrontMatter, LoadedPage, PageSource, SiteLang, SiteSectionId } from './types.js';

/** Repo root derived from this module's location (packages/docs-site/src/). */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');

/** Navigation section titles per content language. */
export const SITE_SECTIONS: { id: SiteSectionId; title: Record<SiteLang, string> }[] = [
  { id: 'tutorials', title: { zh: '教程', en: 'Tutorials' } },
  { id: 'guides', title: { zh: '指南', en: 'Guides' } },
  { id: 'reference', title: { zh: '参考', en: 'Reference' } },
];

/** Route prefix for English pages; Chinese pages keep the unprefixed routes. */
export const EN_PREFIX = 'en';

/**
 * zh/en source pairs for the pinned guide + reference pages. Chinese content is
 * the authored source; English mirrors live under `docs/en/` (root README.md is
 * the English overview).
 */
const PINNED_PAGES: {
  route: string;
  section: SiteSectionId;
  zh: { sourcePath: string; navTitle: string; description: string };
  en: { sourcePath: string; navTitle: string; description: string };
}[] = [
  {
    route: 'guides/readme.html',
    section: 'guides',
    zh: { sourcePath: 'docs/README.zh-CN.md', navTitle: '仓库概览', description: '仓库导览：快速开始、文档地图、包结构与 AI 协作约定。' },
    en: { sourcePath: 'README.md', navTitle: 'Project overview', description: 'Repository tour: quick start, docs map, package layout and AI conventions.' },
  },
  {
    route: 'guides/peripheral-sdk.html',
    section: 'guides',
    zh: { sourcePath: 'docs/peripheral-sdk.md', navTitle: '外设 SDK 指南', description: '外设 SDK 完整参考：注册、引脚与路由、快照、版本化、本地目录与脚手架。' },
    en: { sourcePath: 'docs/en/peripheral-sdk.md', navTitle: 'Peripheral SDK guide', description: 'Full peripheral SDK reference: registration, pins and routing, snapshots, versioning, local directories and scaffolding.' },
  },
  {
    route: 'guides/dap.html',
    section: 'guides',
    zh: { sourcePath: 'docs/dap.md', navTitle: 'DAP 适配器', description: 'DAP 适配器完整参考：两种 VS Code 接入方式、参数表与已知边界。' },
    en: { sourcePath: 'docs/en/dap.md', navTitle: 'DAP adapter guide', description: 'Full DAP adapter reference: the two VS Code setups, the parameter table and known limits.' },
  },
  {
    route: 'reference/prd.html',
    section: 'reference',
    zh: { sourcePath: 'PRD.md', navTitle: 'PRD（唯一真相源）', description: '唯一真相源：需求、接口契约（§6）、目录结构（§7）与 AI 工作约定。' },
    en: { sourcePath: 'docs/en/PRD.md', navTitle: 'PRD (source of truth)', description: 'Single source of truth: requirements, interface contracts (§6), directory layout (§7) and AI working conventions.' },
  },
  {
    route: 'reference/architecture.html',
    section: 'reference',
    zh: { sourcePath: 'docs/architecture.md', navTitle: '架构', description: '架构详解：进程模型、DBus 设备、外设路由、调试链路与持久化。' },
    en: { sourcePath: 'docs/en/architecture.md', navTitle: 'Architecture', description: 'Architecture deep dive: process model, DBus device, peripheral routing, debugging path and persistence.' },
  },
  {
    route: 'reference/dev-plan.html',
    section: 'reference',
    zh: { sourcePath: 'docs/dev-plan.md', navTitle: '开发计划', description: '开发计划与规范：里程碑、代码风格、提交规范、测试与验收清单。' },
    en: { sourcePath: 'docs/en/dev-plan.md', navTitle: 'Development plan', description: 'Plan and conventions: milestones, code style, commit rules, testing and acceptance checklists.' },
  },
  {
    route: 'reference/changelog.html',
    section: 'reference',
    zh: { sourcePath: 'CHANGELOG.md', navTitle: '变更记录', description: '变更记录（Keep a Changelog）：每个里程碑的实现与验证摘要。' },
    en: { sourcePath: 'docs/en/CHANGELOG.md', navTitle: 'Changelog', description: 'Changelog (Keep a Changelog): implementation and verification notes per milestone.' },
  },
];

/**
 * The canonical BreadESP docs site (PRD §F-DOC-1/2). `rootDir` is the repo
 * root that the repo-relative sourcePath values resolve against. Every page
 * exists in Chinese and English; the English routes carry the `en/` prefix.
 */
export function breadespSite(rootDir: string): DocsSite {
  const pages: PageSource[] = [];
  for (const lang of ['zh', 'en'] as const) {
    for (const file of discoverTutorials(rootDir, lang)) {
      pages.push({
        sourcePath: tutorialSourcePath(lang, file),
        route: tutorialRoute(lang, file),
        section: 'tutorials',
        lang,
      });
    }
  }
  for (const pinned of PINNED_PAGES) {
    pages.push({ ...pinned.zh, route: pinned.route, section: pinned.section, lang: 'zh' });
    pages.push({ ...pinned.en, route: `${EN_PREFIX}/${pinned.route}`, section: pinned.section, lang: 'en' });
  }
  return { rootDir, pages };
}

function tutorialSourcePath(lang: SiteLang, file: string): string {
  return lang === 'zh' ? `docs/tutorials/${file}` : `docs/en/tutorials/${file}`;
}

function tutorialRoute(lang: SiteLang, file: string): string {
  const route = `tutorials/${file.replace(/\.md$/i, '')}.html`;
  return lang === 'zh' ? route : `${EN_PREFIX}/${route}`;
}

/** Tutorial sources under docs/tutorials/ (zh) or docs/en/tutorials/ (en), byte-sorted. */
export function discoverTutorials(rootDir: string, lang: SiteLang = 'zh'): string[] {
  const dir = lang === 'zh' ? join(rootDir, 'docs', 'tutorials') : join(rootDir, 'docs', 'en', 'tutorials');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/** Route of the same page in the other language ('index.html' ↔ 'en/index.html'). */
export function counterpartRoute(route: string, lang: SiteLang): string {
  return lang === 'zh' ? `${EN_PREFIX}/${route}` : route.slice(EN_PREFIX.length + 1);
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

/** Navigation model in manifest order for one language; empty sections are dropped. */
export function siteNav(pages: LoadedPage[], lang: SiteLang = 'zh'): NavModel {
  const sections = SITE_SECTIONS.map((s) => ({ id: s.id, title: s.title[lang], pages: [] as { route: string; title: string }[] }));
  for (const page of pages) {
    if (page.source.lang !== lang) continue;
    const section = sections.find((s) => s.id === page.source.section);
    if (section) section.pages.push({ route: page.source.route, title: pageTitle(page) });
  }
  return { sections: sections.filter((s) => s.pages.length > 0) };
}
