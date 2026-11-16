---
title: 05 · Authoring Peripherals
description: Generate a peripheral package with the scaffold, implement the model interface, and load it into BreadESP from a local directory.
---

# 05 · Authoring Peripherals

> Goal: use the scaffold to generate a publishable peripheral package, understand the model interface, and load it onto the breadboard.
> For the full contract see the [Peripheral SDK Guide](../peripheral-sdk.md) (this document is its step-by-step introduction).

## 1. Scaffold generation

```bash
pnpm create-peripheral acme-lamp --description "Demo level indicator"
# 选项：--display-name <文本>  --description <文本>  --into <父目录>
```

`--into` points to the root of the local peripheral directory (`~/.breadesp/peripherals/`, or the environment variable
`BREADESP_PERIPHERALS_DIR`) and skips manual copying. The generated directory contains exactly four files:

| File | Purpose |
|---|---|
| `breadesp-peripheral.json` | Manifest (`manifestVersion: 1`; `sdkVersion` is automatically stamped with the host's current contract version) |
| `index.mjs` | Entry: default-exports a registration function that receives the host API + a runnable GPIO level example model |
| `self-check.mjs` | Zero-dependency smoke check: `node self-check.mjs` independently verifies the package shape and model behavior |
| `README.md` | Installation/loading/development guide |

What is generated is compliant by construction: the manifest is fed back through the directory validator, and the name rules share the same regular expression as
directory scanning — the scaffold cannot generate a package that the market would reject.

## 2. The model interface in ten minutes

The model implements `Peripheral` (PRD §6.2):

```js
class AcmeLamp {
  // kind / instanceId 是只读标识
  constructor(id, ctx) { this.instanceId = id; this.ctx = ctx; this.level = 0; }
  onTransaction(tx) {
    if (tx.kind !== 'gpio' || tx.dir !== 'write') return;
    this.level = tx.data[0] ? 1 : 0;
    this.ctx.emitSnapshot({ instanceId: this.instanceId, type: 'level', payload: { level: this.level } });
  }
  dispose() {} // 可选：释放定时器/订阅
}
```

Key points:

- **The factory is the metadata**: `kind` (lowercase kebab), `version` (semver), `displayName`,
  `pins` (id + role, which drives both canvas pins and Bridge routing), `defaults` (props fallback values),
  `sdkVersion` (SHOULD be declared; registration is rejected if major is higher than the host `[BB-222]`).
- **Routing follows the role**: GPIO/PWM by wiring, I2C by `props.address`, SPI by `props.cs`,
  I2S by `props.bus` (see [Built-in Peripherals Reference · Routing quick reference](04-peripherals.md)).
- **Snapshots are rendering**: six kinds of snapshots — `pixels`/`level`/`tone`/`audio`/`waveform`/`text`
  (PRD §6.4); 30fps throttling is handled by the host, so the model just emits normally on every state change.
- **Active input** (optional): `ctx.emitInput` (I2S PCM / GPIO level / I2C read response),
  `driveInput`, `rotate`, `acceptCapture` — push buttons, the knob, sensors, and the microphone go through this path.

## 3. Loading from a local directory (offline market)

1. Put the package directory into `~/.breadesp/peripherals/` (or generate it there directly with `--into`).
2. Open the app and click Rescan in the **Peripheral catalog** panel on the left — the package appears with the `ready` state
   (a bad manifest/bad entry degrades to `invalid` and lists all problems; an SDK major that is too new is marked `incompatible`).
3. Click **Load**: the Bridge dynamically imports the entry module, and after successful registration the metadata is mirrored back to the renderer process —
   **the new part appears in the palette and on the canvas immediately, with no UI code at all**.
4. Drag it onto the canvas, wire it, and run firmware — transactions are routed to the model through exactly the same generic path as built-in peripherals.

Loading semantics: explicitly triggered (a directory outside the scan reports `[BB-224]`); an entry that registers no kind or fails to execute
reports `[BB-223]` and rolls back partial registrations; loading the same directory again is idempotent; after fixing files you can retry directly;
hot update/unload requires restarting the app.

## 4. Registration gating and error codes

| Error code | Meaning |
|---|---|
| `[BB-220]` | Invalid factory shape (kind/version/displayName/pins/defaults/create); all errors are listed at once |
| `[BB-221]` | The kind is already registered (the first registration is not replaced) |
| `[BB-222]` | `sdkVersion` major is higher than the host `PERIPHERAL_SDK_VERSION` |
| `[BB-223]` | Load failed (entry exception / default export is not a function / zero registrations); already rolled back |
| `[BB-224]` | The target is not an `ok` entry in the current scan |
| `[BB-230]` / `[BB-231]` | Invalid scaffold request / target directory is not empty (never overwrites) |

## 5. Testing conventions

Every peripheral has at least one unit test covering the "typical transaction → expected snapshot" path; factories are pre-checked with
`validatePeripheralFactory()`. The scaffold-generated `self-check.mjs` is the zero-dependency form of this convention —
extend it whenever you change the model.

## Next steps

- Full SDK contract (two-process registration, versioning, automatic UI presentation): [Peripheral SDK Guide](../peripheral-sdk.md).
- Single source of truth for interfaces: [PRD §6.1–6.4](../PRD.md).
