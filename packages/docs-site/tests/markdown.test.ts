// PRD: §F-DOC-1, dev-plan P5.4 — restricted-Markdown renderer unit tests.
// The renderer is pure: every case is source-in, HTML/headings/links-out.
import { describe, expect, it } from 'vitest';
import { plainText, renderInline, renderMarkdown, slugifyHeading, splitTableRow } from '../src/markdown.js';
import { inlineOf, md } from './helpers.js';

describe('headings + GitHub-compatible slugs', () => {
  it('renders ATX levels 1-6 with slug ids', () => {
    const r = renderMarkdown('# H1\n### H3\n###### H6');
    expect(r.html).toContain('<h1 id="h1">H1</h1>');
    expect(r.html).toContain('<h3 id="h3">H3</h3>');
    expect(r.html).toContain('<h6 id="h6">H6</h6>');
    expect(r.headings.map((h) => h.level)).toEqual([1, 3, 6]);
  });

  it('strips optional closing hashes', () => {
    expect(renderMarkdown('## Title ##').html).toContain('<h2 id="title">Title</h2>');
  });

  it('slugifies CJK headings like GitHub (punctuation drops, spaces hyphenate)', () => {
    // The real anchors the docs already use (dev-plan TOC + PRD cross links).
    expect(slugifyHeading('1. 总体策略')).toBe('1-总体策略');
    expect(slugifyHeading('6. 核心接口契约（§6）')).toBe('6-核心接口契约6');
    expect(slugifyHeading('9. AI Agent 协作规范')).toBe('9-ai-agent-协作规范');
    expect(slugifyHeading('Phase 1 — MVP 核心（M1，对齐 PRD §8）')).toBe('phase-1--mvp-核心m1对齐-prd-8');
  });

  it('derives the slug from plain text (inline code/links/emphasis stripped)', () => {
    expect(plainText('清单格式（`breadesp-peripheral.json`，`manifestVersion: 1`）')).toBe(
      '清单格式（breadesp-peripheral.json，manifestVersion: 1）',
    );
    expect(slugifyHeading(plainText('**Bold** [link](x.md) `code`'))).toBe('bold-link-code');
  });

  it('deduplicates repeated headings with -1, -2 suffixes', () => {
    const r = renderMarkdown('## 清单\n## 清单\n## 清单');
    expect(r.headings.map((h) => h.slug)).toEqual(['清单', '清单-1', '清单-2']);
  });

  it('renders setext headings and registers their anchors', () => {
    const r = renderMarkdown('Title One\n===\nSub Two\n---');
    expect(r.html).toContain('<h1 id="title-one">Title One</h1>');
    expect(r.html).toContain('<h2 id="sub-two">Sub Two</h2>');
  });
});

