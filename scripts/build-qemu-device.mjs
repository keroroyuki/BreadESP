// PRD: §4.2, §5, §10.6 — Build the BreadESP QEMU fork (dev-plan task P1.2).
// Clones espressif/qemu at the tag pinned by scripts/fetch-qemu.mjs, installs the
// breadesp-dbus forward device (packages/sim-core/device/breadesp_dbus.c) as a
// stock-tree addition (one .c file + meson registration, no source patches), then
// builds qemu-system-xtensa and stages it into packages/sim-core/bin/qemu-breadesp/.
//
// Targets:
//   linux-docker    build inside the ubuntu:22.04 image mirroring the espressif CI
//                   (configure-native.sh, minus SDL); requires a
//                   running Docker engine.
//   windows-msys2   native MSYS2/MINGW64 static build mirroring the espressif CI
//                   (configure-win.sh); requires MSYS2 with the MINGW64 toolchain
//                   (BREADESP_MSYS2_DIR, default C:\msys64).
//
// Usage: node scripts/build-qemu-device.mjs [--target <target>] [--force]
//          [--src <qemu-source-dir>] [--msys2 <msys2-root>]
// The source tree and all build outputs stay under gitignored paths; no binary
// is ever committed (PRD §10.6).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEVICE_SRC = join(REPO_ROOT, 'packages', 'sim-core', 'device', 'breadesp_dbus.c');
const BUILD_DIR = join(REPO_ROOT, 'packages', 'sim-core', 'build');
const OUT_DIR = join(REPO_ROOT, 'packages', 'sim-core', 'bin', 'qemu-breadesp');
const OUT_META = join(REPO_ROOT, 'packages', 'sim-core', 'bin', 'qemu-breadesp.json');

const log = (msg) => console.log(`[build-qemu-device] ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};

// The tag MUST stay identical to the fetch-qemu.mjs pin so the patched build and
// the stock download are the same QEMU baseline. Read it from there to enforce it.
function pinnedTag() {
  const fetchScript = readFileSync(join(REPO_ROOT, 'scripts', 'fetch-qemu.mjs'), 'utf8');
  const m = fetchScript.match(/const RELEASE_TAG = '([^']+)'/);
  if (!m) fail('cannot read RELEASE_TAG from scripts/fetch-qemu.mjs');
  return m[1];
}

const TAG = pinnedTag();
const REPO_URL = 'https://github.com/espressif/qemu.git';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (name) => argv.includes(`--${name}`);
const FORCE = hasFlag('force');
const TARGET = arg('target') ?? (process.platform === 'win32' ? 'windows-msys2' : 'linux-docker');
const MSYS2_DIR = arg('msys2') ?? process.env.BREADESP_MSYS2_DIR ?? 'C:\\msys64';
const SRC_DIR = resolve(arg('src') ?? join(BUILD_DIR, 'qemu-src'));

if (!['linux-docker', 'windows-msys2'].includes(TARGET)) {
  fail(`Unknown target "${TARGET}" (expected linux-docker or windows-msys2)`);
}
if (!existsSync(DEVICE_SRC)) fail(`device source missing: ${DEVICE_SRC}`);

/** Run a command, inheriting stdio; abort with a readable error on failure. */
function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, { stdio: 'inherit', ...opts });
  if (res.error) fail(`failed to launch ${bin}: ${res.error.message}`);
  if (res.status !== 0) fail(`${bin} ${args.join(' ')} exited with code ${res.status}`);
  return res;
}

/** git with captured stdout (the git CLI is the only subprocess used for it). */
function gitOut(args) {
  const res = spawnSync('git', ['-C', SRC_DIR, ...args], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${res.error?.message ?? `exit ${res.status}`}`);
  }
  return res.stdout.trim();
}

