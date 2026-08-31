// PRD: §6.5, §F-BB — Netlist validation (structural + semantic).
import { layoutSchema, netlistSchema } from './schema';
import type { LayoutFile, Netlist, Wire } from './types';
import { MCU_INSTANCE_ID } from './types';

export interface ValidationIssue {
  level: 'error' | 'warn';
  message: string;
  path?: string;
}

/** Validate structure via zod, then run semantic checks. */
export function validateNetlist(input: unknown): { ok: boolean; issues: ValidationIssue[] } {
  const parsed = netlistSchema.safeParse(input);
  const issues: ValidationIssue[] = [];

  if (!parsed.success) {
    for (const err of parsed.error.issues) {
      issues.push({ level: 'error', message: err.message, path: err.path.join('.') });
    }
    return { ok: false, issues };
  }

  const net = parsed.data as Netlist;

  // Unique instance ids.
  const ids = new Set<string>();
  for (const p of net.peripherals) {
    if (ids.has(p.instanceId)) {
      issues.push({ level: 'error', message: `Duplicate peripheral instanceId: ${p.instanceId}` });
    }
    ids.add(p.instanceId);
  }

  // Wire endpoints reference known instances (mcu or a peripheral).
  const known = (ep: Wire['from']) =>
    ep.instanceId === MCU_INSTANCE_ID || ids.has(ep.instanceId);
  for (const w of net.wires) {
    if (!known(w.from)) issues.push({ level: 'error', message: `Wire ${w.id} from unknown instance ${w.from.instanceId}` });
    if (!known(w.to)) issues.push({ level: 'error', message: `Wire ${w.id} to unknown instance ${w.to.instanceId}` });
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues };
}

/** Validate layout.json input: structure via zod, then unique instanceIds. */
export function validateLayout(input: unknown): { ok: boolean; issues: ValidationIssue[] } {
  const parsed = layoutSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((err) => ({
        level: 'error' as const,
        message: err.message,
        path: err.path.join('.'),
      })),
    };
  }

  const lay = parsed.data as LayoutFile;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const it of lay.items) {
    if (ids.has(it.instanceId)) {
      issues.push({ level: 'error', message: `Duplicate layout instanceId: ${it.instanceId}` });
    }
    ids.add(it.instanceId);
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues };
}
