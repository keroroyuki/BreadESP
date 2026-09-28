// PRD: §F-DOC, dev-plan P5.4 — shared test helpers for @breadesp/docs-site.
import { renderInline } from '../src/markdown.js';

/** Render one inline fragment with a fresh parse state. */
export function inlineOf(text: string, resolveLink?: (target: string, line: number) => string): string {
  return renderInline(text, { headings: [], links: [], slugCounts: new Map(), resolveLink: resolveLink ?? ((t) => t) }, 1);
}

/** A small mixed-syntax document used by the renderer smoke test. */
export const md = `# 混合文档

一段话带 [站内链接](./other.md) 和 [外链](https://example.com)。

| a | b |
|---|---|
| 1 | 2 |

> 引用一行
`;
