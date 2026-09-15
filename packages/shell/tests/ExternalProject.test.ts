// PRD: §F-PROJ-3, dev-plan task P4.3 — PlatformIO/ESP-IDF detection and
// build/*.elf discovery unit tests (real temp directories, no IPC involved).
import { describe, expect, it, afterAll } from 'vitest';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectExternalProject,
  parsePlatformioEnvs,
  scanExternalProject,
} from '../src/project/ExternalProject.js';

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-p43-scan-'));
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

async function makeFile(path: string, content = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

/** Set a deterministic mtime so scan ordering is testable. */
async function setMtime(path: string, epochMs: number): Promise<void> {
  const d = new Date(epochMs);
  await utimes(path, d, d);
}

describe('parsePlatformioEnvs (P4.3)', () => {
  it('extracts named [env:x] sections in declaration order', () => {
    const ini = [
      '[platformio]',
      'default_envs = esp32dev',
      '',
      '[env:esp32dev]',
      'platform = espressif32',
      '[env:s3-box]',
      'board = esp32-s3',
    ].join('\n');
    expect(parsePlatformioEnvs(ini)).toEqual(['esp32dev', 's3-box']);
  });

  it('maps the bare [env] defaults section to the "env" build dir', () => {
    expect(parsePlatformioEnvs('[env]\nplatform = espressif32\n')).toEqual(['env']);
  });

  it('ignores comments, non-env sections and blank lines; tolerates CRLF', () => {
    const ini = '; c1\r\n[platformio]\r\n# c2\r\n[env:nodemcu]\r\n\r\n[common]\r\n[env:lolin]\r\n';
    expect(parsePlatformioEnvs(ini)).toEqual(['nodemcu', 'lolin']);
  });

  it('dedupes repeated sections and trims whitespace in names', () => {
    const ini = '[env:a]\n[env:a]\n[env: b ]\n';
    expect(parsePlatformioEnvs(ini)).toEqual(['a', 'b']);
  });
});

describe('detectExternalProject (P4.3)', () => {
  it('recognizes a PlatformIO project by platformio.ini', async () => {
    const dir = join(tmp, 'pio');
    await makeFile(join(dir, 'platformio.ini'), '[env:esp32dev]\n');
    await expect(detectExternalProject(dir)).resolves.toBe('platformio');
  });

  it('recognizes an ESP-IDF project by CMakeLists.txt + sdkconfig', async () => {
    const dir = join(tmp, 'idf-sdkconfig');
    await makeFile(join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\n');
    await makeFile(join(dir, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32"\n');
    await expect(detectExternalProject(dir)).resolves.toBe('esp-idf');
  });

  it('recognizes an ESP-IDF project by the project.cmake include alone', async () => {
    const dir = join(tmp, 'idf-include');
    await makeFile(
      join(dir, 'CMakeLists.txt'),
      'cmake_minimum_required(VERSION 3.16)\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(app)\n',
    );
    await expect(detectExternalProject(dir)).resolves.toBe('esp-idf');
  });

  it('rejects a bare CMake project with no IDF signal', async () => {
    const dir = join(tmp, 'plain-cmake');
    await makeFile(join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\nproject(hello)\n');
    await expect(detectExternalProject(dir)).resolves.toBeNull();
  });

  it('prefers PlatformIO when both markers exist (CLion layouts carry both)', async () => {
    const dir = join(tmp, 'both');
    await makeFile(join(dir, 'platformio.ini'), '[env:a]\n');
    await makeFile(join(dir, 'CMakeLists.txt'), 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\n');
    await makeFile(join(dir, 'sdkconfig'), '');
    await expect(detectExternalProject(dir)).resolves.toBe('platformio');
  });

  it('returns null for empty or missing directories', async () => {
    const dir = join(tmp, 'empty');
    await mkdir(dir, { recursive: true });
    await expect(detectExternalProject(dir)).resolves.toBeNull();
    await expect(detectExternalProject(join(tmp, 'gone'))).resolves.toBeNull();
  });
});

describe('scanExternalProject — platformio (P4.3)', () => {
  it('discovers .pio/build/<env>/*.elf, newest first, with env names', async () => {
    const dir = join(tmp, 'pio-scan');
    await makeFile(join(dir, 'platformio.ini'), '[env:esp32dev]\n[env:s3]\n');
    const older = join(dir, '.pio', 'build', 'esp32dev', 'firmware.elf');
    const newer = join(dir, '.pio', 'build', 's3', 'firmware.elf');
    await makeFile(older, 'old');
    await makeFile(newer, 'new');
    await setMtime(older, 1_700_000_000_000);
    await setMtime(newer, 1_800_000_000_000);

    const scan = await scanExternalProject(dir);
    expect(scan).not.toBeNull();
    expect(scan!.link).toEqual({ kind: 'platformio', dir });
    expect(scan!.candidates.map((c) => c.path)).toEqual([newer, older]);
    expect(scan!.candidates.map((c) => c.env)).toEqual(['s3', 'esp32dev']);
    expect(scan!.candidates[0].mtimeMs).toBeGreaterThan(scan!.candidates[1].mtimeMs);
    expect(scan!.candidates[1].sizeBytes).toBe(3);
  });

  it('also lists env build dirs that platformio.ini no longer declares', async () => {
    const dir = join(tmp, 'pio-stale-env');
    await makeFile(join(dir, 'platformio.ini'), '[env:current]\n');
    await makeFile(join(dir, '.pio', 'build', 'current', 'firmware.elf'));
    await makeFile(join(dir, '.pio', 'build', 'deleted-env', 'firmware.elf'));
    const scan = await scanExternalProject(dir);
    expect(scan!.candidates.map((c) => c.env).sort()).toEqual(['current', 'deleted-env']);
  });

  it('falls back to on-disk env dirs when the ini declares none', async () => {
    const dir = join(tmp, 'pio-no-envs');
    await makeFile(join(dir, 'platformio.ini'), '[platformio]\n');
    await makeFile(join(dir, '.pio', 'build', 'env', 'firmware.elf'));
    const scan = await scanExternalProject(dir);
    expect(scan!.candidates.map((c) => c.env)).toEqual(['env']);
  });

  it('ignores non-.elf files, nested directories and missing build roots', async () => {
    const dir = join(tmp, 'pio-filter');
    await makeFile(join(dir, 'platformio.ini'), '[env:a]\n[env:b]\n');
    await makeFile(join(dir, '.pio', 'build', 'a', 'firmware.elf'));
    await makeFile(join(dir, '.pio', 'build', 'a', 'firmware.bin'));
    await makeFile(join(dir, '.pio', 'build', 'a', 'firmware.map'));
    await makeFile(join(dir, '.pio', 'build', 'a', 'deeper', 'nested.elf'));
    // env b has no build directory at all.
    const scan = await scanExternalProject(dir);
    expect(scan!.candidates).toHaveLength(1);
    expect(scan!.candidates[0].env).toBe('a');
    expect(scan!.candidates[0].path.endsWith('firmware.elf')).toBe(true);
  });

  it('breaks mtime ties by path for a deterministic order', async () => {
    const dir = join(tmp, 'pio-tie');
    await makeFile(join(dir, 'platformio.ini'), '[env:a]\n[env:b]\n');
    const pa = join(dir, '.pio', 'build', 'a', 'firmware.elf');
    const pb = join(dir, '.pio', 'build', 'b', 'firmware.elf');
    await makeFile(pa);
    await makeFile(pb);
    await setMtime(pa, 1_700_000_000_000);
    await setMtime(pb, 1_700_000_000_000);
    const scan = await scanExternalProject(dir);
    expect(scan!.candidates.map((c) => c.path)).toEqual([pa, pb].sort((x, y) => x.localeCompare(y)));
  });
});

describe('scanExternalProject — esp-idf (P4.3)', () => {
  it('discovers build/*.elf with a null env and skips subdirectories', async () => {
    const dir = join(tmp, 'idf-scan');
    await makeFile(join(dir, 'CMakeLists.txt'), 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\n');
    const app = join(dir, 'build', 'my-app.elf');
    await makeFile(app);
    await makeFile(join(dir, 'build', 'bootloader', 'bootloader.elf'));
    await makeFile(join(dir, 'build', 'app.bin'));
    const scan = await scanExternalProject(dir);
    expect(scan!.link.kind).toBe('esp-idf');
    expect(scan!.candidates).toHaveLength(1);
    expect(scan!.candidates[0]).toMatchObject({ path: app, env: null });
  });

  it('returns an empty candidate list when the project was never built', async () => {
    const dir = join(tmp, 'idf-unbuilt');
    await makeFile(join(dir, 'CMakeLists.txt'), 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\n');
    await makeFile(join(dir, 'sdkconfig'), '');
    const scan = await scanExternalProject(dir);
    expect(scan!.candidates).toEqual([]);
  });

  it('returns null for an unrecognized directory', async () => {
    const dir = join(tmp, 'unknown');
    await mkdir(dir, { recursive: true });
    await expect(scanExternalProject(dir)).resolves.toBeNull();
  });
});
