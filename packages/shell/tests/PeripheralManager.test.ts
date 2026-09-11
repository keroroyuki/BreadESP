// PRD: §4.2 — PeripheralManager routing integration (dev-plan §7.2): applyNetlist
// builds instances, route() delivers transactions through NetlistResolver only to
// the wired/matching peripheral. Uses the real builtin factories; routing outcome
// is observed via the 'snapshot' events each model emits. Also covers the P1.5
// snapshot throttle (30fps cap per instanceId+type, PRD §9) and routing
// robustness (error isolation, atomic netlist apply, teardown).
import { describe, expect, it, vi } from 'vitest';
import type { Netlist } from '@breadesp/netlist';
import type { BusTransaction, I2sInjection, PeripheralInjection, RenderSnapshot } from '@breadesp/peripherals';
import { registerBuiltins, registerPeripheral } from '@breadesp/peripherals';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';

registerBuiltins();

const LED_ON_GPIO2: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    { instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } },
    { instanceId: 'led1', kind: 'led' },
  ],
  wires: [
    { id: 'w-sda', from: { instanceId: 'oled1', pin: 'SDA' }, to: { instanceId: 'mcu', pin: 'GPIO21' } },
    { id: 'w-led', from: { instanceId: 'led1', pin: 'A' }, to: { instanceId: 'mcu', pin: 'GPIO2' } },
  ],
};

const LED_ON_GPIO2_AND_GPIO3: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    { instanceId: 'led1', kind: 'led' },
    { instanceId: 'led2', kind: 'led' },
  ],
  wires: [
    { id: 'w-led1', from: { instanceId: 'led1', pin: 'A' }, to: { instanceId: 'mcu', pin: 'GPIO2' } },
    { id: 'w-led2', from: { instanceId: 'led2', pin: 'A' }, to: { instanceId: 'mcu', pin: 'GPIO3' } },
  ],
};

// Test probe peripheral: optionally throws on every transaction; records disposals.
const probeDisposals: string[] = [];
const PROBE_NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    { instanceId: 'probe1', kind: 'probe', props: { throwOnTx: true } },
    { instanceId: 'led1', kind: 'led' },
  ],
  wires: [
    { id: 'w-probe', from: { instanceId: 'probe1', pin: 'A' }, to: { instanceId: 'mcu', pin: 'GPIO2' } },
    { id: 'w-led', from: { instanceId: 'led1', pin: 'A' }, to: { instanceId: 'mcu', pin: 'GPIO2' } },
  ],
};

const TWO_PROBES: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    { instanceId: 'probe1', kind: 'probe' },
    { instanceId: 'probe2', kind: 'probe' },
  ],
  wires: [],
};

function i2cWrite(): BusTransaction {
  // SSD1306-style frame: control byte 0x00 (command stream) + display-off 0xAE.
  return { kind: 'i2c', bus: 0, target: 0x3c, dir: 'write', data: Uint8Array.from([0x00, 0xae]), ts: 5 };
}

function gpioWrite(pin: number, level: 0 | 1): BusTransaction {
  return { kind: 'gpio', bus: 0, target: pin, dir: 'write', data: Uint8Array.from([level]), ts: 6 };
}

const SPEAKER_ON_I2S0: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [{ instanceId: 'spk1', kind: 'speaker' }],
  wires: [],
};

/** P2.4 device wire frame: 8-byte header + `frames` stereo s16le frames of zeros. */
function i2sWrite(frames: number): BusTransaction {
  const rate = 16000;
  const data = new Uint8Array(8 + frames * 4);
  data.set([rate & 0xff, (rate >> 8) & 0xff, 0, 0, 16, 2, 0, 0], 0);
  return { kind: 'i2s', bus: 0, dir: 'write', data, ts: 7 };
}

function managerWith(netlist: Netlist, now: () => number = Date.now): { manager: PeripheralManager; snapshots: RenderSnapshot[] } {
  const manager = new PeripheralManager(now);
  const snapshots: RenderSnapshot[] = [];
  manager.on('snapshot', (s: RenderSnapshot) => snapshots.push(s));
  manager.applyNetlist(netlist);
  return { manager, snapshots };
}

