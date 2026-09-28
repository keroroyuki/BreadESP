// PRD: §F-DOC-1 — HTML shell + inline CSS for the offline docs site (P5.4).
//
// Zero external resources, zero JavaScript: the whole theme is one inline
// <style> block, so every generated page is self-contained and works from
// file:// or the preview server alike. Templates are pure string functions —
// deterministic output (no timestamps, no random ids).
import { escapeHtml } from './markdown.js';
import { relativeRoute } from './links.js';
import type { NavModel } from './site.js';
import type { HeadingInfo } from './types.js';

export const SITE_TITLE = 'BreadESP Docs';

export const SITE_CSS = `
:root {
  --bg: #0d1117; --bg-soft: #161b22; --bg-softer: #1c2230; --border: #2d333f;
  --fg: #e6edf3; --fg-dim: #9da7b3; --accent: #58a6ff; --accent-soft: #1f6feb33;
  --code-bg: #161b22; --ok: #3fb950;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", system-ui, sans-serif;
}
.topbar {
  display: flex; align-items: baseline; gap: 12px; padding: 14px 24px;
  border-bottom: 1px solid var(--border); background: var(--bg-soft);
  position: sticky; top: 0; z-index: 10;
}
.topbar .brand { color: var(--fg); font-weight: 700; font-size: 18px; text-decoration: none; }
.topbar .brand span { color: var(--accent); }
.topbar .env { color: var(--fg-dim); font-size: 12.5px; }
.layout {
  display: grid; grid-template-columns: 250px minmax(0, 1fr) 220px;
  gap: 32px; max-width: 1440px; margin: 0 auto; padding: 28px 24px 64px;
}
.layout.no-toc { grid-template-columns: 250px minmax(0, 1fr); }
.sidebar, .toc { position: sticky; top: 76px; align-self: start; max-height: calc(100vh - 100px); overflow: auto; }
.sidebar h2, .toc h2 {
  font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--fg-dim); margin: 18px 0 6px;
}
.sidebar h2:first-child { margin-top: 0; }
.sidebar ul, .toc ul { list-style: none; margin: 0; padding: 0; }
.sidebar a {
  display: block; padding: 4px 10px; border-radius: 6px; color: var(--fg);
  text-decoration: none; font-size: 14px; border-left: 2px solid transparent;
}
.sidebar a:hover { background: var(--bg-softer); }
.sidebar a.active { color: var(--accent); border-left-color: var(--accent); background: var(--accent-soft); }
.toc a { display: block; color: var(--fg-dim); text-decoration: none; font-size: 13px; padding: 2px 0 2px 10px; }
.toc a:hover { color: var(--accent); }
.toc .toc-h3 { padding-left: 26px; font-size: 12.5px; }
.content { min-width: 0; }
article { max-width: 880px; }
article h1 { font-size: 30px; margin: 0 0 18px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
article h2 { font-size: 23px; margin: 34px 0 12px; padding-top: 6px; border-top: 1px solid var(--border); }
article h3 { font-size: 18px; margin: 26px 0 10px; }
article h4, article h5, article h6 { font-size: 15.5px; margin: 20px 0 8px; }
article p { margin: 12px 0; }
article a { color: var(--accent); text-decoration: none; }
article a:hover { text-decoration: underline; }
article code {
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 5px;
  padding: 1px 6px; font-size: 0.88em;
  font-family: ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace;
}
article pre {
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 14px 16px; overflow-x: auto; font-size: 13.5px; line-height: 1.55;
}
article pre code { background: none; border: none; padding: 0; font-size: inherit; }
article table { border-collapse: collapse; margin: 14px 0; width: 100%; font-size: 14.5px; }
article th, article td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
article th { background: var(--bg-soft); }
article tr:nth-child(even) td { background: #12161d; }
article blockquote {
  margin: 14px 0; padding: 6px 16px; color: var(--fg-dim);
  border-left: 3px solid var(--accent); background: var(--bg-soft); border-radius: 0 6px 6px 0;
}
article ul, article ol { padding-left: 26px; margin: 10px 0; }
article li { margin: 4px 0; }
article li > ul, article li > ol { margin: 4px 0; }
article input[type="checkbox"] { accent-color: var(--accent); margin-right: 2px; vertical-align: -1px; }
article hr { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
article img { max-width: 100%; }
.foot { border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 12.5px; padding: 18px 24px; text-align: center; }
.hero { padding: 26px 0 8px; }
.hero h1 { border: none; margin-bottom: 6px; }
.hero p { color: var(--fg-dim); font-size: 16.5px; margin: 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; margin: 14px 0 30px; }
.card {
  display: block; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 16px; text-decoration: none; color: var(--fg);
}
.card:hover { border-color: var(--accent); }
.card .card-title { color: var(--accent); font-weight: 600; margin-bottom: 4px; }
.card .card-desc { color: var(--fg-dim); font-size: 13.5px; }
@media (max-width: 1120px) { .toc { display: none; } .layout { grid-template-columns: 230px minmax(0, 1fr); } }
@media (max-width: 800px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: static; max-height: none; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
}
`;

