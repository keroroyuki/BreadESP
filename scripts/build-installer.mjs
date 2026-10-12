// PRD: §5, §10.6 — Windows installer packaging (P6.1).
//
// Assembles a self-contained Electron app dir and hands it to electron-builder:
//
//   build/installer/app/
//     package.json                        (minimal app manifest)
//     packages/shell/dist/{main,preload}.js   (esbuild-bundled, electron external)
//     packages/ui/dist/**                 (renderer, vite build output)
//   extraResources: packages/sim-core/bin/qemu-breadesp/qemu -> resources/qemu
//     (the breadesp-dbus device build, so peripherals work out of the box)
//
// Bundling sidesteps pnpm's symlinked node_modules (electron-builder cannot
// follow them) — the app dir ships zero runtime node_modules. The QEMU device
// build is produced by `node scripts/build-qemu-device.mjs --target windows-msys2`
// and is verified before packing; no binary is ever committed (PRD §10.6).
//
// Usage: node scripts/build-installer.mjs [--skip-build] [--dir]   (--dir = unpacked only)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const STAGE = join(REPO_ROOT, 'build', 'installer');
const APP_DIR = join(STAGE, 'app');
const OUT_DIR = join(STAGE, 'dist');
const QEMU_SRC = join(REPO_ROOT, 'packages', 'sim-core', 'bin', 'qemu-breadesp', 'qemu');

const SKIP_BUILD = process.argv.includes('--skip-build');
const DIR_ONLY = process.argv.includes('--dir');

const log = (msg) => console.log(`[build-installer] ${msg}`);
const fail = (msg) => { throw new Error(msg); };

function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (res.error) fail(`failed to launch ${bin}: ${res.error.message}`);
  if (res.status !== 0) fail(`${bin} ${args.join(' ')} exited with code ${res.status}`);
}

/** Bundle one shell entry point (main/preload) with esbuild; electron stays external. */
async function bundle(entry, outfile) {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    // PluginCatalog loads user packages via a runtime-computed file URL with a
    // cache-busting query (P5.2) — keep native dynamic import() intact.
    supported: { 'dynamic-import': true },
    logLevel: 'warning',
  });
}

async function main() {
  // 0. Preconditions.
  const qemuBin = join(QEMU_SRC, 'bin', 'qemu-system-xtensa.exe');
  if (!existsSync(qemuBin)) {
    fail(
      `Windows breadesp-dbus QEMU missing: ${qemuBin}\n` +
      'Build it first: node scripts/build-qemu-device.mjs --target windows-msys2',
    );
  }

  // 1. Fresh dists (libs CJS dist, ui vite build, shell tsc — the bundle reads src,
  //    but @breadesp/* package mains resolve to dist/, so they must be current).
  if (!SKIP_BUILD) {
    log('building workspace packages (pnpm -r build)...');
    run('pnpm', ['-r', 'build'], { cwd: REPO_ROOT });
  }

  // 2. Stage the app dir.
  rmSync(APP_DIR, { recursive: true, force: true });
  mkdirSync(join(APP_DIR, 'packages', 'shell', 'dist'), { recursive: true });
  log('bundling shell main + preload (esbuild)...');
  await bundle(join(REPO_ROOT, 'packages', 'shell', 'src', 'main.ts'), join(APP_DIR, 'packages', 'shell', 'dist', 'main.js'));
  await bundle(join(REPO_ROOT, 'packages', 'shell', 'src', 'preload.ts'), join(APP_DIR, 'packages', 'shell', 'dist', 'preload.js'));

  log('copying renderer dist...');
  cpSync(join(REPO_ROOT, 'packages', 'ui', 'dist'), join(APP_DIR, 'packages', 'ui', 'dist'), { recursive: true });

  // 3. App manifest: electron-builder reads name/version/main/electron from here.
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const electronPkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', 'shell', 'node_modules', 'electron', 'package.json'), 'utf8'),
  );
  const appPkg = {
    name: 'breadesp',
    productName: 'BreadESP',
    version: rootPkg.version,
    private: true,
    description: rootPkg.description,
    author: 'BreadESP contributors',
    license: rootPkg.license,
    main: 'packages/shell/dist/main.js',
    devDependencies: { electron: electronPkg.version },
  };
  writeFileSync(join(APP_DIR, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n', 'utf8');

  // 4. Marker for the packaged QEMU resolution (shell resolveQemu): the bundle
  //    carries the breadesp-dbus device build.
  writeFileSync(
    join(QEMU_SRC, 'qemu-breadesp.json'),
    JSON.stringify({ release: 'esp-develop-9.2.2-20260417', device: 'breadesp-dbus', dbusProtocol: 1, target: 'windows-msys2' }, null, 2) + '\n',
    'utf8',
  );

  // 5. electron-builder -> NSIS installer.
  log('packing with electron-builder (downloads electron dist + nsis on first run)...');
  const { build, Platform } = await import('electron-builder');
  await build({
    targets: Platform.WINDOWS.createTarget(DIR_ONLY ? ['dir'] : ['nsis']),
    projectDir: APP_DIR,
    config: {
      appId: 'com.breadesp.app',
      productName: 'BreadESP',
      directories: { output: OUT_DIR },
      asar: true,
      files: ['package.json', 'packages/**'],
      extraResources: [
        { from: QEMU_SRC, to: 'qemu' },
        // Bundled example firmware (golden fixtures + examples.json manifest),
        // discovered at runtime by shell's listExampleFirmware (P6.1).
        { from: join(REPO_ROOT, 'packages', 'sim-core', 'fixtures'), to: 'examples' },
      ],
      win: { artifactName: `BreadESP-Setup-\${version}.\${ext}` },
      nsis: {
        oneClick: true,
        perMachine: false,
        shortcutName: 'BreadESP',
        deleteAppDataOnUninstall: false,
      },
      publish: null,
    },
  });
  log(`done. Artifacts under ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(`[build-installer] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