/**
 * Manager driven by an injected synthetic clock, paired with faked timers so
 * the trailing flushes fire deterministically (vi.useFakeTimers() required).
 * `emissionTimes[i]` is the synthetic-clock time at which snapshots[i] fired.
 */
function clockedManager(netlist: Netlist): {
  manager: PeripheralManager;
  snapshots: RenderSnapshot[];
  emissionTimes: number[];
  advance: (ms: number) => Promise<void>;
} {
  let t = 0;
  const manager = new PeripheralManager(() => t);
  const snapshots: RenderSnapshot[] = [];
  const emissionTimes: number[] = [];
  manager.on('snapshot', (s: RenderSnapshot) => {
    snapshots.push(s);
    emissionTimes.push(t);
  });
  manager.applyNetlist(netlist);
  const advance = async (ms: number): Promise<void> => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { manager, snapshots, emissionTimes, advance };
}

function isLevel(s: RenderSnapshot, level: number): boolean {
  return s.type === 'level' && 'level' in s.payload && s.payload.level === level;
}

describe('PeripheralManager routing (PRD §4.2, dev-plan P1.4)', () => {
  it('delivers an I2C write to oled1 only (OLED transactions land on oled1)', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2);
    manager.route(i2cWrite());

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ instanceId: 'oled1', type: 'pixels' });
    expect(snapshots[0].payload).toMatchObject({ width: 128, height: 64, format: 'mono' });
  });

  it('delivers a GPIO write only to the peripheral wired to that pin', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2);
    manager.route(gpioWrite(2, 1));
    manager.route(gpioWrite(3, 1)); // unwired pin: no recipient

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ instanceId: 'led1', type: 'level' });
    expect(isLevel(snapshots[0], 1)).toBe(true);
  });

  it('keeps I2C traffic away from the LED and GPIO traffic away from the OLED', async () => {
    // The LED's second level snapshot is coalesced by the 30fps window and
    // arrives via the trailing flush (dev-plan task P1.5).
    vi.useFakeTimers();
    try {
      const { manager, snapshots, advance } = clockedManager(LED_ON_GPIO2);
      manager.route(i2cWrite());
      manager.route(gpioWrite(2, 1));
      manager.route(gpioWrite(2, 0)); // within the window: deferred, not dropped

      expect(snapshots.filter((s) => s.instanceId === 'led1')).toHaveLength(1);

      await advance(50);
      const led = snapshots.filter((s) => s.instanceId === 'led1');
      const oled = snapshots.filter((s) => s.instanceId === 'oled1');
      expect(led.map((s) => s.type)).toEqual(['level', 'level']);
      expect(isLevel(led[1], 0)).toBe(true); // the newest level survives coalescing
      expect(oled.map((s) => s.type)).toEqual(['pixels']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('attributes a gpio transaction to the wired channel pin of an oscilloscope (P2.5 viaPin)', async () => {
    // Two channels of one scope on two GPIOs: the manager must pass the
    // resolved via-pin so the model can attribute the edge to its channel.
    const SCOPE_TWO_CHANNELS: Netlist = {
      version: 1,
      chip: 'esp32',
      peripherals: [{ instanceId: 'scope1', kind: 'oscilloscope' }],
      wires: [
        { id: 'w-ch1', from: { instanceId: 'scope1', pin: 'CH1' }, to: { instanceId: 'mcu', pin: 'GPIO2' } },
        { id: 'w-ch3', from: { instanceId: 'scope1', pin: 'CH3' }, to: { instanceId: 'mcu', pin: 'GPIO4' } },
      ],
    };
    vi.useFakeTimers();
    let snapshots: RenderSnapshot[] = [];
    try {
      const clocked = clockedManager(SCOPE_TWO_CHANNELS);
      snapshots = clocked.snapshots;
      clocked.manager.route({ kind: 'gpio', bus: 0, target: 2, dir: 'write', data: Uint8Array.from([1]), ts: 10 });
      clocked.manager.route({ kind: 'gpio', bus: 0, target: 4, dir: 'write', data: Uint8Array.from([1]), ts: 20 });
      // The second waveform lands inside the 30fps window: trailing flush.
      await clocked.advance(50);
    } finally {
      vi.useRealTimers();
    }

    expect(snapshots).toHaveLength(2);
    const wf = snapshots[1].payload as { channels: { label: string; edges: { t: number; level: number }[] }[] };
    expect(snapshots[1]).toMatchObject({ instanceId: 'scope1', type: 'waveform' });
    expect(wf.channels.map((c) => c.label)).toEqual(['CH1', 'CH3']);
  });

  it('drops all routing when the netlist is re-applied without wires', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2);
    manager.route(gpioWrite(2, 1));
    expect(snapshots).toHaveLength(1);

    manager.applyNetlist({ version: 1, chip: 'esp32', peripherals: LED_ON_GPIO2.peripherals, wires: [] });
    manager.route(gpioWrite(2, 0));
    manager.route(i2cWrite());
    // GPIO lost its wire; the OLED keeps routing by address (wire matrix cannot
    // bind an MCU pin to an I2C controller, PRD §6.5).
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({ instanceId: 'oled1', type: 'pixels' });
  });

  it('throws on an unknown peripheral kind', () => {
    const manager = new PeripheralManager();
    expect(() =>
      manager.applyNetlist({ version: 1, chip: 'esp32', peripherals: [{ instanceId: 'x1', kind: 'nope' }], wires: [] }),
    ).toThrow('Unknown peripheral kind: nope');
  });

  it('routing before any netlist is applied is a no-op', () => {
    const manager = new PeripheralManager();
    expect(() => manager.route(i2cWrite())).not.toThrow();
  });
});