export interface PageRenderArgs {
  /** Page title (nav/heading), plain text — escaped here. */
  title: string;
  /** Current page route (nav highlighting + relative hrefs). */
  route: string;
  contentHtml: string;
  headings: HeadingInfo[];
  nav: NavModel;
  /** Total rendered page count (footer stat). */
  pageCount: number;
}

function navHtml(nav: NavModel, currentRoute: string): string {
  return nav.sections
    .map((section) => {
      const items = section.pages
        .map((page) => {
          const href = relativeRoute(currentRoute, page.route);
          const active = page.route === currentRoute;
          return `<li><a href="${escapeHtml(href)}"${active ? ' class="active" aria-current="page"' : ''}>${escapeHtml(page.title)}</a></li>`;
        })
        .join('\n');
      return `<h2>${escapeHtml(section.title)}</h2>\n<ul>\n${items}\n</ul>`;
    })
    .join('\n');
}

function tocHtml(headings: HeadingInfo[]): string {
  const entries = headings.filter((h) => h.level === 2 || h.level === 3);
  if (entries.length === 0) return '';
  const items = entries
    .map((h) => `<li><a class="toc-h${h.level}" href="#${escapeHtml(h.slug)}">${escapeHtml(h.text)}</a></li>`)
    .join('\n');
  return `<h2>On this page</h2>\n<ul>\n${items}\n</ul>`;
}

function shell(args: PageRenderArgs & { mainHtml: string }): string {
  const homeHref = relativeRoute(args.route, 'index.html');
  const toc = tocHtml(args.headings);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(args.title)} · ${SITE_TITLE}</title>
<style>${SITE_CSS}</style>
</head>
<body>
<header class="topbar"><a class="brand" href="${escapeHtml(homeHref)}">BreadESP <span>Docs</span></a><span class="env">offline build · zero external resources</span></header>
<div class="layout${toc === '' ? ' no-toc' : ''}">
<nav class="sidebar" aria-label="Site">
${navHtml(args.nav, args.route)}
</nav>
<main class="content">
${args.mainHtml}
</main>
${toc === '' ? '' : `<aside class="toc" aria-label="On this page">\n${toc}\n</aside>`}
</div>
<footer class="foot">BreadESP offline documentation · generated from the repository Markdown sources · ${args.pageCount} pages</footer>
</body>
</html>
`;
}

/** Render one content page through the site shell. */
export function renderPage(args: PageRenderArgs): string {
  return shell({ ...args, mainHtml: `<article>\n${args.contentHtml}\n</article>` });
}

export interface IndexRenderArgs {
  route: string; // 'index.html'
  nav: NavModel;
  pageCount: number;
  /** Cards per section, in nav order. */
  cards: { sectionTitle: string; pages: { route: string; title: string; description: string }[] }[];
}

/** Render the landing page: hero + per-section page cards. */
export function renderIndex(args: IndexRenderArgs): string {
  const sections = args.cards
    .map((section) => {
      const cards = section.pages
        .map((page) => {
          const href = relativeRoute(args.route, page.route);
          const desc = page.description === '' ? '' : `<div class="card-desc">${escapeHtml(page.description)}</div>`;
          return `<a class="card" href="${escapeHtml(href)}"><div class="card-title">${escapeHtml(page.title)}</div>${desc}</a>`;
        })
        .join('\n');
      return `<h2>${escapeHtml(section.sectionTitle)}</h2>\n<div class="cards">\n${cards}\n</div>`;
    })
    .join('\n');
  const mainHtml = `<article>
<div class="hero">
<h1>${SITE_TITLE}</h1>
<p>BreadESP — ESP32 虚拟面包板仿真器的离线文档站：教程、指南与契约参考，全部从仓库 Markdown 源构建。</p>
</div>
${sections}
</article>`;
  return shell({
    title: 'Home',
    route: args.route,
    contentHtml: '',
    headings: [],
    nav: args.nav,
    pageCount: args.pageCount,
    mainHtml,
  });
}