/** Clone (or reuse) the pinned QEMU source with LF line endings. */
function prepareSource() {
  mkdirSync(BUILD_DIR, { recursive: true });
  if (FORCE && existsSync(SRC_DIR)) rmSync(SRC_DIR, { recursive: true, force: true });
  if (!existsSync(join(SRC_DIR, '.git'))) {
    log(`cloning espressif/qemu @ ${TAG} (shallow)...`);
    run('git', ['clone', '-c', 'core.autocrlf=false', '--depth', '1', '--branch', TAG, REPO_URL, SRC_DIR]);
  }
  // `git clone --branch <tag>` leaves HEAD detached, so compare commits, not refs.
  const head = gitOut(['rev-parse', 'HEAD']);
  const tagged = gitOut(['rev-parse', `refs/tags/${TAG}^{}`]);
  if (head !== tagged) {
    fail(`qemu source at ${SRC_DIR} is at ${head.slice(0, 12)}, expected tag ${TAG} (${tagged.slice(0, 12)}). Re-run with --force.`);
  }
  log(`source ready: ${SRC_DIR} (${TAG})`);
}

/** Copy the device in and register it in hw/misc/meson.build (idempotent). */
function installDevice() {
  const dstC = join(SRC_DIR, 'hw', 'misc', 'breadesp_dbus.c');
  copyFileSync(DEVICE_SRC, dstC);
  const meson = join(SRC_DIR, 'hw', 'misc', 'meson.build');
  let text = readFileSync(meson, 'utf8');
  if (!text.includes('breadesp_dbus.c')) {
    text += [
      '',
      '# BreadESP DBus forward device (PRD §4.2); zero-patch integration.',
      "system_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files('breadesp_dbus.c'))",
      '',
    ].join('\n');
    writeFileSync(meson, text);
  }
  log(`device installed: ${relative(REPO_ROOT, DEVICE_SRC)} -> hw/misc/breadesp_dbus.c`);
}

/** Normalize CRLF -> LF so files staged from a Windows checkout stay POSIX-clean. */
function toLf(buf) {
  return buf.includes(13) ? Buffer.from(buf.toString('utf8').replaceAll('\r\n', '\n'), 'utf8') : buf;
}

/** Recursive byte-exact copy, skipping VCS/cache metadata. */
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.pin') continue;
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

/** Recursive copy with CRLF -> LF normalization (text-only trees). */
function copyTreeLf(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTreeLf(s, d);
    } else {
      writeFileSync(d, toLf(readFileSync(s)));
    }
  }
}

/*
 * Meson wrap subprojects qemu pins on gitlab.com (dtc, keycodemapdb, the
 * berkeley float twins). The build container cannot reach gitlab, so:
 *
 *  - dtc: satisfied by the system libfdt-dev in the builder image;
 *  - the rest: vendored as *directory* subprojects — meson skips the .wrap
 *    download when subprojects/<name>/meson.build exists. The berkeley twins
 *    additionally get their packagefiles overlay applied, which is exactly
 *    what the wrap `patch_directory` would do.
 *
 * Revisions are read from the .wrap files so they stay pinned to the QEMU tag.
 * Mirrors: BREADESP_SUBPROJECT_MIRRORS (comma-separated `{name}` templates).
 */
const VENDORED_SUBPROJECTS = ['keycodemapdb', 'berkeley-softfloat-3', 'berkeley-testfloat-3'];
const MIRROR_TEMPLATES = (process.env.BREADESP_SUBPROJECT_MIRRORS ??
  'https://gitee.com/mirrors_qemu/{name}.git,https://gh-proxy.com/https://github.com/qemu/{name}.git,https://gitclone.com/github.com/{name}.git')
  .split(',').map((s) => s.trim()).filter(Boolean);

function wrapInfo(name) {
  const text = readFileSync(join(SRC_DIR, 'subprojects', `${name}.wrap`), 'utf8');
  const rev = text.match(/^revision\s*=\s*(\S+)/m)?.[1];
  if (!rev) fail(`cannot read revision from subprojects/${name}.wrap`);
  return { rev, patchDir: text.match(/^patch_directory\s*=\s*(\S+)/m)?.[1] };
}

