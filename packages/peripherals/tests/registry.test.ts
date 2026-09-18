// PRD: §6.2, §F-EXT-1/2 — Registry gating (dev-plan P5.1): factory shape
// validation, kind uniqueness, semver enforcement and SDK-major compatibility.
// The module-level registry is shared within this file (vitest isolates module
// state per test file), so third-party-style registrations accumulate here.
import { describe, expect, it } from 'vitest';
import {
  PERIPHERAL_SDK_VERSION,
  getFactory,
  isSemver,
  listPeripherals,
  registerBuiltins,
  registerPeripheral,
  semverMajor,
  validatePeripheralFactory,
  type Peripheral,
  type PeripheralFactory,
} from '../src/index';

/** Minimal valid third-party factory (the docs/peripheral-sdk.md §1 shape). */
function myLedFactory(overrides: Record<string, unknown> = {}): PeripheralFactory {
  return {
    kind: 'my-led',
    version: '1.0.0',
    displayName: 'My LED',
    pins: [
      { id: 'A', role: 'gpio-out' },
      { id: 'K', role: 'gnd', optional: true },
    ],
    create(ctx, props): Peripheral {
      return {
        kind: 'my-led',
        instanceId: String(props?.instanceId ?? 'x'),
        onTransaction(): void {},
      };
    },
    ...overrides,
    // Boundary cast: `overrides` deliberately produces invalid shapes so the
    // validator can be driven through every rejection path (dev-plan §4.3).
  } as PeripheralFactory;
}

describe('registry — built-in set (PRD §F-EXT-2 stable surface)', () => {
  it('registers every built-in factory and is idempotent', () => {
    registerBuiltins();
    const before = listPeripherals().map((f) => f.kind);
    registerBuiltins(); // second call must be a no-op, not a [BB-221] storm
    expect(listPeripherals().map((f) => f.kind)).toEqual(before);
    expect(before).toEqual([
      'led', 'button', 'ssd1306', 'st7789', 'buzzer', 'speaker', 'oscilloscope', 'mic', 'knob', 'sht30',
    ]);
  });

  it('passes its own validation for every built-in factory', () => {
    for (const f of listPeripherals()) {
      expect(validatePeripheralFactory(f), `factory ${f.kind}`).toEqual([]);
    }
  });
});

describe('registry — third-party registration (PRD §F-EXT-1)', () => {
  it('registers a valid third-party factory and resolves it by kind', () => {
    registerPeripheral(myLedFactory());
    expect(getFactory('my-led')?.displayName).toBe('My LED');
    expect(listPeripherals().map((f) => f.kind)).toContain('my-led');
  });

  it('rejects a duplicate kind with [BB-221]', () => {
    expect(() => registerPeripheral(myLedFactory())).toThrow(
      "[BB-221] peripheral kind 'my-led' is already registered",
    );
    // A duplicate attempt must not replace the registered factory.
    expect(getFactory('my-led')?.displayName).toBe('My LED');
  });

  it('returns a fresh array from listPeripherals (callers cannot mutate the registry)', () => {
    const a = listPeripherals();
    a.length = 0;
    expect(listPeripherals().length).toBeGreaterThan(0);
  });
});

