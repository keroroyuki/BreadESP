// PRD: §F-DOC-1 — restricted Markdown dialect → HTML renderer (P5.4).
//
// Supported block syntax: ATX headings (`#`..`######`, optional closing hashes),
// setext headings (`===`/`---` underlines), fenced code blocks (``` with optional
// language), GFM pipe tables (leading pipe required; `\|` escapes and alignment
// colons supported), ordered and unordered lists (nesting by indentation,
// `- [ ]` task items, tight/loose detection), blockquotes (recursive), thematic
// breaks, paragraphs. Supported inline syntax: code spans (single or multi
// backtick), **bold** / ***bold-italic*** / *italic*, [links](target "title"),
// ![images](target "title"). Raw HTML is ALWAYS escaped — the site ships zero
// scripts, so passthrough is never needed. Underscore emphasis is intentionally
// NOT supported: identifiers like breadesp_dbus or PERIPHERAL_SDK_VERSION must
// survive prose untouched. Indented (4-space) code blocks and ~~~ fences are
// out of the dialect on purpose.
//
// The renderer is pure and deterministic: no IO, no clock, no randomness.
import type { HeadingInfo, MarkdownLinkRef, RenderedMarkdown } from './types.js';

/** Optional href rewriter: build.ts injects the site link resolver (pass 2). */
export interface RenderOptions {
  resolveLink?: (target: string, line: number) => string;
}

interface ParseState {
  headings: HeadingInfo[];
  links: MarkdownLinkRef[];
  slugCounts: Map<string, number>;
  resolveLink: (target: string, line: number) => string;
}

/** A source line paired with its 1-based line number (link diagnostics). */
interface SrcLine {
  text: string;
  n: number;
}

/**
 * Stash sentinel for inline fragments (code spans, links) while the surrounding
 * text is HTML-escaped. SOH (\x01) cannot appear in real Markdown sources, so
 * the placeholder can never collide with content (unlike a printable sentinel).
 */
const STASH_RE = /\x01(\d+)\x01/g;

/** Render one Markdown document to HTML plus headings/links metadata. */
export function renderMarkdown(source: string, options: RenderOptions = {}): RenderedMarkdown {
  const state: ParseState = {
    headings: [],
    links: [],
    slugCounts: new Map(),
    resolveLink: options.resolveLink ?? ((target) => target),
  };
  const lines = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((text, idx): SrcLine => ({ text, n: idx + 1 }));
  return { html: renderBlocks(lines, state), headings: state.headings, links: state.links };
}

/**
 * GitHub-compatible heading slug (html-pipeline TableOfContentsFilter):
 * lowercase, drop everything that is not a unicode word char / hyphen / space,
 * then turn spaces into hyphens. CJK ideographs are word chars and survive;
 * `§`, `.`, fullwidth parens/commas are punctuation and drop.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Strip inline markup to the plain text a heading anchor is derived from. */
export function plainText(text: string): string {
  return text
    .replace(/(`+)([\s\S]+?)\1/g, '$2')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Block-level parsing
// ---------------------------------------------------------------------------

function renderBlocks(lines: SrcLine[], state: ParseState): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line.text)) {
      i++;
      continue;
    }

    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line.text);
    if (fence) {
      const buf: string[] = [];
      i++;
      // CommonMark: an unclosed fence runs to the end of the document.
      while (i < lines.length && !/^```\s*$/.test(lines[i].text)) {
        buf.push(lines[i].text);
        i++;
      }
      i++; // consume the closing fence (or EOF)
      const lang = fence[1];
      out.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${escapeHtml(buf.join('\n'))}\n</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line.text);
    if (heading) {
      out.push(renderHeading(heading[1].length, (heading[2] ?? '').replace(/[ \t]+#+$/, ''), line.n, state));
      i++;
      continue;
    }

    if (
      /^ {0,3}(-[ \t]*){3,}$/.test(line.text) ||
      /^ {0,3}(\*[ \t]*){3,}$/.test(line.text) ||
      /^ {0,3}(_[ \t]*){3,}$/.test(line.text)
    ) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      i = renderTable(lines, i, state, out);
      continue;
    }

    if (/^>[ \t]?/.test(line.text)) {
      const qlines: SrcLine[] = [];
      while (i < lines.length && (/^>[ \t]?/.test(lines[i].text) || isLazyQuoteContinuation(lines[i]))) {
        qlines.push({ text: lines[i].text.replace(/^>[ \t]?/, ''), n: lines[i].n });
        i++;
      }
      out.push(`<blockquote>\n${renderBlocks(qlines, state)}\n</blockquote>`);
      continue;
    }

    if (isListItem(line.text)) {
      i = renderList(lines, i, state, out);
      continue;
    }

    // Paragraph (a trailing ===/--- underline turns it into a setext heading).
    const buf: SrcLine[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i].text) && !isBlockStart(lines, i)) {
      // A setext underline terminates the paragraph instead of joining it.
      if (buf.length > 0 && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i].text)) break;
      buf.push(lines[i]);
      i++;
    }
    const setext = i < lines.length ? /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[i].text) : null;
    if (setext && buf.length > 0) {
      out.push(renderHeading(setext[1].startsWith('=') ? 1 : 2, buf.map((l) => l.text).join(' '), buf[0].n, state));
      i++; // consume the underline
      continue;
    }
    out.push(`<p>${renderInline(buf.map((l) => l.text).join('\n'), state, buf[0].n)}</p>`);
  }
  return out.join('\n');
}

