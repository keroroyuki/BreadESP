// PRD: §F-PROJ-3 — pure view logic for the external firmware panel
// (dev-plan task P4.3). The component holds the scan result; all label
// derivation, formatting and import-candidate selection lives here so it is
// unit-testable without a DOM.
import type { ExternalElfCandidate, ExternalProjectKind, ExternalScanResult } from '../../ipc/bridge';

/** Display name of the external build system. */
export function kindLabel(kind: ExternalProjectKind): string {
  return kind === 'platformio' ? 'PlatformIO' : 'ESP-IDF';
}

/** Last path segment, tolerant of both Windows and POSIX separators. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

/** `<env> · <file>` for PlatformIO, `<file>` for the single-build IDF layout. */
export function candidateLabel(c: ExternalElfCandidate): string {
  return c.env !== null ? `${c.env} · ${baseName(c.path)}` : baseName(c.path);
}

/** Human-readable byte size (B/KB/MB, one decimal for the larger units). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Relative age of a build ("just now", "5m ago", "2h ago", "3d ago"). */
export function formatAge(mtimeMs: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - mtimeMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The candidate an Import click should use: the user's selection when it is
 * still part of the scan, otherwise the newest build (scans arrive
 * newest-first). Null when nothing was discovered.
 */
export function pickImportCandidate(
  candidates: ExternalElfCandidate[],
  selectedPath: string | null,
): ExternalElfCandidate | null {
  if (candidates.length === 0) return null;
  const selected = selectedPath !== null ? candidates.find((c) => c.path === selectedPath) : undefined;
  return selected ?? candidates[0];
}

/** One-line summary of a scan for the panel header. */
export function scanSummary(scan: ExternalScanResult, nowMs: number): string {
  const n = scan.candidates.length;
  if (n === 0) return 'no build/*.elf yet — build the firmware first';
  const newest = scan.candidates[0];
  return `${n} ELF${n === 1 ? '' : 's'} · newest ${formatAge(newest.mtimeMs, nowMs)}`;
}
