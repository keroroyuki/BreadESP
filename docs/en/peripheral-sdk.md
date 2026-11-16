# BreadESP Peripheral SDK Development Guide

> Complements PRD §6.2, §F-EXT. Third-party peripherals are registered as standalone packages.

## 1. Minimal Peripheral Example

```ts
// my-led/index.ts
import { PERIPHERAL_SDK_VERSION } from '@breadesp/peripherals';
import type { PeripheralFactory, Peripheral, PeripheralContext, BusTransaction, RenderSnapshot } from '@breadesp/peripherals';

class MyLed implements Peripheral {
  readonly kind = 'my-led';
  readonly instanceId: string;
  private ctx: PeripheralContext;
  private level = 0;
  constructor(id: string, ctx: PeripheralContext) { this.instanceId = id; this.ctx = ctx; }
  onTransaction(tx: BusTransaction) {
    if (tx.kind !== 'gpio' || tx.dir !== 'write') return;
    this.level = tx.data[0] ? 1 : 0;
    const snap: RenderSnapshot = { instanceId: this.instanceId, type: 'level', payload: { level: this.level } };
    this.ctx.emitSnapshot(snap);
  }
}

export const myLedFactory: PeripheralFactory = {
  kind: 'my-led', version: '1.0.0', displayName: 'My LED',
  sdkVersion: PERIPHERAL_SDK_VERSION, // 声明构建时针对的 SDK 契约版本（§6）
  pins: [{ id: 'A', role: 'gpio-out' }, { id: 'K', role: 'gnd', optional: true }],
  create(ctx, props) { return new MyLed(String(props?.instanceId ?? crypto.randomUUID()), ctx); },
};
```

## 2. Registration

Call this in your package entry point:

```ts
import { registerPeripheral } from '@breadesp/peripherals';
import { myLedFactory } from 'my-led';
registerPeripheral(myLedFactory);
```

**Both processes must register** (explicit since P5.1): the registry is a process-local module-level singleton — registering on the Bridge (Electron main process) side lets `PeripheralManager` instantiate models and route transactions; registering on the UI (renderer process) side lets the palette and the canvas see the part (palette entries, pin dots, and wiring interactions are all driven by factory metadata). `registerBuiltins()` is idempotent and may be called repeatedly from any entry point.

Enforced validation at registration (PRD §6.2, coded errors):

- `[BB-220]` invalid factory shape: kind must be lowercase kebab-case (`/^[a-z0-9]+(-[a-z0-9]+)*$/`),
  `version`/`sdkVersion` must be semver, `displayName` must be non-empty, ids in `pins` must be unique
  and roles must belong to the §6.1 PinRole set, `defaults` must be a plain object, and `create` must be
  a function. The error message lists every offending item. The exported `validatePeripheralFactory(factory)`
  can be used to pre-check in your own tests (it returns an array of issues; an empty array means pass).
- `[BB-221]` kind conflict: the later registrant gets an error; the earlier registrant is not replaced.
- `[BB-222]` incompatible SDK version: rejected when the major of `sdkVersion` is higher than the major of
  the host's `PERIPHERAL_SDK_VERSION` (the host cannot guarantee an unknown contract surface); the error
  message suggests upgrading BreadESP.

When a netlist on the Bridge side references an unregistered kind, `bb:applyNetlist` rejects it with
`[BB-206]` (including kind and instanceId), and existing instances and routing stay as they were (the
atomic-replacement semantics are unchanged).

> For how packages are distributed and loaded, see §8: dropping it into the local peripheral directory
> (`~/.breadesp/peripherals/`) is enough for the "Peripheral catalog" panel to discover and load it; in
> that scenario the entry point instead default-exports a function that receives the host API (§8.2),
> rather than importing and registering by itself.

## 3. Pin Roles and Transaction Routing (PRD §6.1, §4.2)

Peripherals declare the pin types they need via `pins[].role`. The `NetlistResolver` MVP routing rules:

- **I2C**: routed by 7-bit address — the instance's `props.address`, falling back to `factory.defaults.address`
  when absent (e.g. ssd1306 defaults to `0x3c`). The ESP32 GPIO matrix means MCU pins cannot identify an
  I2C controller, so the `bus` field does not participate in matching for now.