function renderHeading(level: number, rawText: string, line: number, state: ParseState): string {
  const text = plainText(rawText);
  const base = slugifyHeading(text);
  const seen = state.slugCounts.get(base);
  state.slugCounts.set(base, (seen ?? -1) + 1);
  const slug = seen === undefined ? base : `${base}-${seen + 1}`;
  state.headings.push({ level, text, slug });
  return `<h${level} id="${escapeHtml(slug)}">${renderInline(rawText, state, line)}</h${level}>`;
}

/** A line that opens a new block (paragraph/list lazy-interrupt test). */
function isBlockStart(lines: SrcLine[], i: number): boolean {
  const text = lines[i].text;
  return (
    /^```/.test(text) ||
    /^#{1,6}[ \t]/.test(text) ||
    /^ {0,3}(-[ \t]*){3,}$/.test(text) ||
    /^ {0,3}(\*[ \t]*){3,}$/.test(text) ||
    /^ {0,3}(_[ \t]*){3,}$/.test(text) ||
    /^>[ \t]?/.test(text) ||
    isListItem(text) ||
    isTableStart(lines, i)
  );
}

/**
 * Lazy blockquote continuation: a non-blank line that opens no new block.
 * Table-ish lines (`| ...`) are excluded — GFM laziness applies to paragraph
 * text, so a table following a quote stays outside the quote.
 */
function isLazyQuoteContinuation(line: SrcLine): boolean {
  const text = line.text;
  if (/^\s*$/.test(text)) return false;
  return !(
    /^```/.test(text) ||
    /^#{1,6}[ \t]/.test(text) ||
    /^ {0,3}(-[ \t]*){3,}$/.test(text) ||
    /^\s*\|/.test(text) ||
    isListItem(text)
  );
}

// ---------------------------------------------------------------------------
// Tables (GFM pipe tables, leading pipe required)
// ---------------------------------------------------------------------------

function isTableRow(text: string): boolean {
  return /^\s*\|/.test(text) && (text.match(/\|/g)?.length ?? 0) >= 2;
}

function isSeparatorRow(text: string): boolean {
  if (!/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(text)) return false;
  const cells = splitTableRow(text);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function isTableStart(lines: SrcLine[], i: number): boolean {
  if (i + 1 >= lines.length) return false;
  if (!isTableRow(lines[i].text) || !isSeparatorRow(lines[i + 1].text)) return false;
  // GFM: header and separator must agree on the column count.
  return splitTableRow(lines[i].text).length === splitTableRow(lines[i + 1].text).length;
}

/**
 * Split a pipe row into cells. Every unescaped `|` separates — including inside
 * code spans (GFM table rule); `\|` collapses to a literal `|` before inline
 * parsing, so escaped pipes inside code spans render as a bare `|`.
 */
export function splitTableRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(lines: SrcLine[], start: number, state: ParseState, out: string[]): number {
  const headerCells = splitTableRow(lines[start].text);
  const aligns = splitTableRow(lines[start + 1].text).map((cell) =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '',
  );
  const rows: { cells: string[]; n: number }[] = [];
  let i = start + 2;
  while (i < lines.length && !/^\s*$/.test(lines[i].text) && isTableRow(lines[i].text)) {
    rows.push({ cells: splitTableRow(lines[i].text), n: lines[i].n });
    i++;
  }
  const alignAttr = (col: number): string => (aligns[col] === '' ? '' : ` style="text-align:${aligns[col]}"`);
  const head = headerCells
    .map((cell, col) => `<th${alignAttr(col)}>${renderInline(cell, state, lines[start].n)}</th>`)
    .join('');
  const body = rows
    .map((row) => {
      // Ragged rows: extra cells drop, missing cells render empty (GFM).
      const cells = Array.from({ length: headerCells.length }, (_, col) => row.cells[col] ?? '');
      return `<tr>${cells.map((cell, col) => `<td${alignAttr(col)}>${renderInline(cell, state, row.n)}</td>`).join('')}</tr>`;
    })
    .join('\n');
  out.push(`<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`);
  return i;
}

// ---------------------------------------------------------------------------
// Lists (ul/ol, indentation nesting, task items, tight vs loose)
// ---------------------------------------------------------------------------

const LIST_ITEM_RE = /^(\s*)([-+*]|\d{1,9}[.)])([ \t]+)(\S.*)$/;