/** Fetch each vendored subproject at its pinned revision (cached under BUILD_DIR). */
function prepareVendoredSubprojects() {
  const root = join(BUILD_DIR, 'subprojects');
  for (const name of VENDORED_SUBPROJECTS) {
    const { rev, patchDir } = wrapInfo(name);
    const dir = join(root, name);
    const pin = join(dir, '.pin');

    if (existsSync(pin) && readFileSync(pin, 'utf8').trim() === rev
        && existsSync(join(dir, 'meson.build'))) {
      log(`vendored subproject ${name} @ ${rev.slice(0, 12)} (cached)`);
      continue;
    }

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    run('git', ['init', '-q', dir]);
    let fetched = false;
    const errors = [];
    for (const tpl of MIRROR_TEMPLATES) {
      const url = tpl.replaceAll('{name}', name);
      const res = spawnSync('git', ['-C', dir, 'fetch', '--depth', '1', url, rev],
        { encoding: 'utf8' });
      if (res.status === 0) {
        fetched = true;
        break;
      }
      errors.push(`${url}: ${(res.stderr ?? '').trim().split('\n').pop()}`);
    }
    if (!fetched) {
      fail(`cannot fetch subproject ${name} @ ${rev} from any mirror:\n  ${errors.join('\n  ')}`);
    }
    // LF-strict checkout: a host with core.autocrlf=true would otherwise
    // smudge the tree and break the Linux container build.
    run('git', ['-C', dir, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
      'checkout', '-q', 'FETCH_HEAD']);
    if (patchDir) {
      copyTreeLf(join(SRC_DIR, 'subprojects', 'packagefiles', patchDir), dir);
    }
    writeFileSync(pin, `${rev}\n`);
    log(`vendored subproject ${name} @ ${rev.slice(0, 12)} (patch: ${patchDir ?? 'none'})`);
  }
}

/**
 * Build the source tar shipped into the build environment: `git archive HEAD`
 * (preserves executable bits, which a plain Windows copy loses) plus the
 * uncommitted device installation and the vendored wrap subprojects appended
 * via `tar -rf` (bsdtar/GNU tar both append directory entries recursively).
 */
function archiveSource() {
  const srcTar = join(BUILD_DIR, 'qemu-src.tar');
  rmSync(srcTar, { force: true });
  // `-c core.autocrlf=false -c core.eol=lf`: git archive applies worktree eol
  // smudging, and a clone made with autocrlf=true would ship CRLF files that
  // break `#!/bin/sh` shebangs in the Linux container. Force raw LF blobs.
  run('git', ['-C', SRC_DIR, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
    'archive', '--format=tar', '-o', srcTar, 'HEAD']);

  const appendRoot = join(BUILD_DIR, 'tar-append');
  rmSync(appendRoot, { recursive: true, force: true });
  mkdirSync(join(appendRoot, 'hw', 'misc'), { recursive: true });
  writeFileSync(join(appendRoot, 'hw', 'misc', 'breadesp_dbus.c'), toLf(readFileSync(DEVICE_SRC)));
  writeFileSync(join(appendRoot, 'hw', 'misc', 'meson.build'), toLf(readFileSync(join(SRC_DIR, 'hw', 'misc', 'meson.build'))));
  const entries = ['hw/misc/breadesp_dbus.c', 'hw/misc/meson.build'];
  for (const name of VENDORED_SUBPROJECTS) {
    copyTree(join(BUILD_DIR, 'subprojects', name), join(appendRoot, 'subprojects', name));
    entries.push(`subprojects/${name}`);
  }
  // bsdtar (Windows) and GNU tar (Linux/MSYS2) both append entries relative to -C.
  run('tar', ['-rf', srcTar, '-C', appendRoot, ...entries]);
  return srcTar;
}

/**
 * Base-image registry prefix: docker.io is unreachable from some networks
 * (e.g. CN ISP interception); BREADESP_DOCKER_MIRROR (e.g. "docker.1ms.run/")
 * pulls the same ubuntu:22.04 through a mirror. Empty = docker.io direct.
 */
