// PRD: §5, §10.6 — Installer packaging (P6.1): Windows NSIS + Linux AppImage/deb.
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
// (Windows) or `--target linux-docker` (Linux) and is verified before packing;
// no binary is ever committed (PRD §10.6).
//
// Usage: node scripts/build-installer.mjs [--target windows|linux] [--skip-build] [--dir]
//   --target defaults to the host platform; --dir = unpacked only.
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

const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes('--skip-build');
const DIR_ONLY = argv.includes('--dir');
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const log = (msg) => console.log(`[build-installer] ${msg}`);
const fail = (msg) => { throw new Error(msg); };

// Packaging target: NSIS installer on Windows, AppImage + deb on Linux. QEMU
// exe name and the device-build target id follow the target, not the host.
const TARGET = arg('target') ?? (process.platform === 'win32' ? 'windows' : 'linux');
if (!['windows', 'linux'].includes(TARGET)) fail(`unknown --target "${TARGET}" (windows|linux)`);
const QEMU_EXE = TARGET === 'windows' ? 'qemu-system-xtensa.exe' : 'qemu-system-xtensa';
const QEMU_TARGET = TARGET === 'windows' ? 'windows-msys2' : 'linux-docker';

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
  const qemuBin = join(QEMU_SRC, 'bin', QEMU_EXE);
  if (!existsSync(qemuBin)) {
    fail(
      `${QEMU_TARGET} breadesp-dbus QEMU missing: ${qemuBin}\n` +
      `Build it first: node scripts/build-qemu-device.mjs --target ${QEMU_TARGET}`,
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
    homepage: 'https://github.com/keroroyuki/BreadESP',
    main: 'packages/shell/dist/main.js',
    devDependencies: { electron: electronPkg.version },
  };
  writeFileSync(join(APP_DIR, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n', 'utf8');

  // 4. Marker for the packaged QEMU resolution (shell resolveQemu): the bundle
  //    carries the breadesp-dbus device build.
  writeFileSync(
    join(QEMU_SRC, 'qemu-breadesp.json'),
    JSON.stringify({ release: 'esp-develop-9.2.2-20260417', device: 'breadesp-dbus', dbusProtocol: 1, target: QEMU_TARGET }, null, 2) + '\n',
    'utf8',
  );

  // 5. electron-builder -> NSIS installer (windows) / AppImage + deb (linux).
  log(`packing with electron-builder (target=${TARGET}; downloads electron dist + tools on first run)...`);
  const { build, Platform } = await import('electron-builder');
  const platform = TARGET === 'windows' ? Platform.WINDOWS : Platform.LINUX;
  const formats = TARGET === 'windows' ? ['nsis'] : ['AppImage', 'deb'];
  await build({
    targets: platform.createTarget(DIR_ONLY ? ['dir'] : formats),
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
      linux: {
        category: 'Development',
        artifactName: `BreadESP-\${version}.\${ext}`,
        description: 'ESP32 virtual breadboard simulator',
        // deb's control file requires a Maintainer; the bare author name carries
        // no email, so point the field at the project instead of inventing one.
        maintainer: 'BreadESP contributors <https://github.com/keroroyuki/BreadESP>',
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