function isListItem(text: string): boolean {
  return LIST_ITEM_RE.test(text);
}

function renderList(lines: SrcLine[], start: number, state: ParseState, out: string[]): number {
  const opener = LIST_ITEM_RE.exec(lines[start].text);
  if (!opener) throw new Error(`internal: renderList called on a non-item line ${lines[start].n}`);
  const baseIndent = opener[1].length;
  const ordered = /\d/.test(opener[2]);
  const items: { contentIndent: number; lines: SrcLine[] }[] = [];
  let loose = false;
  let pendingBlank = false;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line.text)) {
      pendingBlank = true;
      i++;
      continue;
    }
    const m = LIST_ITEM_RE.exec(line.text);
    if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
      if (pendingBlank && items.length > 0) loose = true; // blank line between items
      items.push({ contentIndent: m[1].length + m[2].length + m[3].length, lines: [{ text: m[4], n: line.n }] });
      pendingBlank = false;
      i++;
      continue;
    }
    if (items.length > 0) {
      const indent = /^(\s*)/.exec(line.text)![1].length;
      const current = items[items.length - 1];
      if (indent > baseIndent) {
        // Indented continuation (wrapped text, nested list): re-indent relative
        // to the item's content column; the recursion parses nested blocks.
        if (pendingBlank) loose = true; // blank line inside the item
        current.lines.push({ text: line.text.slice(Math.min(indent, current.contentIndent)), n: line.n });
        pendingBlank = false;
        i++;
        continue;
      }
      if (!isBlockStart(lines, i)) {
        // Lazy continuation of the item's paragraph (GFM list laziness).
        current.lines.push({ text: line.text.trim(), n: line.n });
        pendingBlank = false;
        i++;
        continue;
      }
    }
    break;
  }

  const tag = ordered ? 'ol' : 'ul';
  const rendered = items.map((item) => {
    // Task items: lift the marker off the first line before block rendering.
    const task = /^\[( |x|X)\][ \t]+/.exec(item.lines[0]?.text ?? '');
    if (task) item.lines[0] = { text: item.lines[0].text.slice(task[0].length), n: item.lines[0].n };
    let inner = renderBlocks(item.lines, state);
    if (!loose && inner.startsWith('<p>')) {
      // Tight list: unwrap a sole leading paragraph (whole content, or content
      // followed by a nested list).
      const close = inner.indexOf('</p>');
      const rest = close === -1 ? '' : inner.slice(close + 4);
      if (close !== -1 && (rest === '' || /^\n?<[uo]l>$/.test(rest) || /^\n?<[uo]l>\n/.test(rest))) {
        inner = inner.slice(3, close) + rest; // rest already carries the joining newline
      }
    }
    if (task) {
      const checkbox = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}>`;
      inner = inner.startsWith('<p>') ? `<p>${checkbox} ${inner.slice(3)}` : `${checkbox} ${inner}`;
    }
    return `<li>${inner}</li>`;
  });
  out.push(`<${tag}>\n${rendered.join('\n')}\n</${tag}>`);
  return i;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

/**
 * Render inline markup. Extraction order matters: code spans are stashed first
 * (their content is verbatim), then links/images (targets are recorded and
 * rewritten through the injected resolver), the remainder is HTML-escaped,
 * emphasis applies on the escaped text, and stashed fragments restore last so
 * nested constructs (a code span inside a link label) resolve correctly.
 */
export function renderInline(text: string, state: ParseState, line: number): string {
  const stash: string[] = [];
  const push = (html: string): string => {
    stash.push(html);
    return `\x01${stash.length - 1}\x01`;
  };

  let s = text.replace(/(`+)([\s\S]+?)\1/g, (_m, _ticks: string, content: string) => {
    let c = content.replace(/\n/g, ' ');
    if (c.length >= 2 && c.startsWith(' ') && c.endsWith(' ') && c.trim() !== '') c = c.slice(1, -1);
    return push(`<code>${escapeHtml(c)}</code>`);
  });

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+"([^"]*)")?\)/g, (_m, alt: string, url: string, title: string | undefined) => {
    state.links.push({ target: url, line, image: true });
    const href = state.resolveLink(url, line);
    const titleAttr = title === undefined ? '' : ` title="${escapeHtml(title)}"`;
    return push(`<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"${titleAttr}>`);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:[ \t]+"([^"]*)")?\)/g, (_m, label: string, url: string, title: string | undefined) => {
    state.links.push({ target: url, line, image: false });
    const href = state.resolveLink(url, line);
    const titleAttr = title === undefined ? '' : ` title="${escapeHtml(title)}"`;
    return push(`<a href="${escapeHtml(href)}"${titleAttr}>${label}</a>`);
  });

  s = escapeHtml(s);
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Restore stashed fragments; nested stash references resolve in passes.
  let prev: string;
  do {
    prev = s;
    s = s.replace(STASH_RE, (_m, idx: string) => stash[Number(idx)]);
  } while (s !== prev);
  return s;
}
