// PRD: §F-DOC-1/3/5 — docs:build / docs:check / docs:serve CLI entry (P5.4).
//
//   pnpm docs:build [--out <dir>]              build into docs/site (default)
//   pnpm docs:check                            validate sources + links, zero writes
//   pnpm docs:serve [--port <n>] [--out <dir>] rebuild and preview on 127.0.0.1
//
// Same shape as the scaffold CLI (dev-plan §4.7): argument parsing never throws
// (usage problems come back as coded [BB-240] strings), runDocsCli returns the
// exit code instead of calling process.exit, and IO is injected for tests.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSite, checkSite } from './build.js';
import { serveDocs } from './serve.js';
import { breadespSite, REPO_ROOT } from './site.js';
import type { RunningServer } from './types.js';

export const DOCS_USAGE = `Usage:
  pnpm docs:build [--out <dir>]      Build the offline docs site (default: docs/site)
  pnpm docs:check                    Validate sources and links without writing
  pnpm docs:serve [--port <n>] [--out <dir>]
                                     Rebuild, then preview at http://127.0.0.1:<port>
                                     (default port 4173; Ctrl+C to stop)
  -h, --help                         Show this help
`;

/** Output sink + repo root seam (tests inject captures and fixture roots). */
export interface DocsCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  repoRoot: string;
  /** Optional stop signal for the serve command (tests); CLI uses SIGINT/SIGTERM. */
  signal?: AbortSignal;
}

type DocsCommand = 'build' | 'check' | 'serve';

interface ParsedDocsArgs {
  command: DocsCommand | null;
  help: boolean;
  out?: string;
  port?: number;
  /** Coded usage error ([BB-240]); set iff the args are not actionable. */
  error?: string;
}

const COMMANDS: readonly string[] = ['build', 'check', 'serve'];

/**
 * Parse the CLI arguments. Never throws: usage problems come back as a coded
 * [BB-240] error string for the caller to print (exit code 2).
 */
export function parseDocsArgs(argv: string[]): ParsedDocsArgs {
  let command: DocsCommand | null = null;
  let out: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { command: null, help: true };
    if (arg === '--out' || arg === '--port') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { command: null, help: false, error: `[BB-240] option ${arg} needs a value` };
      }
      i++;
      if (arg === '--out') {
        out = value;
      } else {
        const parsedPort = Number(value);
        if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
          return { command: null, help: false, error: `[BB-240] --port expects an integer 0-65535, got '${value}'` };
        }
        port = parsedPort;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      return { command: null, help: false, error: `[BB-240] unknown option '${arg}'` };
    }
    if (!COMMANDS.includes(arg)) {
      return { command: null, help: false, error: `[BB-240] unknown command '${arg}' (expected build|check|serve)` };
    }
    if (command !== null) {
      return { command: null, help: false, error: `[BB-240] unexpected extra command '${arg}'` };
    }
    command = arg as DocsCommand;
  }
  if (command === null) {
    return { command: null, help: false, error: '[BB-240] missing command (expected build|check|serve)' };
  }
  if (command === 'check' && (out !== undefined || port !== undefined)) {
    return { command: null, help: false, error: '[BB-240] check takes no --out/--port (it never writes)' };
  }
  if (command === 'build' && port !== undefined) {
    return { command: null, help: false, error: '[BB-240] --port only applies to serve' };
  }
  return { command, help: false, ...(out !== undefined ? { out } : {}), ...(port !== undefined ? { port } : {}) };
}

function waitForStop(signal: AbortSignal | undefined, server: RunningServer): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    let settled = false;
    const stop = (): void => {
      if (settled) return;
      settled = true;
      void server.close().then(() => resolvePromise());
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener('abort', stop, { once: true });
      return;
    }
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * Run the docs CLI. Returns the process exit code (0 ok/help, 2 usage/content/
 * IO failure) instead of exiting, so tests can drive it.
 */
export async function runDocsCli(argv: string[], io: DocsCliIO): Promise<number> {
  const parsed = parseDocsArgs(argv);
  if (parsed.help) {
    io.out(DOCS_USAGE);
    return 0;
  }
  if (parsed.error !== undefined || parsed.command === null) {
    io.err(parsed.error ?? '[BB-240] missing command');
    io.err(DOCS_USAGE);
    return 2;
  }
  const site = breadespSite(io.repoRoot);
  const outDir = resolve(io.repoRoot, parsed.out ?? join('docs', 'site'));
  try {
    if (parsed.command === 'check') {
      const result = checkSite(site);
      io.out(`OK: ${result.pageCount} pages, ${result.linkCount} links checked.`);
      return 0;
    }
    const report = buildSite(site, outDir);
    io.out(`Built ${report.pageCount} pages + index (${report.files.length} files, ${report.linkCount} links checked) into ${outDir}`);
    if (parsed.command === 'build') return 0;
    const server = await serveDocs(outDir, { ...(parsed.port !== undefined ? { port: parsed.port } : {}) });
    io.out(`Serving BreadESP docs at ${server.url} (Ctrl+C to stop)`);
    await waitForStop(io.signal, server);
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

// Entry guard: run only when executed directly (tests import the functions
// above without side effects).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  void runDocsCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    repoRoot: REPO_ROOT,
  }).then((code) => {
    process.exitCode = code;
  });
}