describe('paragraphs, escaping, thematic breaks', () => {
  it('merges soft-wrapped lines into one paragraph', () => {
    expect(renderMarkdown('line one\nline two').html).toBe('<p>line one\nline two</p>');
  });

  it('always escapes raw HTML (no passthrough)', () => {
    expect(renderMarkdown('<script>alert(1)</script>').html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('renders --- as <hr> between blocks, *** and ___ too', () => {
    expect(renderMarkdown('a\n\n---\n\nb').html).toBe('<p>a</p>\n<hr>\n<p>b</p>');
    expect(renderMarkdown('***').html).toBe('<hr>');
    expect(renderMarkdown('___').html).toBe('<hr>');
  });
});

describe('inline markup', () => {
  it('renders code spans verbatim (HTML chars escaped)', () => {
    expect(inlineOf('use `<a href="x">` now')).toBe('use <code>&lt;a href=&quot;x&quot;&gt;</code> now');
  });

  it('supports multi-backtick spans and trims one boundary space', () => {
    expect(inlineOf('`` `x` ``')).toBe('<code>`x`</code>');
  });

  it('renders bold / italic / bold-italic; underscore stays literal', () => {
    expect(inlineOf('**b** *i* ***bi***')).toBe('<strong>b</strong> <em>i</em> <strong><em>bi</em></strong>');
    expect(inlineOf('breadesp_dbus and PERIPHERAL_SDK_VERSION')).toBe('breadesp_dbus and PERIPHERAL_SDK_VERSION');
  });

  it('renders links with titles and records them for the link checker', () => {
    const state = { headings: [], links: [], slugCounts: new Map<string, number>(), resolveLink: (t: string): string => `/r/${t}` };
    const html = renderInline('[`PRD.md`](../PRD.md "truth")', state, 7);
    expect(html).toBe('<a href="/r/../PRD.md" title="truth"><code>PRD.md</code></a>');
    expect(state.links).toEqual([{ target: '../PRD.md', line: 7, image: false }]);
  });

  it('renders images and records them with the image flag', () => {
    const r = renderMarkdown('![board](images/board.png)');
    expect(r.html).toContain('<img src="images/board.png" alt="board">');
    expect(r.links).toEqual([{ target: 'images/board.png', line: 1, image: true }]);
  });

  it('keeps emphasis working around stashed links', () => {
    expect(inlineOf('**see [x](a.md) now**')).toBe('<strong>see <a href="a.md">x</a> now</strong>');
  });
});

describe('fenced code blocks', () => {
  it('renders with language class and escapes content', () => {
    const r = renderMarkdown('```ts\nconst a = 1 < 2;\n```');
    expect(r.html).toBe('<pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre>');
  });

  it('runs an unclosed fence to EOF (CommonMark)', () => {
    const r = renderMarkdown('```\nopen\nstill open');
    expect(r.html).toBe('<pre><code>open\nstill open\n</code></pre>');
  });

  it('does not parse markup inside fences', () => {
    const r = renderMarkdown('```\n# not a heading\n| not | a table |\n```');
    expect(r.headings).toEqual([]);
    expect(r.html).toContain('# not a heading');
  });
});

describe('tables', () => {
  it('renders header + rows with inline markup in cells', () => {
    const r = renderMarkdown('| 命令 | 作用 |\n|---|---|\n| `pnpm test` | 全仓**测试** |');
    expect(r.html).toContain('<th>命令</th><th>作用</th>');
    expect(r.html).toContain('<td><code>pnpm test</code></td><td>全仓<strong>测试</strong></td>');
  });

  it('honors alignment colons', () => {
    const r = renderMarkdown('| l | c | r |\n|:---|:-:|---:|\n| a | b | c |');
    expect(r.html).toContain('<th style="text-align:left">l</th><th style="text-align:center">c</th><th style="text-align:right">r</th>');
  });

  it('splits escaped pipes literally, including inside code spans (GFM)', () => {
    expect(splitTableRow('| `a\\|b` | c |')).toEqual(['`a|b`', 'c']);
    const r = renderMarkdown('| flag |\n|---|\n| `--target linux-docker\\|windows-msys2` |');
    expect(r.html).toContain('<code>--target linux-docker|windows-msys2</code>');
  });

  it('pads missing cells and drops extra cells (ragged rows)', () => {
    const r = renderMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |');
    expect(r.html).toContain('<td>1</td><td></td>');
    expect(r.html).toContain('<td>1</td><td>2</td>');
    expect(r.html).not.toContain('<td>3</td>');
  });

  it('rejects a header/separator column mismatch as a table', () => {
    const r = renderMarkdown('| a | b |\n|---|\nparagraph text');
    expect(r.html).not.toContain('<table>');
    expect(r.html).toContain('<p>| a | b |\n|---|\nparagraph text</p>');
  });
});

describe('lists', () => {
  it('renders tight unordered lists without <p> wrappers', () => {
    const r = renderMarkdown('- one\n- two');
    expect(r.html).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
  });

  it('renders ordered lists', () => {
    expect(renderMarkdown('1. a\n2. b').html).toBe('<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
  });

  it('nests sub-lists by indentation', () => {
    const r = renderMarkdown('- outer\n  - inner\n- back');
    expect(r.html).toBe('<ul>\n<li>outer\n<ul>\n<li>inner</li>\n</ul></li>\n<li>back</li>\n</ul>');
  });

  it('keeps <p> wrappers in loose lists (blank line between items)', () => {
    const r = renderMarkdown('- one\n\n- two');
    expect(r.html).toBe('<ul>\n<li><p>one</p></li>\n<li><p>two</p></li>\n</ul>');
  });

  it('joins lazy continuation lines into the item paragraph', () => {
    const r = renderMarkdown('- first line\nsecond line\n- next');
    expect(r.html).toBe('<ul>\n<li>first line\nsecond line</li>\n<li>next</li>\n</ul>');
  });

  it('renders task items with disabled checkboxes', () => {
    const r = renderMarkdown('- [x] done\n- [ ] todo');
    expect(r.html).toContain('<li><input type="checkbox" disabled checked> done</li>');
    expect(r.html).toContain('<li><input type="checkbox" disabled> todo</li>');
  });

  it('switches list type when the marker kind changes', () => {
    const r = renderMarkdown('- a\n1. b');
    expect(r.html).toBe('<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>');
  });
});

describe('blockquotes', () => {
  it('renders quote blocks with inline markup', () => {
    expect(renderMarkdown('> 见 **PRD** 契约').html).toBe('<blockquote>\n<p>见 <strong>PRD</strong> 契约</p>\n</blockquote>');
  });

  it('merges consecutive quote lines and supports lazy continuation', () => {
    const r = renderMarkdown('> line one\n> line two\nlazy tail');
    expect(r.html).toContain('<p>line one\nline two\nlazy tail</p>');
  });

  it('parses nested blocks (lists) inside quotes', () => {
    const r = renderMarkdown('> intro\n>\n> - a\n> - b');
    expect(r.html).toContain('<ul>');
    expect(r.html).toContain('<li>a</li>');
  });

  it('keeps a table after a quote outside of it (no lazy table capture)', () => {
    const r = renderMarkdown('> quote\n\n| a |\n|---|\n| 1 |');
    expect(r.html).toContain('</blockquote>\n<table>');
  });
});

describe('integration smoke via md() helper', () => {
  it('renders a mixed document end to end', () => {
    const r = renderMarkdown(md);
    expect(r.headings.map((h) => h.slug)).toContain('混合文档');
    expect(r.links.map((l) => l.target)).toEqual(['./other.md', 'https://example.com']);
    expect(r.html).toContain('<table>');
    expect(r.html).toContain('<blockquote>');
  });
});
