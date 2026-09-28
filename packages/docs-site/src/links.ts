// PRD: §F-DOC-3 — site link integrity checking + route rewriting (P5.4).
//
// Every relative Markdown link is resolved against the source file's location
// in the repo, mapped to the target page's site route, and rewritten to a
// relative href between output pages; `#anchors` must hit a heading slug of
// the target page (GitHub-compatible, see markdown.slugifyHeading). External
// (scheme/protocol-relative) links pass through unchecked and are never
// fetched — the build is offline (PRD §F-DOC-4).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DocsSite, LinkIssue, PageSource } from './types.js';

/** Relative href between two site routes ('a/b.html' → 'c/d.html' = '../c/d.html'). */
export function relativeRoute(fromRoute: string, toRoute: string): string {
  const fromDir = fromRoute.split('/').slice(0, -1);
  const toParts = toRoute.split('/');
  let common = 0;
  while (common < fromDir.length && common < toParts.length - 1 && fromDir[common] === toParts[common]) common++;
  const ups = fromDir.length - common;
  const rest = toParts.slice(common);
  return [...new Array<string>(ups).fill('..'), ...rest].join('/');
}

function joinPosix(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}

/** POSIX segment normalization ('.' dropped, '..' resolved against the stack). */
export function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function dirnamePosix(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export interface LinkResolverArgs {
  site: DocsSite;
  /** Page containing the links being resolved. */
  current: PageSource;
  /** route → heading slugs of that page. */
  anchorsByRoute: Map<string, Set<string>>;
  /** repo-relative source path → route. */
  routeBySource: Map<string, string>;
  /** Collected [BB-241] violations (mutated). */
  issues: LinkIssue[];
  /** Repo-relative asset source → site asset route, filled as links resolve. */
  assets: Map<string, string>;
}

/**
 * Build the resolveLink callback for one page. Unknown/broken targets are
 * recorded as issues (never thrown) so one build lists every violation; the
 * raw target is returned as a harmless fallback href in that case.
 */
export function makeLinkResolver(args: LinkResolverArgs): (target: string, line: number) => string {
  const { site, current, anchorsByRoute, routeBySource, issues, assets } = args;
  const ownAnchors = anchorsByRoute.get(current.route) ?? new Set<string>();
  const fail = (target: string, line: number, reason: string): string => {
    issues.push({ page: current.route, target, line, reason });
    return target;
  };
  return (target: string, line: number): string => {
    const t = target.trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) || t.startsWith('//')) return t; // external: kept, never fetched
    if (t.startsWith('#')) {
      const anchor = t.slice(1);
      if (!ownAnchors.has(anchor)) return fail(target, line, `anchor '#${anchor}' not found on this page`);
      return t;
    }
    if (t.startsWith('/')) return fail(target, line, 'site-absolute links are unsupported; use a repo-relative link');
    const hashIdx = t.indexOf('#');
    const pathPart = hashIdx === -1 ? t : t.slice(0, hashIdx);
    const anchor = hashIdx === -1 ? '' : t.slice(hashIdx + 1);
    if (pathPart === '') return fail(target, line, 'empty link target');
    const resolved = normalizePosix(joinPosix(dirnamePosix(current.sourcePath), pathPart));
    if (resolved === '..' || resolved.startsWith('../')) {
      return fail(target, line, `link escapes the repository root ('${resolved}')`);
    }
    const targetRoute = routeBySource.get(resolved);
    if (targetRoute !== undefined) {
      if (anchor !== '' && !(anchorsByRoute.get(targetRoute) ?? new Set()).has(anchor)) {
        return fail(target, line, `anchor '#${anchor}' not found in ${resolved}`);
      }
      return relativeRoute(current.route, targetRoute) + (anchor === '' ? '' : `#${anchor}`);
    }
    if (!existsSync(join(site.rootDir, resolved))) {
      return fail(target, line, `broken link: '${resolved}' does not exist`);
    }
    if (/\.md$/i.test(resolved)) {
      return fail(target, line, `'${resolved}' is not part of the docs site page set`);
    }
    // Non-Markdown asset (image etc.): copied to assets/<repo path> at build.
    const assetRoute = `assets/${resolved}`;
    assets.set(resolved, assetRoute);
    return relativeRoute(current.route, assetRoute) + (anchor === '' ? '' : `#${anchor}`);
  };
}