- **SPI**: routed by CS line (since P2.1) — the QEMU device frames `tx.target` as the controller hardware CS
  line index (0–2), and instances claim it via `props.cs` (falling back to `factory.defaults.cs` when absent,
  e.g. st7789 defaults to `0`). Only instances whose factory pin table declares the `spi-cs` role take part
  in SPI matching (this prevents non-SPI peripherals that carry a numeric prop from matching by mistake).
  As with I2C, the `bus` field does not participate in matching.
- **GPIO**: routed by MCU pin — a wire in the netlist with one endpoint at `{ instanceId: 'mcu', pin: 'GPIO<n>' }`
  delivers a transaction with `target = n` to the peripheral at the other end; multiple peripherals may hang
  on the same pin (all of them receive it). SPI peripherals' control lines (DC/RST/BL) also go through here:
  wire the instance's `DC` pin to `mcu.GPIO<n>` and declare the same number in `props.dc`; the model then
  samples the GPIO level as command/data select.
- **PWM**: per-pin routing identical to GPIO (since P2.3). The LEDC/GPIO matrix shadow registers of the QEMU
  device decode timer/channel configuration into per-pin `pwm` transactions — `target` is the GPIO number,
  `data` is 6 bytes: `[frequency 0.01Hz u32 LE][duty ‰ u16 LE]` (0Hz/0‰ = silent), consumed by models such
  as the buzzer; for bit-bang firmware that toggles GPIO by hand, the model side falls back to edge measurement.
- **I2S**: claimed by controller number (since P2.4) — the I2S shadow registers of the QEMU device listen
  directly to the TX DMA engine: they decode the clock configuration (sample rate/bit width/channel count),
  walk the DMA linked-list descriptors at the PCM byte rate, and emit one `i2s` transaction every 10ms tick —
  `bus` is the controller number (0/1), `data` is an 8-byte header
  `[sample rate u32 LE][bit width u8][channel count u8][flags u8][reserved u8]` + raw interleaved little-endian PCM.
  Instances claim it via `props.bus` (falling back to `factory.defaults.bus`, e.g. speaker defaults to `0`),
  and only instances whose factory pin table declares the `i2s-data-in` role take part in matching (the same
  role filtering as SPI). DIN/WS/BCK wiring is used only for UI drawing: PCM is forwarded before the GPIO
  matrix, so the transaction layer has no pin identity.
- **ADC**: not routed for now (pending the corresponding peripheral model landing in P3).

> TODO(PRD §6.1): wiring validity validation based on `pins[].role` (e.g. i2c-sda must not connect to
> gpio-out) will be filled in in a later milestone.