describe('validatePeripheralFactory — shape matrix ([BB-220] inputs)', () => {
  it('accepts a minimal valid factory', () => {
    expect(validatePeripheralFactory(myLedFactory({ kind: 'other' }))).toEqual([]);
  });

  it('rejects non-objects and factories without create()', () => {
    expect(validatePeripheralFactory(null)).toEqual(['factory must be an object']);
    expect(validatePeripheralFactory([])).toEqual(['factory must be an object']);
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x1', create: undefined }))).toContain('create must be a function');
  });

  it('rejects malformed kinds', () => {
    for (const kind of ['', 'LED', 'My-Led', '-led', 'led-', 'my--led', 'my_led', 'my led', 42]) {
      expect(validatePeripheralFactory(myLedFactory({ kind })), `kind=${String(kind)}`).not.toEqual([]);
    }
    for (const kind of ['led', 'ssd1306', 'my-led', 'a', 'x9-pro']) {
      expect(validatePeripheralFactory(myLedFactory({ kind })), `kind=${kind}`).toEqual([]);
    }
  });

  it('rejects non-semver versions', () => {
    for (const version of ['', '1.0', 'v1.2.3', '1.2.3.4', 'latest', 1]) {
      expect(validatePeripheralFactory(myLedFactory({ kind: 'x2', version })), `version=${String(version)}`).not.toEqual([]);
    }
    // Prerelease/build metadata is valid semver and must pass (dev-plan P5.1).
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x2', version: '0.0.0-test' }))).toEqual([]);
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x2', version: '1.2.3-rc.1+build.5' }))).toEqual([]);
  });

  it('rejects an empty displayName', () => {
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x3', displayName: '' }))).toContain('displayName must be a non-empty string');
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x3', displayName: '   ' }))).toContain('displayName must be a non-empty string');
  });

  it('rejects malformed pin tables', () => {
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x4', pins: undefined }))).toContain('pins must be an array');
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x4', pins: [null] }))).toContain('pins entries must be objects');
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x4', pins: [{ id: '', role: 'gpio-out' }] })))
      .toContain('pin id must be a non-empty string');
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x4', pins: [{ id: 'A', role: 'usb' }] }))[0])
      .toMatch(/unknown role 'usb'/);
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x4', pins: [{ id: 'A', role: 'gpio-out' }, { id: 'A', role: 'gnd' }] })))
      .toContain("duplicate pin id 'A'");
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x4', pins: [{ id: 'A', role: 'gpio-out', optional: 1 }] })))
      .toContain("pin 'A' optional flag must be a boolean");
  });

  it('rejects a non-object defaults table', () => {
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x5', defaults: [1] }))).toContain('defaults must be a plain object');
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x5', defaults: { address: 0x3c } }))).toEqual([]);
  });

  it('rejects a non-semver sdkVersion', () => {
    expect(validatePeripheralFactory(myLedFactory({ kind: 'x6', sdkVersion: '1' }))).not.toEqual([]);
  });
});

describe('registry — coded rejection and SDK versioning (PRD §6.2, P5.1)', () => {
  it('rejects malformed factories with [BB-220] and every issue listed', () => {
    expect(() => registerPeripheral(myLedFactory({ kind: 'Bad Kind', version: '1' }))).toThrow(
      /\[BB-220\] invalid peripheral factory 'Bad Kind': .*kind.*; .*version/,
    );
  });

  it('accepts factories built against the current or an older SDK major', () => {
    expect(() => registerPeripheral(myLedFactory({ kind: 'sdk-cur', sdkVersion: PERIPHERAL_SDK_VERSION }))).not.toThrow();
    expect(() => registerPeripheral(myLedFactory({ kind: 'sdk-old', sdkVersion: '0.1.0' }))).not.toThrow();
  });

  it('rejects factories built against a newer SDK major with [BB-222]', () => {
    const nextMajor = `${semverMajor(PERIPHERAL_SDK_VERSION) + 1}.0.0`;
    expect(() => registerPeripheral(myLedFactory({ kind: 'sdk-new', sdkVersion: nextMajor }))).toThrow(
      new RegExp(`\\[BB-222\\] peripheral 'sdk-new' requires SDK ${nextMajor.replace('.', '\\.')} .* SDK ${PERIPHERAL_SDK_VERSION.replace('.', '\\.')}`),
    );
    // The rejected factory must not linger in the registry.
    expect(getFactory('sdk-new')).toBeUndefined();
  });

  it('accepts factories without sdkVersion (pre-P5.1 packages stay compatible)', () => {
    const f = myLedFactory({ kind: 'sdk-none' });
    delete f.sdkVersion;
    expect(() => registerPeripheral(f)).not.toThrow();
    expect(getFactory('sdk-none')).toBe(f);
  });
});

describe('semver helpers', () => {
  it('recognizes well-formed versions and extracts the major', () => {
    expect(isSemver('1.0.0')).toBe(true);
    expect(isSemver('0.0.0-test')).toBe(true);
    expect(isSemver('10.20.30-rc.1+meta')).toBe(true);
    expect(isSemver('01.2.3')).toBe(false); // leading zero is not semver
    expect(isSemver('1.2')).toBe(false);
    expect(semverMajor('10.20.30')).toBe(10);
    expect(semverMajor('junk')).toBe(-1);
  });

  it('exposes the host SDK contract version as a semver', () => {
    expect(isSemver(PERIPHERAL_SDK_VERSION)).toBe(true);
    expect(semverMajor(PERIPHERAL_SDK_VERSION)).toBeGreaterThanOrEqual(1);
  });
});
