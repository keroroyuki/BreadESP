// PRD: §F-PROJ-3, dev-plan task P4.3 — pure view logic of the external
// firmware panel: candidate labels, size/age formatting, import-pick
// selection and the scan summary line.
import { describe, it, expect } from 'vitest';
import {
  baseName,
  candidateLabel,
  formatAge,
  formatBytes,
  kindLabel,
  pickImportCandidate,
  scanSummary,
} from '../src/components/ExternalFirmware/externalDraft';
import type { ExternalElfCandidate, ExternalScanResult } from '../src/ipc/bridge';

const cand = (over: Partial<ExternalElfCandidate>): ExternalElfCandidate => ({
  path: '/pio/.pio/build/env/firmware.elf',
  env: 'env',
  mtimeMs: 1_000_000,
  sizeBytes: 2048,
  ...over,
});

describe('externalDraft labels (P4.3)', () => {
  it('kindLabel maps both build systems', () => {
    expect(kindLabel('platformio')).toBe('PlatformIO');
    expect(kindLabel('esp-idf')).toBe('ESP-IDF');
  });

  it('baseName splits both Windows and POSIX separators', () => {
    expect(baseName('C:\\proj\\build\\app.elf')).toBe('app.elf');
    expect(baseName('/home/pio/.pio/build/env/firmware.elf')).toBe('firmware.elf');
    expect(baseName('bare.elf')).toBe('bare.elf');
  });

  it('candidateLabel prefixes the PlatformIO env, plain file for IDF', () => {
    expect(candidateLabel(cand({ env: 'esp32dev' }))).toBe('esp32dev · firmware.elf');
    expect(candidateLabel(cand({ env: null }))).toBe('firmware.elf');
  });
});

describe('externalDraft formatting (P4.3)', () => {
  it('formatBytes scales B/KB/MB and clamps degenerate input', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });

  it('formatAge buckets minutes/hours/days', () => {
    const now = 1_800_000_000_000;
    expect(formatAge(now - 5_000, now)).toBe('just now');
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAge(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(formatAge(now - 3 * 86_400_000, now)).toBe('3d ago');
    // A future mtime (clock skew) never renders a negative age.
    expect(formatAge(now + 60_000, now)).toBe('just now');
  });
});

describe('externalDraft import pick (P4.3)', () => {
  const a = cand({ path: '/x/a.elf', env: 'a' });
  const b = cand({ path: '/x/b.elf', env: 'b' });

  it('prefers the explicit selection while it is part of the scan', () => {
    expect(pickImportCandidate([a, b], '/x/b.elf')).toBe(b);
  });

  it('falls back to the newest (first) candidate when nothing is selected', () => {
    expect(pickImportCandidate([a, b], null)).toBe(a);
  });

  it('falls back to the newest when the selection vanished from the scan', () => {
    expect(pickImportCandidate([a, b], '/x/gone.elf')).toBe(a);
  });

  it('returns null for an empty scan', () => {
    expect(pickImportCandidate([], '/x/a.elf')).toBeNull();
  });
});

describe('externalDraft scan summary (P4.3)', () => {
  const scanOf = (candidates: ExternalElfCandidate[]): ExternalScanResult => ({
    link: { kind: 'platformio', dir: '/x' },
    candidates,
  });

  it('guides the user to build when nothing was discovered', () => {
    expect(scanSummary(scanOf([]), 0)).toBe('no build/*.elf yet — build the firmware first');
  });

  it('reports the count and newest age (singular/plural)', () => {
    const now = 1_800_000_000_000;
    expect(scanSummary(scanOf([cand({ mtimeMs: now - 60_000 })]), now)).toBe('1 ELF · newest 1m ago');
    expect(
      scanSummary(scanOf([cand({ mtimeMs: now - 120_000 }), cand({ mtimeMs: now - 600_000 })]), now),
    ).toBe('2 ELFs · newest 2m ago');
  });
});