describe('snapshot throttling (dev-plan task P1.5: 30fps cap, PRD §9)', () => {
  it('passes the first snapshot through immediately (leading edge, no timer)', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2);
    manager.route(gpioWrite(2, 1));
    expect(snapshots).toHaveLength(1);
    expect(isLevel(snapshots[0], 1)).toBe(true);
  });

  it('coalesces a same-tick burst into one immediate + one trailing snapshot', async () => {
    vi.useFakeTimers();
    try {
      const { manager, snapshots, advance } = clockedManager(LED_ON_GPIO2);
      for (let i = 0; i < 50; i++) manager.route(i2cWrite()); // 50 OLED flushes in one burst

      expect(snapshots).toHaveLength(1); // the whole burst collapsed into the leading frame
      await advance(50);
      expect(snapshots).toHaveLength(2); // exactly one trailing flush carrying the newest state
      await advance(100);
      expect(snapshots).toHaveLength(2); // burst ended: nothing further is emitted
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps a sustained 1ms stream at <=30fps and always delivers the latest state', async () => {
    vi.useFakeTimers();
    try {
      const { manager, snapshots, emissionTimes, advance } = clockedManager(LED_ON_GPIO2);
      for (let i = 1; i <= 100; i++) {
        manager.route(gpioWrite(2, i % 2 === 1 ? 1 : 0)); // toggle every virtual ms
        await advance(1);
      }
      await advance(50); // let the final trailing flush land
      const ledIdx = snapshots.map((s, i) => (s.instanceId === 'led1' ? i : -1)).filter((i) => i >= 0);
      const led = ledIdx.map((i) => snapshots[i]);

      // 100 fed snapshots: only a handful surface (30fps), never the raw 100.
      expect(led.length).toBeGreaterThanOrEqual(3);
      expect(led.length).toBeLessThanOrEqual(5); // ~150ms of synthetic time at 30fps
      // Rate cap: consecutive emissions stay one window apart (fake timers round
      // fractional delays, hence the 1ms slack).
      const ledTimes = ledIdx.map((i) => emissionTimes[i]);
      for (let i = 1; i < ledTimes.length; i++) {
        expect(ledTimes[i] - ledTimes[i - 1]).toBeGreaterThanOrEqual(1000 / 30 - 1);
      }
      expect(isLevel(led[led.length - 1], 0)).toBe(true); // feed #100 ended on level 0
    } finally {
      vi.useRealTimers();
    }
  });

  it('bypasses the throttle for audio snapshots (P2.4: a PCM stream must not coalesce)', () => {
    const { manager, snapshots } = managerWith(SPEAKER_ON_I2S0);
    for (let i = 0; i < 10; i++) manager.route(i2sWrite(600));
    // 10 transactions x 600 samples: two 512+ chunks per... — every emitted
    // chunk survives (no last-write-wins dropping).
    expect(snapshots.length).toBeGreaterThanOrEqual(10);
    expect(snapshots.every((s) => s.type === 'audio' && s.instanceId === 'spk1')).toBe(true);
  });

  it('keeps an independent budget per instanceId', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2_AND_GPIO3);
    manager.route(gpioWrite(2, 1));
    manager.route(gpioWrite(3, 1)); // another instance: another leading edge
    expect(snapshots).toHaveLength(2);
    expect(new Set(snapshots.map((s) => s.instanceId))).toEqual(new Set(['led1', 'led2']));
  });

  it('re-applying the netlist cancels pending trailing snapshots', async () => {
    vi.useFakeTimers();
    try {
      const { manager, snapshots, advance } = clockedManager(LED_ON_GPIO2);
      manager.route(gpioWrite(2, 1)); // leading
      manager.route(gpioWrite(2, 0)); // pending, timer armed
      manager.applyNetlist({ version: 1, chip: 'esp32', peripherals: LED_ON_GPIO2.peripherals, wires: [] });

      await advance(100);
      expect(snapshots).toHaveLength(1); // no trailing flush for the disposed instance
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('routing robustness (dev-plan task P1.5)', () => {
  it('isolates a throwing peripheral: other targets still receive the transaction, error is logged with context', () => {
    const { manager, snapshots } = managerWith(PROBE_NETLIST);
    const logs: Array<{ level: string; msg: string }> = [];
    manager.on('log', (l: { level: string; msg: string }) => logs.push(l));

    manager.route(gpioWrite(2, 1));

    expect(snapshots).toHaveLength(1); // led1 (wired to the same pin) still got it
    expect(isLevel(snapshots[0], 1)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('error');
    expect(logs[0].msg).toContain('probe1');
    expect(logs[0].msg).toContain('gpio');
  });

  it('rejects a netlist with duplicate instanceIds and keeps the previous routing', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2);
    expect(() =>
      manager.applyNetlist({
        version: 1,
        chip: 'esp32',
        peripherals: [
          { instanceId: 'led1', kind: 'led' },
          { instanceId: 'led1', kind: 'led' },
        ],
        wires: LED_ON_GPIO2.wires,
      }),
    ).toThrow(/\[BB-200\].*'led1'/);

    manager.route(gpioWrite(2, 1)); // old instances and routing are intact
    expect(snapshots).toHaveLength(1);
    expect(isLevel(snapshots[0], 1)).toBe(true);
  });

  it('dispose() disposes every instance, cancels pending flushes and stops routing', async () => {
    vi.useFakeTimers();
    try {
      const { manager, snapshots, advance } = clockedManager(LED_ON_GPIO2);
      manager.route(gpioWrite(2, 1)); // leading
      manager.route(gpioWrite(2, 0)); // pending, timer armed

      manager.dispose();
      await advance(100);
      expect(snapshots).toHaveLength(1); // the armed trailing flush was cancelled

      manager.route(gpioWrite(2, 1)); // routing is gone
      expect(snapshots).toHaveLength(1);
      expect(manager.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applyNetlist disposes replaced instances exactly once', () => {
    probeDisposals.length = 0;
    const manager = new PeripheralManager();
    manager.applyNetlist(TWO_PROBES);
    manager.applyNetlist(TWO_PROBES); // re-apply replaces all instances
    expect(probeDisposals).toEqual(['probe1', 'probe2']);
    manager.dispose();
    expect(probeDisposals).toEqual(['probe1', 'probe2', 'probe1', 'probe2']);
  });
});

describe('input injection (dev-plan task P3.1, PRD §F-PER-7/§6.7)', () => {
  it('forwards mic ctx.emitInput injections as the inject event and stops on dispose', () => {
    vi.useFakeTimers();
    try {
      const manager = new PeripheralManager();
      const injections: I2sInjection[] = [];
      manager.on('inject', (inj: I2sInjection) => injections.push(inj));
      manager.applyNetlist({
        version: 1, chip: 'esp32',
        peripherals: [{ instanceId: 'mic1', kind: 'mic', props: { sampleRate: 8000, chunkMs: 10, freqHz: 440 } }],
        wires: [],
      });

      vi.advanceTimersByTime(35);
      expect(injections.length).toBe(3);
      expect(injections[0]).toMatchObject({ bus: 0, rate: 8000, bits: 16, channels: 1 });
      expect(injections[0].data.length).toBe(160); // 80 frames * 1ch * 2B

      manager.dispose(); // the mic's interval dies with the instance
      vi.advanceTimersByTime(50);
      expect(injections.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes feedCapture chunks to the mic acceptCapture sink (P3.2)', () => {
    vi.useFakeTimers();
    try {
      const manager = new PeripheralManager();
      const injections: I2sInjection[] = [];
      manager.on('inject', (inj: I2sInjection) => injections.push(inj));
      manager.applyNetlist({
        version: 1, chip: 'esp32',
        peripherals: [{ instanceId: 'mic1', kind: 'mic', props: { sampleRate: 16000, chunkMs: 20, waveform: 'silence' } }],
        wires: [],
      });

      manager.feedCapture('mic1', { rate: 16000, samples: new Array<number>(320).fill(0.5) });
      vi.advanceTimersByTime(20);
      // The capture chunk overrides the synth silence: 320 frames of 0.5.
      expect(injections.length).toBe(1);
      expect(injections[0].data.length).toBe(640);
      expect(injections[0].data.some((b) => b !== 0)).toBe(true);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops feedCapture for unknown instances and capture-less models (P3.2)', () => {
    const manager = new PeripheralManager();
    manager.applyNetlist({
      version: 1, chip: 'esp32',
      peripherals: [{ instanceId: 'led1', kind: 'led' }],
      wires: [],
    });
    const chunk = { rate: 16000, samples: [0.5] };
    // No acceptCapture on led, no 'mic9' instance: neither may throw.
    expect(() => manager.feedCapture('led1', chunk)).not.toThrow();
    expect(() => manager.feedCapture('mic9', chunk)).not.toThrow();
    manager.dispose();
  });
});

describe('GPIO input injection (dev-plan task P3.4, PRD §F-BB-3/§6.7)', () => {
  const KNOB_WIRED: Netlist = {
    version: 1, chip: 'esp32',
    peripherals: [{ instanceId: 'knob1', kind: 'knob', props: { stepMs: 5 } }],
    wires: [
      { id: 'w1', from: { instanceId: 'knob1', pin: 'A' }, to: { instanceId: 'mcu', pin: 'GPIO4' } },
      { id: 'w2', from: { instanceId: 'mcu', pin: 'GPIO16' }, to: { instanceId: 'knob1', pin: 'B' } },
    ],
  };

  it('routes driveRotate through the knob model as gpio-in injections on the wired pins', () => {
    vi.useFakeTimers();
    try {
      const manager = new PeripheralManager();
      const injections: PeripheralInjection[] = [];
      manager.on('inject', (inj: PeripheralInjection) => injections.push(inj));
      manager.applyNetlist(KNOB_WIRED);
      // The constructor re-syncs the rest state on the wired pins.
      expect(injections).toEqual([
        { kind: 'gpio-in', pin: 4, level: 0 },
        { kind: 'gpio-in', pin: 16, level: 0 },
      ]);
      injections.length = 0;

      manager.driveRotate('knob1', 1); // one CW detent = 4 transitions at 5ms
      vi.advanceTimersByTime(20);
      expect(injections).toEqual([
        { kind: 'gpio-in', pin: 4, level: 1 },
        { kind: 'gpio-in', pin: 16, level: 1 },
        { kind: 'gpio-in', pin: 4, level: 0 },
        { kind: 'gpio-in', pin: 16, level: 0 },
      ]);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('driveInput injects the level onto the GPIO wired to the pin (button path)', () => {
    const manager = new PeripheralManager();
    const injections: PeripheralInjection[] = [];
    manager.on('inject', (inj: PeripheralInjection) => injections.push(inj));
    manager.applyNetlist({
      version: 1, chip: 'esp32',
      peripherals: [{ instanceId: 'btn1', kind: 'button' }],
      wires: [{ id: 'w1', from: { instanceId: 'btn1', pin: '1' }, to: { instanceId: 'mcu', pin: 'GPIO2' } }],
    });
    manager.driveInput('btn1', '1', 1);
    manager.driveInput('btn1', '1', 0);
    expect(injections).toEqual([
      { kind: 'gpio-in', pin: 2, level: 1 },
      { kind: 'gpio-in', pin: 2, level: 0 },
    ]);
    manager.dispose();
  });

  it('warns once per unwired endpoint ([BB-205]) and drops the injection', () => {
    const manager = new PeripheralManager();
    const injections: PeripheralInjection[] = [];
    const logs: { level: string; msg: string }[] = [];
    manager.on('inject', (inj: PeripheralInjection) => injections.push(inj));
    manager.on('log', (l: { level: string; msg: string }) => logs.push(l));
    manager.applyNetlist({
      version: 1, chip: 'esp32',
      peripherals: [{ instanceId: 'btn1', kind: 'button' }],
      wires: [], // nothing wired
    });
    manager.driveInput('btn1', '1', 1);
    manager.driveInput('btn1', '1', 0);
    expect(injections).toHaveLength(0);
    expect(logs.filter((l) => l.level === 'warn' && l.msg.includes('[BB-205]'))).toHaveLength(1);
    manager.dispose();
  });

  it('driveRotate silently drops unknown instances and rotate-less models', () => {
    const manager = new PeripheralManager();
    manager.applyNetlist({
      version: 1, chip: 'esp32',
      peripherals: [{ instanceId: 'led1', kind: 'led' }],
      wires: [],
    });
    expect(() => manager.driveRotate('led1', 1)).not.toThrow();
    expect(() => manager.driveRotate('knob9', 1)).not.toThrow();
    manager.dispose();
  });

  it('stops a mid-flight rotation when the netlist is re-applied', () => {
    vi.useFakeTimers();
    try {
      const manager = new PeripheralManager();
      const injections: PeripheralInjection[] = [];
      manager.on('inject', (inj: PeripheralInjection) => injections.push(inj));
      manager.applyNetlist(KNOB_WIRED);
      injections.length = 0;
      manager.driveRotate('knob1', 4);
      vi.advanceTimersByTime(5); // one transition played
      const before = injections.length;
      manager.applyNetlist({ version: 1, chip: 'esp32', peripherals: [], wires: [] });
      vi.advanceTimersByTime(1000);
      expect(injections).toHaveLength(before); // the disposed knob's timer is dead
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Registered once for this file (vitest isolates module state per test file).
registerPeripheral({
  kind: 'probe',
  version: '0.0.0-test',
  displayName: 'Test probe',
  pins: [{ id: 'A', role: 'gpio-out' }],
  create(_ctx, props) {
    const instanceId = String(props?.instanceId);
    const throwOnTx = props?.throwOnTx === true;
    return {
      kind: 'probe',
      instanceId,
      onTransaction(): void {
        if (throwOnTx) throw new Error('probe exploded');
      },
      dispose(): void {
        probeDisposals.push(instanceId);
      },
    };
  },
});