const DOCKER_MIRROR = process.env.BREADESP_DOCKER_MIRROR ?? '';

/**
 * Ubuntu:22.04 image with the espressif CI prerequisites (minus SDL). 22.04
 * matches the espressif linux runners: libslirp 4.7 is required by net/slirp.c
 * (slirp_new, QEMU 9.2 API) — debian:11 only ships 4.4.
 */
const DOCKERFILE = `FROM ${DOCKER_MIRROR}library/ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -y -q && apt-get install -y -q --no-install-recommends \\
    build-essential git libglib2.0-dev libpixman-1-dev ninja-build \\
    python3 python3-pip zlib1g-dev libfdt-dev libgcrypt-dev libslirp-dev \\
 && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir meson==1.7.0 tomli==2.2.1
WORKDIR /work
`;

// Mirrors .github/workflows/scripts/configure-native.sh (espressif CI), minus the
// UI features the headless BreadESP build does not need. gcrypt is NOT optional:
// hw/misc/esp32_flash_enc.c includes <gcrypt.h> unconditionally. slirp must be
// explicitly enabled: this fork's meson.build declares the slirp dependency even
// when the feature is disabled, so net/slirp.c compiles and fails on the missing
// header (the espressif CI never hits this because it passes --enable-slirp).
const CONFIGURE_COMMON = [
  '--bindir=bin',
  '--datadir=share/qemu',
  `--with-pkgversion=breadesp-${TAG}`,
  '--with-suffix=""',
  '--target-list=xtensa-softmmu',
  '--without-default-features',
  '--enable-gcrypt',
  '--enable-slirp',
  '--enable-pixman',
  '--enable-stack-protector',
];

