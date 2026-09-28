// PRD: §F-DOC — shared types for the offline docs-site builder (P5.4).
//
// All publicly reusable types of @breadesp/docs-site live here (dev-plan §4.1).

/** One Markdown source page mapped into the site (site.ts). */
export interface PageSource {
  /** Repo-relative POSIX path of the Markdown source, e.g. 'docs/tutorials/01-getting-started.md'. */
  sourcePath: string;
  /** Site-relative output route, e.g. 'tutorials/01-getting-started.html'. */
  route: string;
  /** Navigation section id. */
  section: SiteSectionId;
  /** Manifest-level nav title override (front matter wins over this). */
  navTitle?: string;
  /** Manifest-level description for the index cards (front matter wins). */
  description?: string;
}

export type SiteSectionId = 'tutorials' | 'guides' | 'reference';

/** The whole site: a repo root plus the ordered page manifest. */
export interface DocsSite {
  /** Absolute repo root that sourcePath values resolve against. */
  rootDir: string;
  pages: PageSource[];
}

/** Parsed YAML-subset front matter (only these keys are recognized). */
export interface FrontMatter {
  title?: string;
  description?: string;
}

/** A heading collected during rendering (anchor + TOC source). */
export interface HeadingInfo {
  level: number;
  /** Plain-text heading content (inline markup stripped). */
  text: string;
  /** GitHub-compatible unique slug used as the fragment id. */
  slug: string;
}

/** A link/image target found in a page (link-check input, links.ts). */
export interface MarkdownLinkRef {
  /** Raw target exactly as written in the source. */
  target: string;
  /** 1-based source line of the link. */
  line: number;
  image: boolean;
}

/** Result of rendering one Markdown document (markdown.ts). */
export interface RenderedMarkdown {
  html: string;
  headings: HeadingInfo[];
  links: MarkdownLinkRef[];
}

/** One link-integrity violation, listed by the [BB-241] gate. */
export interface LinkIssue {
  /** Route of the page containing the offending link. */
  page: string;
  /** Raw target as written. */
  target: string;
  /** 1-based source line. */
  line: number;
  reason: string;
}

/** A page after loading: source + front matter + first render pass. */
export interface LoadedPage {
  source: PageSource;
  meta: FrontMatter;
  /** Markdown body with front matter stripped. */
  body: string;
  rendered: RenderedMarkdown;
}

/** Build summary returned by buildSite and printed by the CLI. */
export interface BuildReport {
  outDir: string;
  /** Pages rendered (excluding the generated index). */
  pageCount: number;
  /** Repo-relative... site-relative POSIX paths of every file written, sorted. */
  files: string[];
  /** Site links rewritten + checked. */
  linkCount: number;
}

/** Options for the preview server (serve.ts). */
export interface ServeOptions {
  /** Loopback port; 0 picks an ephemeral port (tests). Default 4173. */
  port?: number;
  /** Bind host; default 127.0.0.1 (loopback only). */
  host?: string;
}

export interface RunningServer {
  /** Bound URL, e.g. 'http://127.0.0.1:4173/'. */
  url: string;
  port: number;
  close(): Promise<void>;
}
