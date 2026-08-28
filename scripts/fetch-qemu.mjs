// PRD: §5, §10.6 — On-demand QEMU-ESP32 binary fetcher (P0.2).
// Downloads the pinned qemu-system-xtensa build for the current host from espressif/qemu
// releases into packages/sim-core/bin/, verifying SHA-256 against the official checksum
// manifest before extraction. No binary is ever committed to the repo.
//
// Chain of trust:
//   embedded CHECKSUM_MANIFEST_SHA256 -> official *-checksum.sha256 -> release archive
// Bumping RELEASE_TAG MUST bump CHECKSUM_MANIFEST_SHA256 (single value to maintain).
// TODO(PRD §5): re-pin to a newer espressif/qemu release when its checksum manifest is reviewed.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BIN_DIR = join(REPO_ROOT, 'packages', 'sim-core', 'bin');
const BIN_NAME = 'qemu-system-xtensa';

// --- Pinned release manifest (reviewed against https://github.com/espressif/qemu/releases) ---
const RELEASE_TAG = 'esp-develop-9.2.2-20260417';
const CHECKSUM_MANIFEST = 'qemu-esp_develop_9.2.2_20260417-checksum.sha256';
const CHECKSUM_MANIFEST_SHA256 = 'd12160e1dc0b3dd1eca1917652c4bb9f3dae02f800caeb5b78a9d4b384e852e2';
const ASSET_VERSION = 'esp_develop_9.2.2_20260417';
/** GitHub release asset target triple per host platform/arch (PRD §11: Node >= 20 hosts). */
const HOST_TRIPLES = {
  'win32-x64': 'x86_64-w64-mingw32',
  'linux-x64': 'x86_64-linux-gnu',
  'linux-arm64': 'aarch64-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};
const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

const downloadUrl = (asset) => `https://github.com/espressif/qemu/releases/download/${RELEASE_TAG}/${asset}`;

const log = (msg) => console.log(`[fetch-qemu] ${msg}`);
/** Abort with a readable, prefixed error; thrown so the caller's finally block can clean up temp files. */
class FetchError extends Error {}
const fail = (msg) => {
  throw new FetchError(msg);
};

/** TLS interception proxies (corporate/ISP) break Node's bundled CA store; these codes are retryable with --use-system-ca. */
const CERT_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

function hostTriple() {
  const key = `${process.platform}-${process.arch}`;
  const triple = HOST_TRIPLES[key];
  if (!triple) fail(`Unsupported host "${key}". Supported: ${Object.keys(HOST_TRIPLES).join(', ')}.`);
  return triple;
}

/** Stream `url` to `dest` following redirects; resolves with the SHA-256 hex digest of the payload. */
function downloadWithHash(url, dest, redirectsLeft = 5) {
  return new Promise((resolveHash, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'breadesp-fetch-qemu' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          resolveHash(downloadWithHash(new URL(res.headers.location, url).href, dest, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const hash = createHash('sha256');
        let seen = 0;
        let nextMilestone = 0;
        const total = Number(res.headers['content-length']) || 0;
        const file = createWriteStream(dest);
        res.on('data', (chunk) => {
          hash.update(chunk);
          seen += chunk.length;
          if (total && seen >= nextMilestone) {
            log(`  ${Math.min(100, Math.round((seen / total) * 100))}% (${Math.round(seen / 1048576)} MB)`);
            nextMilestone += total / 4;
          }
        });
        res.on('error', reject);
        file.on('error', reject);
        file.on('finish', () => file.close(() => resolveHash(hash.digest('hex'))));
        res.pipe(file);
      })
      .on('error', reject);
  });
}

function extractArchive(archivePath, destDir) {
  // stdio inherit (no pipes): keeps tar usable in sandboxed/CI environments and streams its errors directly.
  const res = spawnSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
  if (res.error) {
    fail(`Failed to launch "tar" (${res.error.message}). Install a tar that supports xz, or extract ${archivePath} manually into ${destDir}.`);
  }
  if (res.status !== 0) {
    fail(`tar exited with code ${res.status} while extracting.\nOn Debian/Ubuntu install xz-utils (apt install xz-utils), then retry.`);
  }
}

async function findBinary(dir) {
  const wanted = BIN_NAME + EXE_SUFFIX;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findBinary(full);
      if (hit) return hit;
    } else if (entry.name === wanted) {
      return full;
    }
  }
  return null;
}