> UI-side reuse: the breadboard canvas (`packages/ui`) reads `factory.pins` directly to render pin dots and
> drive pin→pin wiring interactions (the renderer process imports this package's registry), so the
> id/role/optional of `pins` determines both canvas wiring interactions and Bridge-side routing semantics.

## 4. Render Snapshots (PRD §6.4)

- `pixels`: framebuffer (mono/rgb565/argb8888); the UI decodes it to Canvas according to format.
- `level`: 0..1 brightness, used for LED visuals.
- `tone`: `{freqHz, duty}` tone description (added in P2.3, buzzer); the UI synthesizes a square wave with
  WebAudio, with duty also serving as visual brightness; `freqHz>0 and duty>0` means sounding.
- `audio`: PCM samples + sample rate, played by the UI with WebAudio.
- `waveform`: for the oscilloscope.
- `text`: text panel.

**Throttling convention**: `ctx.emitSnapshot` is throttled by `PeripheralManager` to a 30fps cap per
`(instanceId, type)` (the first frame in a quiet period is emitted immediately, snapshots within the window
are coalesced last-write-wins, and a trailing flush occurs). Peripheral models only need to emit normally on
each state change; no debouncing is needed on their side, and the UI always converges to the latest state
eventually.

## 5. Lifecycle and `dispose()`

`Peripheral.dispose?()` is an optional method, called at the following moments:

- Netlist re-application (`applyNetlist`) — all old instances are disposed first and then replaced;
- `PeripheralManager.dispose()` — full teardown.

Implement `dispose()` to release resources such as timers and event subscriptions; if it is not implemented,
there are no side effects.
Note: `applyNetlist` is atomic; if any instance in the new netlist fails to be created, the old instances and
routing stay as they were.

## 6. Versioning and Compatibility (P5.1 stabilization)

- `kind` is globally unique; on conflict the later registrant gets error `[BB-221]`, and the earlier registrant
  is not replaced.
- `version` uses semantic versioning (enforced at registration; invalid semver is rejected with `[BB-220]`);
  breaking changes MUST bump the major.
- Adding optional `props` is backward compatible and needs no version bump.
- The host SDK contract version is exported by `@breadesp/peripherals` as `PERIPHERAL_SDK_VERSION` (currently `1.0.0`).
  Third-party factories SHOULD declare `sdkVersion` (the SDK version they are built against): major ≤ host
  major means compatible; a higher major is rejected at registration with `[BB-222]`. Packages that do not
  declare `sdkVersion` are treated as compatible (the pre-P5.1 behavior). The host only makes additive
  extensions to §6.1–6.4 (new PinRole members, new snapshot types, new optional methods); when a breaking
  change is unavoidable, bump the major of `PERIPHERAL_SDK_VERSION` and record it at the top of the PRD.

## 7. Automatic UI Presentation (P5.1)

Once a third-party peripheral is registered, **no UI code at all** is needed to get:

- **Palette entry**: the palette is registry-driven (`displayName` + `version` badge); new kinds appear
  automatically and can be dragged and dropped.
- **Canvas node**: pin dots and pin→pin wiring interactions are driven by `factory.pins` (§3); kinds without a
  bespoke renderer show a generic node body — a neutral indicator lamp + one line of status text, derived from
  the latest snapshot (`level`→brightness percentage, `tone`→frequency, `text`→truncated text, `pixels`→geometry
  annotation, `audio`→sample rate, `waveform`→channel count).
- **ScreenView**: `pixels` snapshots automatically open a canvas render per instanceId (mono/rgb565).

Known limitations (later milestones): the sound engines for `tone`/`audio` snapshots currently match built-in
kinds (buzzer/speaker), so third-party audio peripherals do not sound automatically; the oscilloscope panel
likewise only consumes waveforms from the built-in oscilloscope.

## 8. Local Peripheral Directory and Offline Marketplace (P5.2, PRD §F-EXT-3)

Third-party packages can be placed directly into a local directory, without npm publishing, to be discovered
and loaded by BreadESP:

```
~/.breadesp/peripherals/           # 可用 BREADESP_PERIPHERALS_DIR 覆盖
└── acme-matrix/                   # 每个子目录 = 一个外设包
    ├── breadesp-peripheral.json   # 清单（必需）
    └── index.mjs                  # 入口模块
```

### 8.1 Manifest Format (`breadesp-peripheral.json`, `manifestVersion: 1`)

```json
{
  "manifestVersion": 1,
  "name": "acme-matrix",
  "version": "0.3.1",
  "displayName": "Acme LED Matrix",
  "description": "8x8 LED matrix driver",
  "entry": "index.mjs",
  "sdkVersion": "1.0.0",
  "provides": ["acme-matrix"]
}
```

- `name`: lowercase kebab-case, optionally with an `@scope/` prefix; `version`: the package's own semver.
- `entry`: the **relative path** of the entry module, which must resolve inside the package directory (absolute
  paths and `..` escapes are rejected). Loose packages without `package.json` use the `.mjs` (ESM) or `.cjs`
  (CJS, via default-export interop) extension; a bare `.js` is interpreted by Node as CommonJS.
- `sdkVersion`: major gating pre-checked during scanning — packages higher than the host's `PERIPHERAL_SDK_VERSION`
  are marked `incompatible` and forbidden to load (the code-level `[BB-222]` gate still applies at load time).
- `provides`: the list of kinds claimed to be provided, for marketplace display only; the actual kinds are
  determined by the registration diff at load time.

### 8.2 Entry Module Contract (Host API Injection)

In the directory-loading scenario, a package **should not** `import '@breadesp/peripherals'` by itself (a loose
package cannot resolve the host's module instance, and registration would land in a different registry). The
entry SHOULD default-export a function that receives the host API:

```js
// index.mjs
export default function register(host) {
  host.registerPeripheral({
    kind: 'acme-matrix',
    version: '0.3.1',
    displayName: 'Acme LED Matrix',
    sdkVersion: host.PERIPHERAL_SDK_VERSION,
    pins: [{ id: 'DIN', role: 'spi-mosi' }, { id: 'CS', role: 'spi-cs' }, { id: 'CLK', role: 'spi-sck' }],
    create: (ctx, props) => new AcmeMatrix(String(props?.instanceId), ctx),
  });
}
```

`host` is `PeripheralHostApi`: the host's own `registerPeripheral` and `PERIPHERAL_SDK_VERSION`. The default
export may be async (the loader will await it). The model code is identical to §1 — only the registration entry
differs. Top-level side-effect registration in the module is also observed by the registry diff, but it only
takes effect when the module can resolve the host's same `@breadesp/peripherals` instance (for example,
development inside the monorepo); loose packages should not rely on it.

### 8.3 Load Semantics and Error Codes

- Scanning is read-only: a missing directory = an empty marketplace; a bad package degrades to an `invalid`
  entry with all issues listed, without affecting other packages.
- Loading is triggered by the user explicitly clicking in the "Peripheral catalog" panel; the target must be an
  entry with `status='ok'` in the current scan, otherwise `[BB-224]` (a rescan happens before loading, so this
  channel cannot be used to import arbitrary paths).
- Entry execution failure, a default export that is not a function, or finishing without registering any kind:
  `[BB-223]`, and any partial registrations already made are rolled back (no residue). Registration's own
  `[BB-220]`/`[BB-221]`/`[BB-222]` propagate as-is.
- Loading the same directory repeatedly is idempotent (double-click safe). After a failed load, fixing the files
  and retrying works directly (the entry URL carries an attempt sequence number to bypass the ESM module cache);
  **already successful** packages do not support hot updates — changes take effect after the application
  restarts, and the same applies to uninstalling.
- After a successful load, no UI code is needed: the Bridge returns `PeripheralMeta` metadata, the renderer
  process mirrors it as a metadata-only stub, and the palette and canvas are immediately visible (§7); the
  model's `create()` runs only in the Bridge process.

## 9. Packaging Scaffold (P5.3, PRD §F-EXT-4)

No need to build the package structure from scratch — the scaffold directly generates a **publishable**
peripheral package:

```bash
pnpm create-peripheral acme-matrix --description "8x8 LED matrix driver"
# 选项：--display-name <文本>  --description <文本>  --into <父目录>
```

`name` is lowercase kebab (optionally with an `@scope/` prefix); the part after removing the scope serves as
both the factory kind and the package directory name. `--into` defaults to the current working directory; point
it directly at the local peripheral directory root (`~/.breadesp/peripherals/` or `BREADESP_PERIPHERALS_DIR`) to
skip manual copying. The generated directory has exactly four files:

| File | Purpose |
|---|---|
| `breadesp-peripheral.json` | Manifest (§8.1; `sdkVersion` is automatically stamped with the host's current `PERIPHERAL_SDK_VERSION`) |
| `index.mjs` | Host API injection entry (§8.2) + a runnable GPIO level example model |
| `self-check.mjs` | Zero-dependency smoke test: `node self-check.mjs` (see §10) |
| `README.md` | Install/load/development guide |

The generated package has no privileged paths: it must pass all the gates in §8 (scan `ok` → explicit load →
registration gating), and the repository tests pin down this "generate and publish" chain. The scaffold's own
error codes:

- `[BB-230]` invalid request — name/displayName/description shape issues are listed all at once; a kind conflict
  with an already-registered kind is also rejected here (otherwise it would inevitably hit `[BB-221]` at load time).
- `[BB-231]` target directory already exists and is not empty — the scaffold never overwrites existing files (an
  existing empty directory is allowed to be written to); a mid-write failure cleans up the partially created files.

## 10. Testing Conventions

Every peripheral MUST have at least one unit test (see `packages/peripherals/tests/ssd1306.test.ts`) covering the
path "receive one typical transaction → produce the expected snapshot". Factories themselves SHOULD be
pre-checked with `validatePeripheralFactory()` (see §2). The scaffold-generated package (§9) carries the
zero-dependency form of this convention in `self-check.mjs` — it drives the example model through the level
behavior; when you change the model, extend the checks in it accordingly.