/** Build via the Docker Linux image; artifacts come back as a tar stream. */
function buildLinuxDocker() {
  // Content-address the builder: a Dockerfile change (new apt package, meson
  // bump) must rebuild the image instead of silently reusing a stale one.
  const image = `breadesp/qemu-builder:${TAG.replace(/[^a-z0-9._-]/gi, '_')}-${createHash('sha256')
    .update(DOCKERFILE).digest('hex').slice(0, 12)}`;
  // Reuse a previously built image when possible: docker.io may be unreachable
  // (e.g. CN ISP interception), and a cached builder is identical anyway.
  const have = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
  if (have.status !== 0) {
    // Dockerfile via stdin: keeps the build context empty (BUILD_DIR holds the
    // multi-GB source checkout — uploading it as context would take forever).
    const res = spawnSync('docker', ['build', '-t', image, '-'], {
      input: DOCKERFILE,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (res.error) fail(`failed to launch docker: ${res.error.message}`);
    if (res.status !== 0) fail(`docker build exited with code ${res.status}`);
  } else {
    log(`reusing cached builder image ${image}`);
  }

  const srcTar = archiveSource();
  const outTar = join(BUILD_DIR, 'qemu-install.tar');
  rmSync(outTar, { force: true });
  const script = [
    'set -ex',
    'mkdir -p /tmp/qemu && tar xf /work/qemu-src.tar -C /tmp/qemu',
    'cd /tmp/qemu',
    `./configure ${CONFIGURE_COMMON.join(' ')} --prefix=/tmp/qemu/install/qemu`,
    'ninja -C build install',
    'cd /tmp/qemu/install && tar cf /work/qemu-install.tar qemu',
  ].join('\n');
  run('docker', ['run', '--rm',
    '--mount', `type=bind,src=${BUILD_DIR},dst=/work`,
    image, 'bash', '-c', script]);
  return outTar;
}

/** Build natively under MSYS2 MINGW64 (static), mirroring espressif configure-win.sh. */
function buildWindowsMsys2() {
  const bash = join(MSYS2_DIR, 'usr', 'bin', 'bash.exe');
  if (!existsSync(bash)) {
    fail(`MSYS2 not found at ${MSYS2_DIR}. Install MSYS2 (MINGW64) and set BREADESP_MSYS2_DIR.`);
  }
  const script = [
    'set -euo pipefail',
    `cd "$(cygpath -u '${SRC_DIR.replace(/'/g, "'\\''")}')"`,
    // Remove leftovers from a previous configure (safe no-op on a fresh tree).
    'rm -rf build install',
    `./configure ${CONFIGURE_COMMON.join(' ')} --static --prefix=$PWD/install/qemu`,
    // pkg-config emits dynamic import libs and MSYS-style paths for libintl and
    // libiconv; redirect them to the static archives (espressif configure-win.sh).
    'MSYS_BASE=$(cygpath -w / | sed "s|\\\\\\\\|/|g")',
    'sed -i "s|/mingw64/lib/libintl.dll.a|${MSYS_BASE}/mingw64/lib/libintl.a|g; s|/mingw64/lib/libiconv.dll.a|${MSYS_BASE}/mingw64/lib/libiconv.a|g" build/build.ninja',
    'ninja -C build install',
    'cd install && tar cf qemu-install.tar qemu',
  ].join('\n');
  run(bash, ['-lc', script], {
    env: { ...process.env, MSYSTEM: 'MINGW64', CHERE_INVOKING: 'yes' },
    cwd: SRC_DIR,
  });
  return join(SRC_DIR, 'install', 'qemu-install.tar');
}

/** Depth-first search for `name` under `root` (the install tree is tiny). */
function findFile(root, name) {
  if (statSync(root).isDirectory()) {
    for (const entry of readdirSync(root)) {
      const hit = findFile(join(root, entry), name);
      if (hit) return hit;
    }
    return null;
  }
  return basename(root) === name ? root : null;
}

/**
 * Stage install/qemu (bin/qemu-system-xtensa[.exe] + share/qemu/esp*.bin roms)
 * from the produced tar into OUT_DIR and write the bin/qemu-breadesp.json meta
 * used by tests and later by the Bridge (QemuRunner device-path resolution).
 */
function stageOutput(installTar) {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  run('tar', ['-xf', installTar, '-C', OUT_DIR]);
  // The staged binary runs on the build *target*, not the host: a linux-docker
  // build staged from a Windows host yields the extension-less ELF binary.
  const exe = TARGET === 'linux-docker' ? 'qemu-system-xtensa' : 'qemu-system-xtensa.exe';
  const binaryPath = findFile(OUT_DIR, exe);
  if (!binaryPath) fail(`${exe} not found in build output under ${OUT_DIR}`);
  const romPath = findFile(OUT_DIR, 'esp32-v3-rom.bin');
  if (!romPath) fail('esp32-v3-rom.bin missing from build output (roms not installed?)');
  const share = dirname(romPath);
  const roms = readdirSync(share).filter((f) => /^esp.*\.bin$/.test(f));
  if (roms.length === 0) fail('ESP32 rom blobs (esp*.bin) missing from build output');
  const meta = {
    release: TAG,
    device: 'breadesp-dbus',
    dbusProtocol: 1,
    target: TARGET,
    binaryPath,
    shareDir: share,
    roms,
    builtAt: new Date().toISOString(),
    repoRelativePath: relative(REPO_ROOT, binaryPath),
  };
  writeFileSync(OUT_META, `${JSON.stringify(meta, null, 2)}\n`);
  log(`staged ${relative(REPO_ROOT, binaryPath)} (+${roms.length} rom blobs)`);
  log(`wrote metadata: ${relative(REPO_ROOT, OUT_META)}`);
}

// --- main ---
try {
  log(`target=${TARGET} tag=${TAG}`);
  prepareSource();
  installDevice();
  prepareVendoredSubprojects();
  const tar = TARGET === 'linux-docker' ? buildLinuxDocker() : buildWindowsMsys2();
  stageOutput(tar);
  log('done. Smoke check: BREADESP_QEMU_DBUS_BIN=<binary> pnpm --filter @breadesp/shell test');
} catch (err) {
  console.error(`[build-qemu-device] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