function printVersion(binaryPath) {
  const res = spawnSync(binaryPath, ['--version'], { stdio: 'inherit' });
  if (res.status !== 0) fail(`"${BIN_NAME} --version" exited with code ${res.status}. Binary at: ${binaryPath}`);
  log(`Version check OK. Binary: ${binaryPath}`);
  log(`Set BREADESP_QEMU_BIN=${binaryPath} (PRD §11.2) or let QemuRunner read bin/qemu.json.`);
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/fetch-qemu.mjs [--force]\n  --force    re-download even if the binary already exists');
    return;
  }
  const force = process.argv.includes('--force');
  const asset = `qemu-xtensa-softmmu-${ASSET_VERSION}-${hostTriple()}.tar.xz`;
  // tmpDir holds downloads only and is wiped on exit; the extraction dir is the binary's stable home.
  const tmpDir = join(BIN_DIR, `.tmp-fetch-${RELEASE_TAG}`);
  const extractDir = join(BIN_DIR, asset.replace(/\.tar\.xz$/, ''));

  const existing = existsSync(BIN_DIR) ? await findBinary(BIN_DIR) : null;
  if (existing && !force) {
    log(`Already fetched: ${existing} (use --force to re-download)`);
    printVersion(existing);
    return;
  }

  await mkdir(tmpDir, { recursive: true });
  try {
    // 1. Verify the official checksum manifest against the digest pinned above.
    const manifestPath = join(tmpDir, CHECKSUM_MANIFEST);
    log(`Downloading checksum manifest: ${CHECKSUM_MANIFEST}`);
    const manifestHash = await downloadWithHash(downloadUrl(CHECKSUM_MANIFEST), manifestPath);
    if (manifestHash !== CHECKSUM_MANIFEST_SHA256) {
      fail(`Checksum manifest hash mismatch:\n  expected ${CHECKSUM_MANIFEST_SHA256}\n  actual   ${manifestHash}\nThe release may have changed; re-pin scripts/fetch-qemu.mjs.`);
    }

    // 2. Extract the archive's expected digest from the verified manifest.
    const manifestLine = readFileSync(manifestPath, 'utf8')
      .split('\n')
      .find((line) => line.trimEnd().endsWith(asset));
    if (!manifestLine) fail(`Manifest does not list "${asset}". Release assets changed; re-pin the script.`);
    const archiveSha256 = manifestLine.trim().split(/\s+/)[0].toLowerCase();

    // 3. Download the archive and verify it.
    const archivePath = join(tmpDir, asset);
    log(`Downloading ${asset}`);
    const archiveHash = await downloadWithHash(downloadUrl(asset), archivePath);
    if (archiveHash !== archiveSha256) {
      fail(`Archive hash mismatch:\n  expected ${archiveSha256}\n  actual   ${archiveHash}`);
    }
    log('SHA-256 verified against official manifest.');

    // 4. Extract, locate the binary, record metadata for QemuRunner (P0.4).
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    log('Extracting...');
    extractArchive(archivePath, extractDir);

    const binaryPath = await findBinary(extractDir);
    if (!binaryPath) fail(`${BIN_NAME} not found inside the extracted archive.`);
    if (process.platform !== 'win32') await chmod(binaryPath, 0o755);

    const metaPath = join(BIN_DIR, 'qemu.json');
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          release: RELEASE_TAG,
          asset,
          sha256: archiveHash,
          binaryPath,
          binDir: BIN_DIR,
          repoRelativePath: relative(REPO_ROOT, binaryPath),
          fetchedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
    log(`Wrote metadata: ${metaPath}`);
    printVersion(binaryPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Runner: on certificate-verification failure (TLS-intercepting proxy), retry once trusting the OS cert store.
try {
  await main();
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supportsSystemCa = major > 22 || (major === 22 && minor >= 10);
  if (CERT_ERROR_CODES.has(code) && supportsSystemCa && !process.execArgv.includes('--use-system-ca')) {
    console.error(`[fetch-qemu] TLS certificate verification failed (${code}). Retrying with --use-system-ca (trusts the OS certificate store)...`);
    const res = spawnSync(
      process.execPath,
      [...process.execArgv, '--use-system-ca', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit' },
    );
    process.exit(res.status ?? 1);
  }
  console.error(`[fetch-qemu] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
