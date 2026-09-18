// PRD: §6.2, §F-EXT — Peripheral registry. Maps factory.kind -> factory.
// P5.1 (SDK stabilization + versioning): registration is gated by
// validatePeripheralFactory — malformed factories, duplicate kinds and
// factories built against a newer SDK major are rejected with coded errors
// ([BB-220]/[BB-221]/[BB-222]) instead of failing deep inside the Bridge.
import { PIN_ROLES, type PeripheralFactory, type PinDescriptor } from './types';
import { ledFactory } from './led';
import { buttonFactory } from './button';
import { ssd1306Factory } from './ssd1306';
import { st7789Factory } from './st7789';
import { buzzerFactory } from './buzzer';
import { speakerFactory } from './speaker';
import { oscilloscopeFactory } from './oscilloscope';
import { micFactory } from './mic';
import { knobFactory } from './knob';
import { sht30Factory } from './sht30';

/**
 * SDK contract version of this host (PRD §6.2, P5.1). Semver. The major
 * component gates registration: a factory declaring `sdkVersion` with a newer
 * major is rejected, because the host cannot guarantee a contract surface it
 * does not know yet. Bump the major on breaking §6.1–6.4 changes (PRD §10.3).
 */
export const PERIPHERAL_SDK_VERSION = '1.0.0';

// Official semver.org grammar (with prerelease/build), anchored.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** True when `v` is a well-formed semantic version (e.g. '1.0.0', '0.0.0-test'). */
export function isSemver(v: unknown): v is string {
  return typeof v === 'string' && SEMVER_RE.test(v);
}

/** Major component of a well-formed semver; -1 for malformed input. */
export function semverMajor(v: string): number {
  const m = SEMVER_RE.exec(v);
  return m === null ? -1 : Number(m[1]);
}

// Kinds become netlist identifiers and instanceId prefixes; keep them
// lowercase kebab so projects stay portable and ids unambiguous.
const KIND_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function validatePin(pin: unknown, issues: string[], seen: Set<string>): void {
  if (!isPlainObject(pin)) {
    issues.push('pins entries must be objects');
    return;
  }
  // Boundary cast (dev-plan §4.3): `pin` is third-party input validated field
  // by field below; Partial<> only widens every field to possibly-absent.
  const p = pin as Partial<PinDescriptor>;
  if (typeof p.id !== 'string' || p.id.length === 0) {
    issues.push('pin id must be a non-empty string');
  } else if (seen.has(p.id)) {
    issues.push(`duplicate pin id '${p.id}'`);
  } else {
    seen.add(p.id);
  }
  if (typeof p.role !== 'string' || !(PIN_ROLES as readonly string[]).includes(p.role)) {
    issues.push(`pin '${typeof p.id === 'string' ? p.id : '?'}' has unknown role '${String(p.role)}'`);
  }
  if (p.optional !== undefined && typeof p.optional !== 'boolean') {
    issues.push(`pin '${typeof p.id === 'string' ? p.id : '?'}' optional flag must be a boolean`);
  }
}

/**
 * Validate a factory against the §6.2 contract. Returns a list of readable
 * issues (empty = valid); registerPeripheral turns a non-empty list into a
 * coded [BB-220] rejection. Pure and exported so third parties can preflight
 * a factory in their own tests.
 */
export function validatePeripheralFactory(factory: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(factory)) return ['factory must be an object'];
  // Boundary cast (dev-plan §4.3): same rationale as validatePin — the whole
  // point of this function is to inspect untrusted external factory input.
  const f = factory as Partial<PeripheralFactory>;
  if (typeof f.kind !== 'string' || !KIND_RE.test(f.kind)) {
    issues.push(`kind must be a lowercase kebab-case identifier (${String(f.kind)})`);
  }
  if (!isSemver(f.version)) {
    issues.push(`version must be a semantic version (got ${String(f.version)})`);
  }
  if (f.sdkVersion !== undefined && !isSemver(f.sdkVersion)) {
    issues.push(`sdkVersion must be a semantic version (got ${String(f.sdkVersion)})`);
  }
  if (typeof f.displayName !== 'string' || f.displayName.trim().length === 0) {
    issues.push('displayName must be a non-empty string');
  }
  if (!Array.isArray(f.pins)) {
    issues.push('pins must be an array');
  } else {
    const seen = new Set<string>();
    for (const pin of f.pins) validatePin(pin, issues, seen);
  }
  if (f.defaults !== undefined && !isPlainObject(f.defaults)) {
    issues.push('defaults must be a plain object');
  }
  if (typeof f.create !== 'function') {
    issues.push('create must be a function');
  }
  return issues;
}

const factories = new Map<string, PeripheralFactory>();

/**
 * Register a peripheral factory (PRD §F-EXT-1). Validation failures reject
 * with [BB-220]; a kind that is already taken rejects with [BB-221]; a
 * factory built against a newer SDK major than PERIPHERAL_SDK_VERSION rejects
 * with [BB-222]. Successful registration makes the kind resolvable by the
 * Bridge (PeripheralManager/NetlistResolver) and — in the renderer process —
 * visible in the palette and on the canvas automatically.
 */
export function registerPeripheral(factory: PeripheralFactory): void {
  const issues = validatePeripheralFactory(factory);
  if (issues.length > 0) {
    const kind = isPlainObject(factory) && typeof factory.kind === 'string' ? factory.kind : '?';
    throw new Error(`[BB-220] invalid peripheral factory '${kind}': ${issues.join('; ')}`);
  }
  if (factory.sdkVersion !== undefined && semverMajor(factory.sdkVersion) > semverMajor(PERIPHERAL_SDK_VERSION)) {
    throw new Error(
      `[BB-222] peripheral '${factory.kind}' requires SDK ${factory.sdkVersion} but this host provides SDK ${PERIPHERAL_SDK_VERSION}; upgrade BreadESP`,
    );
  }
  if (factories.has(factory.kind)) {
    throw new Error(`[BB-221] peripheral kind '${factory.kind}' is already registered`);
  }
  factories.set(factory.kind, factory);
}

export function getFactory(kind: string): PeripheralFactory | undefined {
  return factories.get(kind);
}

/** Every registered factory in registration order (fresh array per call). */
export function listPeripherals(): PeripheralFactory[] {
  return [...factories.values()];
}

let builtinsRegistered = false;

/**
 * Register all built-in peripherals. Idempotent (P5.1): both process entries
 * (Bridge main, UI renderer) and multiple UI modules may ensure the built-in
 * set without coordinating who runs first; a second call is a no-op. The flag
 * flips only after the full set registered, so a mid-loop failure (e.g. a
 * third-party package squatting a built-in kind) stays loud on every call
 * instead of degrading to a silent partial registry.
 */
export function registerBuiltins(): void {
  if (builtinsRegistered) return;
  // PRD §8 MVP set: led, button, ssd1306; st7789 P2.1, buzzer P2.3, speaker P2.4, oscilloscope P2.5, mic P3.1, knob + sht30 P3.4.
  for (const f of [ledFactory, buttonFactory, ssd1306Factory, st7789Factory, buzzerFactory, speakerFactory, oscilloscopeFactory, micFactory, knobFactory, sht30Factory]) registerPeripheral(f);
  builtinsRegistered = true;
}
