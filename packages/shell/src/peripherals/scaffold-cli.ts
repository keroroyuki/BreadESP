// PRD: §F-EXT-4 — `pnpm create-peripheral` entry point (dev-plan P5.3).
//
//   pnpm create-peripheral <name> [--display-name <text>] [--description <text>] [--into <parentDir>]
//
// Generates a ready-to-publish peripheral package (PeripheralScaffold) and
// prints the next steps. The flag is `--into`, not `--dir`: pnpm swallows its
// own global `--dir` option before the script ever sees it.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listPeripherals, registerBuiltins } from '@breadesp/peripherals';
import {
  normalizeScaffoldRequest,
  writePeripheralPackage,
  type ScaffoldRequest,
} from './PeripheralScaffold.js';

export const SCAFFOLD_USAGE = `Usage: pnpm create-peripheral <name> [--display-name <text>] [--description <text>] [--into <parentDir>]

  <name>                 Package name: lowercase kebab-case, optionally @scoped
                         (e.g. acme-matrix, @acme/matrix-driver). The unscoped
                         part becomes the peripheral kind and directory name.
  --display-name <text>  Palette display name (default derived from the kind).
  --description <text>   One-line package description for the catalog panel.
  --into <parentDir>     Parent directory for the package (default: cwd).
                         Use the local peripherals root (~/.breadesp/peripherals)
                         to make the package discoverable immediately.
  -h, --help             Show this help.
`;

/** Output sink + working directory seam (tests inject captures). */
export interface ScaffoldCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
}

interface ParsedScaffoldArgs {
  help: boolean;
  request: ScaffoldRequest;
  /** Parent directory override (--into), as given on the command line. */
  into?: string;
  /** Coded usage error ([BB-230]); set iff the args are not actionable. */
  error?: string;
}

const VALUE_FLAGS = new Set(['--display-name', '--description', '--into']);

/**
 * Parse the CLI arguments. Never throws: usage problems come back as a coded
 * [BB-230] error string for the caller to print (exit code 2).
 */
export function parseScaffoldArgs(argv: string[]): ParsedScaffoldArgs {
  const request: ScaffoldRequest = { name: '' };
  let into: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true, request };
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { help: false, request, error: `[BB-230] option ${arg} needs a value` };
      }
      i++;
      if (arg === '--display-name') request.displayName = value;
      else if (arg === '--description') request.description = value;
      else into = value;
      continue;
    }
    if (arg.startsWith('-')) {
      return { help: false, request, error: `[BB-230] unknown option '${arg}'` };
    }
    if (name !== undefined) {
      return { help: false, request, error: `[BB-230] unexpected extra argument '${arg}' (exactly one package name)` };
    }
    name = arg;
  }
  if (name === undefined) {
    return { help: false, request, error: '[BB-230] missing package name' };
  }
  request.name = name;
  return { help: false, request, ...(into !== undefined ? { into } : {}) };
}

/**
 * Run the scaffold CLI. Returns the process exit code (0 created/help,
 * 2 usage or generation failure) instead of exiting, so tests can drive it.
 */
export async function runScaffoldCli(argv: string[], io: ScaffoldCliIO): Promise<number> {
  const parsed = parseScaffoldArgs(argv);
  if (parsed.help) {
    io.out(SCAFFOLD_USAGE);
    return 0;
  }
  if (parsed.error !== undefined) {
    io.err(parsed.error);
    io.err(SCAFFOLD_USAGE);
    return 2;
  }
  try {
    // The collision gate checks against the live kind set; the CLI runs in a
    // fresh process, so ensure the built-ins are registered first.
    registerBuiltins();
    const request = normalizeScaffoldRequest(parsed.request, listPeripherals().map((f) => f.kind));
    const parentDir = resolve(io.cwd, parsed.into ?? '.');
    const result = await writePeripheralPackage(parentDir, request);
    io.out(`Created peripheral package '${request.name}' (kind '${request.kind}'):`);
    for (const file of result.files) io.out(`  ${join(result.dir, file)}`);
    io.out('');
    io.out('Next steps:');
    io.out(`  1. node ${join(result.dir, 'self-check.mjs')}   # smoke-check the package`);
    io.out('  2. Copy the directory into your peripherals root (~/.breadesp/peripherals/,');
    io.out('     or BREADESP_PERIPHERALS_DIR) — or regenerate with --into pointing there.');
    io.out('  3. Open BreadESP -> Peripheral catalog -> Load; the peripheral appears');
    io.out('     in the palette immediately.');
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
  void runScaffoldCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    cwd: process.cwd(),
  }).then((code) => {
    process.exitCode = code;
  });
}
