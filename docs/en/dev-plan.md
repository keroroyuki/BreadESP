# BreadESP Development Plan and Conventions

> This document is the **execution handbook** of the BreadESP project and is used together with [`PRD.md`](PRD.md) (the single source of truth for requirements).
> The PRD answers "what to build"; this document answers "how to build it, in what order, and under what conventions".
> Before starting any development task, an AI Agent MUST read both the corresponding PRD chapter and the corresponding phase in this document.

---

## Contents
1. [Overall Strategy](#1-overall-strategy)
2. [Milestones and Phase Breakdown](#2-milestones-and-phase-breakdown)
3. [Phase-by-Phase Development Steps](#3-phase-by-phase-development-steps)
4. [Code Style Conventions](#4-code-style-conventions)
5. [Git Commit Conventions](#5-git-commit-conventions)
6. [Branch and Release Process](#6-branch-and-release-process)
7. [Test Conventions](#7-test-conventions)
8. [Documentation Conventions](#8-documentation-conventions)
9. [AI Agent Collaboration Conventions](#9-ai-agent-collaboration-conventions)
10. [Caveats and Risks](#10-caveats-and-risks)
11. [Environment and Toolchain](#11-environment-and-toolchain)
12. [Acceptance Checklist](#12-acceptance-checklist)

---

## 1. Overall Strategy

### 1.1 Core Principles
- **PRD first**: the PRD prevails in any implementation conflict; to change a requirement, change the PRD first and then the code.
- **Vertical slices**: each phase delivers one minimal "end-to-end demonstrable" chain instead of slicing horizontally by layer.
- **Contract first**: interfaces (PRD §6) are frozen before implementation; "defining the interface while writing it" is forbidden.
- **Testable first**: every module ships with tests as soon as it lands; code without tests counts as unfinished.
- **Zero binaries in the repository**: QEMU/toolchains are always fetched on demand; the repository never contains binaries.

### 1.2 Engineering Cadence
- Three-level breakdown: "Phase → Milestone → Task".
- Each task corresponds to one independently committable PR/commit group.
- A regression validation is run at the end of each milestone (run the acceptance checklist in §12).

---

## 2. Milestones and Phase Breakdown

| Phase | Name | Goal | Estimate | Milestone flag |
|---|---|---|---|---|
| P0 | Technical validation | QEMU-ESP32 runs blink, GDB can attach | 1–2 weeks | `M0` |
| P1 | MVP core | Load ELF + LED/push button/OLED + debugging + serial port | 4–6 weeks | `M1` |
| P2 | Display and audio | ST7789 TFT + buzzer + speaker (I2S) + oscilloscope | 4–6 weeks | `M2` |
| P3 | Input peripherals | Microphone (I2S/ADC) + rotary knob + temperature and humidity sensor | 3–4 weeks | `M3` |
| P4 | Multi-chip and engineering | S3/C3/C6 + project management + PlatformIO integration | 4–6 weeks | `M4` |
| P5 | Ecosystem and extension | Peripheral plugin SDK + local peripheral catalog + docs site | Ongoing | `M5` |

> Estimates assume an "AI generation + human review" cadence; purely manual work requires ×2–3.

### 2.1 Milestone Acceptance Flags
- **M0** (reached 2026-08-31): `blink.elf` boots, UART prints `Hello`, GDB breaks at `app_main`.
- **M1** (tasks 1.1–1.10 completed; the app-level Electron manual regression is carried out together with the wrap-up): drag an LED in the UI and wire it to GPIO2, the OLED displays text drawn by the firmware, breakpoints and stepping are available.
- **M2** (in progress, tasks 2.1–2.3 completed): the TFT renders color images, the buzzer sounds, the speaker plays a sine wave.
- **M3** (reached 2026-09-11, tasks 3.1–3.4 completed): after injecting a microphone waveform the firmware can read the sampled values; the rotary knob quadrature sequence and the SHT30 read replies were verified through real QEMU e2e.
- **M4** (in progress, tasks 4.1–4.5 completed): after switching the chip model the same project runs on ESP32/S3 (S3 verified with real QEMU; the C3/C6 machine/simulator mapping and gating are ready, waiting for the riscv32 QEMU binary to be connected for real boot verification); the new-project wizard supports chip/template selection; PlatformIO/IDF project directories can be linked with automatic discovery of build/*.elf and import as firmware.elf; conditional breakpoints/watchpoints are wired into the debug panel (the GDB/MI wire format was frozen via an extended mock, real GDB e2e stays gated by BREADESP_GDB_BIN); the DAP adapter is live (dual stdio/TCP modes, launch/attach, real QEMU + esp-gdb 17.1 e2e passing, see docs/dap.md).
- **M5** (reached 2026-09-24, tasks 5.1–5.4 completed): after a third-party package calls `registerPeripheral()` a new part appears in the UI automatically (registry-driven palette + generic node body on the canvas, frozen by unit tests; SDK registration validation [BB-220/221/222] and sdkVersion gating landed); the local peripheral catalog (`~/.breadesp/peripherals/`) is scanned into a catalog panel — drop a package and it appears, explicit load into the Bridge registry, and after the renderer process mirrors the metadata the palette becomes draggable automatically, frozen by 51 new tests and a real IPC integration chain (PRD §F-EXT-3); the packaging scaffold `pnpm create-peripheral` generates a four-file publishable package (manifest/host API entry/README/zero-dependency self-check), frozen by 24 new tests, a real CLI run, and a pure-Node smoke test (PRD §F-EXT-4); the offline docs site `pnpm docs:build|docs:check|docs:serve` landed (hand-written restricted Markdown rendering + in-site link integrity [BB-241] gating + byte-level reproducible build + loopback preview server), and the 6 tutorials (getting started/first project/debugging/peripheral reference/peripheral authoring/VS Code DAP) are frozen by 81 new tests and real build/serve verification (PRD §F-DOC).

---

## 3. Phase-by-Phase Development Steps

### Phase 0 — Technical Validation (M0)

**Goal**: get the most critical chain "firmware → QEMU → serial port + GDB" working and verify feasibility.

| # | Task | Deliverable | Acceptance | Status |
|---|---|---|---|---|
| 0.1 | Set up the monorepo and toolchain | Skeleton exists, `pnpm install` passes | `pnpm typecheck` 0 errors | Done 2026-08-28 |
| 0.2 | Implement real download in `scripts/fetch-qemu.mjs` | Resolve the release asset per host, verify the checksum | `qemu-system-xtensa --version` executes | Done 2026-08-28 |
| 0.3 | Prepare golden firmware `blink.elf` + test cases | `packages/sim-core/fixtures/blink.elf` | The file exists and is an Xtensa ELF | Done 2026-08-29 |
| 0.4 | Implement real start in `QemuRunner.load/start` | stdout→uart events | UART receives `Hello ESP32` | Done 2026-08-29 |
| 0.5 | Implement `GdbBridge` connection + breakpoints | `setBreakpoint('app_main')` | GDB stops at app_main | Done 2026-08-29 |
| 0.6 | ELF architecture validation (e_machine==0x5e Xtensa, EM_XTENSA=94) | Validation before load in `ProjectManager` | Non-target ELF rejected with an error | Done 2026-08-31 |

**Forbidden in P0**: UI beautification, peripheral models, netlist validation extensions.

### Phase 1 — MVP Core (M1, aligned with PRD §8)

**Goal**: a minimal usable version of the virtual breadboard that is end-to-end demonstrable.

| # | Task | Deliverable | Acceptance | Status |
|---|---|---|---|---|
| 1.1 | Complete the preload↔handlers IPC channel alignment | `sim:load/onUart` etc. | No "unregistered channel" errors | Done 2026-08-31 |
| 1.2 | Implement the QEMU custom device `breadesp-dbus` (C) | Standalone QEMU build artifact | Bus transactions can be serialized to the socket | Done 2026-08-31 |
| 1.3 | Implement the `DBusChannel` frame protocol (length-prefixed JSON) | Node-side parser | One I2C transaction is received | Done 2026-08-31 |
| 1.4 | Implement `NetlistResolver` I2C/GPIO resolution | Routing by address/pin | The OLED transaction lands on oled1 | Done 2026-08-31 |
| 1.5 | Harden `PeripheralManager` routing + snapshot throttling | 30fps cap | The UI does not stutter | Done 2026-08-31 |
| 1.6 | Complete the `ssd1306` command set (common gfx library paths) | Correct video memory updates | The Adafruit_GFX demo works | Done 2026-08-31 |
| 1.7 | `BreadboardCanvas` drag-and-drop placement + wiring editing | Visualized wiring | Netlist and layout persisted separately | Done 2026-08-31 |
| 1.8 | Project save/load (`.breadesp` directory) | ProjectManager | Closing and reopening restores the original state | Done 2026-08-31 |
| 1.9 | Debug panel: breakpoints/stepping/variables/registers | Inspector | Can inspect `app_main` local variables | Done 2026-08-31 |
| 1.10 | Bidirectional serial console (output + injection) | SerialConsole | Pressing Enter is read by the firmware | Done 2026-08-31 |

**M1 regression**: all items of the M1 checklist in §12 pass.

### Phase 2 — Display and Audio (M2)

| # | Task | Deliverable | Acceptance | Status |
|---|---|---|---|---|
| 2.1 | `st7789` SPI command interpretation + rgb565 framebuffer | TFT color screen rendering | SPI transactions land on tft1 and pixels enter the framebuffer | Done 2026-08-31 |
| 2.2 | `TftRenderer` (rgb565→ImageData) | UI Canvas | The canvas displays the TFT content | Done 2026-09-01 |
| 2.3 | `buzzer` PWM frequency→WebAudio square wave | Sound output | The buzzer sounds at the given frequency | Done 2026-09-01 |
| 2.4 | `speaker` I2S PCM→WebAudio playback | Audio stream | The speaker plays a sine wave | Done 2026-09-02 |
| 2.5 | `Oscilloscope` captures GPIO/PWM/I2S timing | Waveform panel | The waveform panel displays GPIO waveforms | Done 2026-09-02 |
| 2.6 | Simulation speed multiplier + pause/resume (QMP) | sim control | sim can pause/resume/change speed | Done 2026-09-03 |

### Phase 3 — Input Peripherals (M3)

| # | Task | Deliverable | Status |
|---|---|---|---|
| 3.1 | `mic` I2S input injection | Firmware reads samples | Done 2026-09-05 |
| 3.2 | Local microphone capture→injection | Real-time input | Done 2026-09-07 |
| 3.3 | Waveform generator panel | Sine/square/noise | Done 2026-09-07 |
| 3.4 | Rotary knob, temperature and humidity sensor models | Extended peripheral set | Done 2026-09-11 |

### Phase 4 — Multi-chip and Engineering (M4)

| # | Task | Deliverable | Status |
|---|---|---|---|
| 4.1 | sim-core supports S3/C3/C6 machine mapping | Multi-chip | Done 2026-09-12 |
| 4.2 | Project wizard (chip/template selection) | New-project flow | Done 2026-09-12 |
| 4.3 | PlatformIO/IDF project linking (auto-discover build/*.elf) | Integration | Done 2026-09-13 |
| 4.4 | Conditional breakpoints / watchpoints | Debugging enhancements | Done 2026-09-15 |
| 4.5 | DAP adapter (VS Code integration) | Cross-tool debugging | Done 2026-09-18 |

### Phase 5 — Ecosystem and Extension (M5)

| # | Task | Deliverable | Status |
|---|---|---|---|
| 5.1 | Peripheral plugin SDK stabilization + versioning | Third-party extensibility | Done 2026-09-19 |
| 5.2 | Local peripheral catalog scanning | Offline marketplace | Done 2026-09-20 |
| 5.3 | Peripheral packaging template (scaffold) | Lower the barrier to entry | Done 2026-09-21 |
| 5.4 | Docs site + tutorials | Usability | Done 2026-09-24 |

> P5.1 verification record (2026-09-19): `pnpm typecheck` 0 errors; the full-repo suite on
> Windows passes 613 with + 14 skipped (gated e2e, same baseline as P4.5; a net increase of
> 32 items over P4.5); `pnpm --filter @breadesp/ui build` (tsc -b + vite) succeeds. Verified
> in four layers —
> registry layer, 19 unit tests (`packages/peripherals/tests/registry.test.ts`: built-in
> registration order/all self-checks passing/registerBuiltins idempotency, valid third-party
> factory registration and resolution by kind, listPeripherals returning a fresh array in
> isolation, [BB-220] shape matrix (non-object/missing create, 9 invalid kinds against 5
> valid kinds, 6 non-semver versions against prerelease/build acceptance, empty/blank
> displayName, 6 malformed pins tables, non-object defaults, non-semver sdkVersion),
> [BB-220] error messages listing all problem items, sdkVersion compatibility (same
> major/old major accepted, new major rejected [BB-222] with both versions named, rejected
> factories not retained, missing sdkVersion accepted as pre-P5.1 compatible), semver helper
> behavior including leading-zero rejection and PERIPHERAL_SDK_VERSION self-check); UI layer,
> 13 unit tests (paletteEntries 4 items — pure mapping preserving order and fields, empty
> snapshot, built-in set with complete displayName/semver, **direct translation of the M5
> acceptance**: after a third-party registerPeripheral() it appears in the live palette
> automatically; genericNode 9 items — fallback without a snapshot, level percentage and
> clamping including NaN, tone Hz/silent, text truncation, pixels geometry, audio sample rate
> and lamp state, waveform channel count, unknown future snapshot types still renderable);
> shell layer, the unknown-kind test now pins the [BB-206] encoded message (including
> kind/instanceId and registration guidance). Real QEMU e2e does not apply (this task does
> not touch the simulation chain); the third-party consumption chain (registry →
> PeripheralManager instantiation/routing), the existing probe factory tests, and all
> built-in peripheral e2e go through the same generic path.
> Self-iteration caught and fixed two issues: ① if the registerBuiltins idempotency flag were
> set up front, a mid-way failure would silently leave partial registrations behind — changed
> to set it after the loop completes, so a failure still throws explicitly on every call;
> ② a typecheck error for unused parameters in the newly added UI tests.
> Contract sync: PRD §6.2 completed up to the current contract (props parameter, viaPin,
> emitInput/drivePin, acceptCapture, rotate, sdkVersion) plus new registration and versioning
> paragraphs ([BB-220/221/222] + [BB-206]); PRD §7 appended paletteEntries.ts and
> genericNode.ts; docs/peripheral-sdk.md rewrote §2 (two-process registration + encoded
> validation errors) and §6 (versioning rules), and added §7 UI auto-presentation (including
> the known limitation: third-party tone/audio does not sound automatically).
> Design points: the palette is driven by the registry instead of a hard-coded list; the
> canvas falls back to a snapshot-driven generic node body for kinds without a dedicated
> renderer (built-in st7789 thus ends its bare-box state); zero new IPC in the UI, zero QEMU
> device changes, zero new runtime dependencies (PRD §5 unchanged).

> P5.2 verification record (2026-09-20): `pnpm typecheck` 0 errors; the full-repo suite on
> Windows passes 664 with + 14 skipped (gated e2e; a net increase of 51 over P5.1 — the
> baseline was re-measured via git worktree at HEAD (800fbf9) and confirmed as 613 passed +
> 14 skipped, consistent with the P5.1 record); `pnpm --filter
> @breadesp/ui build` (tsc -b + vite) and `pnpm --filter @breadesp/shell build` succeed.
> Verified in five layers —
> registry layer, 5 new unit tests (`packages/peripherals/tests/remote.test.ts`:
> registerRemotePeripheral metadata stub registration with resolution by kind/pin fidelity,
> the [BB-207] warning of the stub create(), metadata re-passing the full
> [BB-220]/[BB-221]/[BB-222] gating without retention when rejected, re-registration after
> unregisterPeripheral removal/false for an unknown kind);
> PluginCatalog layer, 23 unit tests (real temp directories + real entry modules — the
> manifest pure-validation matrix (manifestVersion/name containing @scope/version/displayName/
> description/entry escape segment-level detection including the legal directory name '..v2'
> and the POSIX root/drive letter/UNC three forms/sdkVersion/provides), scanning (missing root
> = empty directory, directories without a manifest skipped, bad JSON/oversized manifest/
> missing entry/invalid shape all degrading to invalid with all problems listed, a new SDK
> major marked incompatible, sorted by name), loading (host API default export registration +
> metadata returned + scan marking it loaded, idempotent reload, concurrent double-click
> deduplicated through inflight sharing the same import, CJS entry interop, the [BB-224] gate
> (unscanned directory/invalid/incompatible entries), [BB-223] (zero registrations/non-
> function default export/syntax error), rollback on a mid-way throw + successful retry after
> the fix (a process-level attempt sequence bypasses the ESM module cache),
> [BB-220]/[BB-221]/[BB-222] propagated as-is with partial registrations rolled back, the
> race where the entry file disappears after scanning, multi-kind packages));
> IPC contract layer, 38 items (3 new: per:catalogScan routing, per:catalogLoad routing
> pass-through, 5 malformed payloads rejected with [BB-225] without reaching the catalog); the
> preload↔handlers channel list exact-match assertion was extended accordingly. Integration
> layer, 5 items (`catalog.integration.test.ts`, the real preload → handlers →
> PluginCatalog → registry → PeripheralManager chain, bidirectional JSON boundaries): a
> dropped package is discovered immediately (the manifest crosses the boundary unchanged),
> load returns mirrorable metadata (nested pins arrays cross the JSON boundary losslessly),
> **M5 consumption acceptance** — after the catalog-loaded plug-led is wired to mcu.GPIO5 via
> bb:applyNetlist, the gpio transaction of the real route() drives the model to produce a
> level snapshot (the same path as built-in peripherals), [BB-224]/[BB-225] propagation
> across the boundary, double-click idempotency; UI layer, 15 items (marketplaceDraft 7 items
> — loaded taking precedence over the disk-corruption status label, the canLoad matrix,
> displayName/directory-name fallback, basename across separators, name@version subtitle,
> registered kinds/claimed provides rows, directory summary counts; marketplaceStore 8 items
> — scan hydration, re-mirroring via scanned factories after a renderer process reload with
> paletteEntries visible, no new mirror means no tick increment, scan failure keeps the old
> entries, a successful load mirrors + marks the entry loaded + tick +1, a failed load does
> not pollute the registry or tick, concurrent load deduplication, mirrorCatalogFactories
> skipping existing kinds).
> Real QEMU e2e does not apply (this task does not touch the simulation chain); the
> consumption path of catalog-loaded peripherals via applyNetlist/route is the same generic
> path as all built-in peripheral e2e (already frozen by netlist-routing/dbus-device and other
> e2e), and the integration tests assert directly on that path at the real IPC boundary. Also
> included: `tests/manual-smoke-p52.ts` (tsx manual smoke, not vitest), which runs the whole
> flow "drop package→scan→load→wire→route transaction→produce snapshot" in a **pure Node
> runtime** (i.e. the real module environment of the Electron main process, as opposed to
> vite-node) and has been verified passing.
> Self-iteration caught and fixed four real defects: ① load rollback blind spot — when the
> entry function throws after registering, the differential loop on the success path is not
> executed and added is empty, leaving partial registrations behind (changed to a differential
> rollback on the catch path); ② ESM module cache poisoning — after a failed load, retrying the
> fixed file still replays the cached module (a process-level attempt sequence was added to the
> entry URL; the first version counted per instance, which the "retry with a new instance" test
> scenario caught, and it was changed to a module-level counter); ③ manifest entry escape
> false positives — substring matching '..' rejects legal directory names like '..v2', and it
> missed the semantic difference of POSIX root paths on win32 (changed to segment-level exact
> detection + cross-platform absolute forms); ④ for entries with a missing entry file but a
> legal manifest, the manifest was mistakenly set to null (the marketplace panel should display
> the parsed manifest information). Also observed one transient failure during a full parallel
> repo test run (DapServer launch-flow); the same failure was reproduced at the P5.1 HEAD via
> git worktree, confirming it is a pre-existing timing-sensitive flake of that case rather than
> something introduced by this change (subsequent full/multi-package reruns were all green).
> Contract sync: PRD §F-EXT-3 expanded into a full contract (directory conventions/manifest
> format/entry contract/load semantics/mirroring mechanism), §6.2 appended a P5.2 paragraph
> (PeripheralMeta/PeripheralHostApi/registerRemotePeripheral/unregisterPeripheral + [BB-207]),
> §6.6 per:* appended catalogScan/catalogLoad, §7 appended PluginCatalog.ts and the
> Marketplace pair + marketplaceStore; docs/peripheral-sdk.md added §8 (directory format/host
> injection entry/error codes) and cross-referenced it in §2; docs/architecture.md added §11
> (two-process registry and mirroring chain); §11.2 appended BREADESP_PERIPHERALS_DIR. Design
> points: rollback on load failure relies on the new unregisterPeripheral (a host-internal
> primitive, disabled for third parties); the renderer process mirror reuses the full P5.1
> registerPeripheral gating; scanning never fails as a whole (bad packages degrade to entry-
> level status); zero new runtime dependencies (PRD §5 unchanged), zero QEMU device changes.

> P5.3 verification record (2026-09-21): `pnpm typecheck` 0 errors; the full-repo suite on
> Windows passes 688 with + 14 skipped (gated e2e, same P5.2 baseline; a net increase of 24
> over P5.2); `pnpm --filter @breadesp/shell build` (tsc) and `pnpm --filter @breadesp/ui build`
> (tsc -b + vite) succeed. Verified in four layers —
> generator layer, 12 unit tests (`packages/shell/tests/PeripheralScaffold.test.ts`:
> normalizeScaffoldRequest name/display name/description matrix (8 invalid names including
> @scope forms, non-object requests, multi-line text rejection, [BB-230] listing all problems
> at once), early rejection of a kind colliding with a registered kind (including collisions
> after @scope stripping), buildPeripheralPackage with exactly four files + the manifest fed
> back through validatePeripheralManifest with zero problems + exact field values (sdkVersion
> stamped with the host PERIPHERAL_SDK_VERSION, provides filled with kind, no description field
> when absent), class-name identifier legalization for kinds starting with a digit, key seams
> in the entry/README/self-check contents);
> disk-write layer, 3 items (nested parent directories created + written contents
> byte-identical to the pure build, an existing empty directory usable/non-empty rejected with
> [BB-231] and existing files untouched, clean failure with zero residue when the parent path
> is a file);
> **direct translation of the M5 acceptance**, 2 items — the package produced by the scaffold
> is scanned by the real PluginCatalog as 'ok', loads and registers the kind with metadata
> exactly matching the manifest, and after wiring mcu.GPIO4 via the bb netlist the real route()
> drives the model to produce level snapshots (0/1 both written, with an injected clock
> crossing the 30fps throttling window); the generated self-check.mjs is really executed in a
> subprocess and exits non-zero correctly for a broken entry;
> CLI layer, 7 items (parseScaffoldArgs all flags/defaults/5 usage errors [BB-230], --help to
> stdout with exit 0, usage errors to stderr with exit 2, built-in kind conflict with exit 2
> and zero writes, the full CLI chain's written output byte-identical to the library build,
> [BB-231] passed through with exit 2).
> Real CLI end-to-end verification: `pnpm create-peripheral acme-lamp --description ... --into
> <tmp>` really executed successfully (the tsx entry guard behaves correctly both under direct
> tsx and under vitest import), and the generated package's `node self-check.mjs` passes
> standalone; also included: `tests/manual-smoke-p53.ts` (tsx manual smoke, not vitest), which
> runs the whole flow "scaffold→scan→load→wire→route→snapshot→self-check" in a **pure Node
> runtime** and has been verified passing. Real QEMU e2e does not apply (this task does not
> touch the simulation chain); the consumption chain of scaffold output is the same generic
> path as P5.2 catalog loading and all built-in peripheral e2e.
> Self-iteration caught and fixed two issues: ① the error message draft on the write-failure
> path was incomplete (half-assembled join concatenation) — rewritten as a clean per-file
> try/catch carrying the file name plus partial file cleanup; ② review found that normalize
> would crash with a bare TypeError when the request is not an object — the [BB-230] boundary
> guard and a test were added. Deliberately avoided: the CLI flag drops `--dir` (pnpm swallows a
> global flag of the same name) in favor of `--into`; the template-generated code intentionally
> contains no backticks or ${} (ruling out escaping accidents from templates nested in
> templates), with placeholders replaced via split/join (no regex escaping risk).
> Contract sync: PRD added §F-EXT-4 (command form/four generated files/self-check invariants/
> [BB-230]/[BB-231] error codes), §7 appended PeripheralScaffold.ts and scaffold-cli.ts;
> docs/peripheral-sdk.md added §9 (scaffold usage) and shifted the test conventions to §10 (the
> self-check.mjs shipped with generated packages is its zero-dependency form);
> docs/architecture.md §11 appended §11.1; the root package.json added the `create-peripheral`
> script (pnpm --filter shell exec tsx); §11.3 appended that command.
> Design points: the generator core is pure functions + a thin fs layer (testability); the name
> rules reuse the catalog's PERIPHERAL_PACKAGE_NAME_RE (single source of truth, making it
> impossible to generate a package that the catalog rejects); zero new IPC, zero renderer
> process changes, zero new runtime dependencies (PRD §5 unchanged), zero QEMU device changes.

> P5.4 verification record (2026-09-24): `pnpm typecheck` 0 errors; the full-repo suite on
> Windows passes 769 with + 14 skipped (gated e2e, same P5.3 baseline; a net increase of 81
> over P5.3, all belonging to the new package @breadesp/docs-site); `pnpm build` (shell tsc +
> ui tsc/vite) succeeds. Verified in five layers —
> rendering layer, 35 unit tests (`packages/docs-site/tests/markdown.test.ts`: ATX headings
> levels 1–6 and stripping of a closing #, GitHub-compatible slugger (CJK preserved,
> punctuation removed, duplicate -N numbering — asserted against the real anchors of the
> dev-plan TOC and the PRD cross-links), setext underlined headings, paragraph soft-line-break
> merging, native HTML always escaped (the docs site has zero JS and no pass-through), inline
> code verbatim and multiple backticks, bold/italic/bold-italic with underscores not
> italicized (protecting identifiers like breadesp_dbus), link/image recording and rendering,
> nested restoration of stash placeholders (inline code inside link text), fenced code language
> classes and unclosed fences to EOF, table alignment colons/`\|` escaping (including inside
> code spans)/misaligned columns degrading to paragraphs/missing cells filled and extra cells
> dropped, tight/loose lists (the <p> wrapping difference), indented nesting, lazy continuation
> lines, task list checkboxes, blockquote recursion with tables not absorbed lazily); site
> model layer, 11 items (site.test.ts: tutorials discovered in filename order, the fixed
> guides/reference manifest routing uniquely, front-matter parsing (quoted values/CRLF/unknown
> keys and malformed lines and unclosed front matter all listed as issues), title precedence
> front matter > manifest navTitle > first H1, a missing source file listed as an issue without
> throwing, siteNav grouping and empty-section removal); link layer, 11 items (links.test.ts:
> relativeRoute same directory/subdirectory/parent directory/cross-section arithmetic,
> normalizePosix, relative page links rewritten to artifact-relative paths, anchors preserved
> with target-page validation (a bad anchor names the page and line), in-page anchor
> validation, external links passed through as-is without network access, repository-root
> escapes and site-absolute paths rejected, existing but non-site md rejected, nonexistent
> targets as broken links, asset registration and rewriting, all violations collected in a
> single pass); build layer, 10 items (build.test.ts, a real temp-directory fixture repo: all
> pages + index + asset copying, cross-page/anchor/image rewriting assertions, nav
> current-page highlighting with h2/h3 TOC, front-matter title into <title> and the sidebar
> nav, index section cards and descriptions, **F-DOC-4 two builds byte-identical**, [BB-242]
> output directory safety gate (an unmarked non-empty directory refused for cleaning with
> existing files untouched, rebuild cleaning stale files), [BB-241] all issues listed at once
> and failure before writing, missing sources/empty tutorial sections reported, checkSite
> writing nothing);
> **real-repo build acceptance** (same file) — breadespSite (repo root) passes checkSite with
> zero violations (13 pages = 6 tutorials + 3 guides + 4 reference), the real build asserts the
> exact page set, README's ./docs/dev-plan.md rewritten to ../reference/dev-plan.html, dev-plan
> TOC self-anchors (#12-验收检查清单 etc.) exactly equal to the heading ids, tutorial
> cross-links and architecture-page links rewritten, and <script> in the source does not pass
> through; CLI layer, 9 items (cli.test.ts: three subcommand parsing and defaults, 9 usage
> errors [BB-240], --help to stdout with exit 0, usage errors to stderr with exit 2, real build
> to the default docs/site and --out override, check on a good repo exits 0,
> a bad repo exits 2 with zero writes, serve really starts a server then fetches pages over
> HTTP and stops with exit 0 via AbortSignal);
> server layer, 5 items (serve.test.ts, a real loopback socket: MIME and no-store for
> index/nested pages/CSS, directory and / mapping, path traversal in bare/backslash/URL-encoded
> forms all 403, 404, HEAD without a body but with Content-Length, POST 405).
> Real end-to-end verification: `pnpm docs:build` really executed successfully (13 pages +
> index, all 46 in-site links passing); two-directory builds are byte-identical across 15 files
> (F-DOC-4); `pnpm docs:serve` really starts (127.0.0.1:4173) and HTTP verification of /,
> tutorial pages, and the PRD reference page returns 200 with the correct MIME/no-store, a
> nonexistent page returns 404, and an encoded path traversal returns 403. Real QEMU e2e does
> not apply (this task does not touch the simulation chain).
> Self-iteration caught and fixed three implementation defects: ① setext underlines being
> swallowed by paragraph accumulation ("Title\n===" rendered as heading text containing ===) —
> paragraph accumulation now stops when an underline candidate appears; ② tight list items'
> first paragraph unwrapping adding an extra newline (`outer\n\n<ul>`) — rest already carries
> its own joining newline, so it is concatenated directly; ③ link resolution order — a
> nonexistent .md target hit "not in the site manifest" before "broken link", so the existence
> check was moved earlier (a similar assertion was corrected: the CLI test's build file count
> missed the marker file). Also caught and fixed one **pre-existing contract drift**: PRD §6.1
> PinRole lacked the 'probe' member (landed in code types.ts and architecture.md §3.6 at P2.5
> but not synced to the PRD) — recorded with this task in a separate docs(prd) commit
> (additive, backward compatible). Environment note: during the session the standalone pnpm
> shim was broken (@pnpm/exe missing under global), so everything was driven through corepack
> pnpm with a session-level PATH shim covering nested invocations; artifacts and processes were
> unaffected.
> Contract sync: PRD added §3.9 F-DOC (F-DOC-1..6 + [BB-240]/[BB-241]/[BB-242]) and §7
> directories (docs/site/, docs/tutorials/, packages/docs-site/); the README documentation
> section (the three docs:* commands + dap.md listed) and the package structure table
> (docs-site row) were synced; §11.3 appended the three docs:* commands.
> Design points: the Markdown renderer is a hand-written restricted dialect (zero new runtime
> dependencies — tsx/vitest/@types/node are all existing repository devDependencies, PRD §5
> unchanged); two-pass rendering (the first pass collects heading anchors, the second injects
> the link resolver to rewrite hrefs); the output directory is guarded for cleaning by a
> .breadesp-docs-site marker file; site chrome is English and the body follows the source
> (PRD §10.7); zero new IPC, zero renderer process changes, zero QEMU device changes.

### Phase 6 — UI/UX Ergonomics Optimization (UX, 2026-09-30)

Implemented per `.trae/documents/ui-ux-optimization.md` (T0.1–T5.4, 24 tasks in total, 5 phases);
the goal is to be more ergonomic, more intuitive, and easier to get started with. Scope guard: zero
new IPC, zero QEMU device changes, the lib/shell packages untouched; no dark theme, no marquee
selection, no MCU moving, and no context menus.

| # | Task | Deliverable | Status |
|---|---|---|---|
| T0 | Infrastructure: Tailwind v4 (no preflight, `src/styles/global.css` with theme+utilities only + `bb-*` design tokens); lightweight i18n (en/zh dot-separated-key dictionaries, compile-time key alignment via `Record<MessageKey,string>`); unified Button; toastStore | Styling/copy/feedback foundation | Done 2026-09-30 |
| T1 | Feedback system: ToastHost global notifications; SimStatusLight; undo/redo as buttons (gated by canUndo/canRedo, the history mechanism being the existing F-BB-5 implementation); toolbar button migration | Operations become perceivable | Done 2026-09-30 |
| T2 | Canvas interaction: ResizeObserver adaptive layout; wheel zoom/background pan (canvasViewStore); grid snap; drag ghost preview; pin/wire hover highlighting; hint→toast; empty-state guidance | Canvas becomes approachable | Done 2026-09-30 |
| T3 | Layout and guidance: single-row TopBar (project group/firmware Popover/simulation group + language switch + `?` help); Palette search filtering; HelpDialog; collapsible BottomDock instrument dock (localStorage persistence) | Information architecture redesign | Done 2026-09-30 |
| T4 | Property panel: selectionStore mutually exclusive selection; propsSchema (explicit schema + fallback derivation for unknown kinds, boundaries reusing model LIMITS); PropsPanel (blur/Enter commit to avoid undo flooding); RightPanel Tabs | Visual property editing | Done 2026-09-30 |
| T5 | Wrap-up: full i18n extraction (`document.documentElement.lang` follows the locale); dead code cleanup; documentation contract sync; full-repo verification | Consistency | Done 2026-09-30 |

> UX verification record (2026-09-30): `pnpm -r typecheck` 0 errors; `pnpm -r build` all
> succeed; the full-repo suite on Windows passes 859 with + 14 skipped (gated e2e; a net
> increase of 83 over the 776 baseline after the F-BB-5 fix — toastStore 8, i18n 14,
> canvasView 20, paletteFilter 8, dockPrefs 10, selectionStore 7, propsSchema 14 plus store
> layer additions), with zero modifications to existing tests. All new tests are pure-logic
> draft/store module unit tests (no component rendering tests). The 12-item `pnpm dev` manual
> interaction acceptance checklist (1280px top bar not overflowing, the full firmware Popover
> flow, one-step rollback of sht30 property edits, language switch surviving a restart, etc.)
> awaits a manual rerun.

---

## 4. Code Style Conventions

### 4.1 General
- Language: TypeScript (`strict: true`), C (QEMU device, following upstream QEMU style).
- UI copy: Chinese and English, through the i18n dictionaries (`packages/ui/src/i18n/`, en/zh
  dot-separated keys + `useT()`/`tNow()`; technical symbols such as BTN/REC/LIVE/CCW/CW keep
  their original text). Logs and error-code messages: English. Documentation and comments:
  Chinese is acceptable.
- All externally reusable types/interfaces live in the package's `types.ts`; scattering them is
  forbidden.

### 4.2 Naming
- **Files**: `kebab-case.ts`; React component files `PascalCase.tsx`.
- **Types/interfaces**: `PascalCase`, interfaces take no `I` prefix (`interface Peripheral`, not `IPeripheral`).
- **Functions/variables**: `camelCase`.
- **Constants**: `UPPER_SNAKE_CASE`.
- **Enums**: `PascalCase` type name + `PascalCase` members.
- **Private fields**: the `_` prefix only when distinguishing from the public API; otherwise use `private`/`#`.
- **Events/IPC channels**: `domain:action` in lowercase (PRD §6.6, e.g. `sim:start`).

### 4.3 TypeScript Constraints
- `any` is forbidden; use `unknown` + type guards when unsure.
- `// @ts-ignore` is forbidden; you MUST use `// @ts-expect-error: <reason>` with a nearby TODO.
- `as` assertions are forbidden except at boundaries (IPC inputs), and you MUST comment why it is safe.
- Function return types are explicitly annotated (public API).
- Prefer `interface` to describe object shapes, `type` for unions/mapped types.
- Imports: uniform ESM `import`, `require` forbidden (except C code).
- Paths: workspace package names between packages, relative paths within a package.

### 4.4 React Constraints
- Function components + Hooks, class components forbidden.
- State: Zustand store across components; `useState`/`useReducer` locally.
- Side effects: `useEffect` dependency arrays MUST be complete; empty arrays with stale closure
  values are forbidden.
- Styling: Tailwind v4 utilities (no preflight; `src/styles/global.css` imports theme+utilities
  only and defines `bb-*` design tokens). New components prefer Tailwind classes; existing
  inline styles are not forcibly migrated; extract reused styles into a `const`.
- List keys: use business ids (`instanceId`), array indices forbidden.

### 4.5 Formatting (Hard Constraints)
- Indentation: 2 spaces.
- Quotes: single quotes (JS/TS); C follows upstream QEMU (Tab).
- Line endings: no debate about trailing semicolons → **always add a semicolon**.
- Line width: 120.
- Trailing newline: the file ends with a single `\n`.
- Tools: Prettier + ESLint (configuration completed in M0).

### 4.6 Comments
- File header: `// PRD: §X.Y — <one-line responsibility>`.
- TODO: `// TODO(PRD §X.Y): <action>`, for global searching.
- Public API: a brief JSDoc + `@param`/`@returns` (only when not obvious).
- "Commented-out dead code" is forbidden — deletion means deletion, never leave `// old logic`.

### 4.7 Error Handling
- Boundaries (IPC inputs, file IO, subprocesses) MUST try/catch and produce readable errors.
- Internal invariants use `assert`/throw; silently swallowing errors is forbidden.
- Error messages MUST include context (which instanceId / which transaction).
- User-visible errors use short English sentences + an error code prefix (e.g. `[BB-001] ...`).

---

## 5. Git Commit Conventions

### 5.1 Commit Granularity
- One commit = one logical change (one task or its substep).
- Giant "miscellaneous updates" commits are forbidden; split them into individually reviewable pieces.
- Every commit must independently pass `pnpm typecheck`.

### 5.2 Commit Message Format (Conventional Commits + scope)

```
<type>(<scope>): <subject>

<body optional>

<footer optional>
```

- **type**: `feat | fix | refactor | docs | test | chore | build | ci | perf | revert`
- **scope**: optional. Known values `shell`, `ui`, `peripherals`, `sim-core`, `netlist`, `docs-site`, `docs`, `prd`, `release`, `dev`, `build`, `ci`, `deps`, `repo`, `test`; unknown scopes only warn
- **subject**: imperative, English, lowercase first letter, no trailing period; hard first-line limit of **72** characters, subject ≤50 recommended (exceeding only warns)
- **body**: explains "why" (not "what was done"), each line ≤72 characters
- **footer**: `Refs: PRD §X.Y`, `Breaking:`, `Closes #N`
- **Enforced**: `scripts/check-commit-message.mjs` (local `.githooks/commit-msg` + the CI PR title); after a squash merge **the PR title becomes the final commit message** and is equally bound by this section

**Examples**:
```
feat(peripherals): implement SSD1306 data write path

Covers the Adafruit_GFX common draw path (page addressing mode).
Command set is partial; full set deferred to M2.

Refs: PRD §F-PER-3
```

```
fix(shell): handle duplicate instanceId in PeripheralManager

Previously applyNetlist leaked old instances on re-apply.
```

### 5.3 PRD Association
- Any commit that changes the PRD contract (§6) or directories (§7) MUST have `Breaking:` and `Refs: PRD §X.Y` in the footer, with the PRD change in **the same commit or a preceding commit**.

### 5.4 Prohibitions
- Using `--no-verify` to skip hooks is forbidden.
- Committing binaries is forbidden (except QEMU/ELF; ELF goes into fixtures).
- Committing `node_modules/`, `dist/`, `*.log` is forbidden.
- One commit containing both "functionality" and "formatting the whole file" is forbidden — split them.

---

## 6. Branch and Release Process

### 6.1 Branch Model (Trunk-Based Development)
- `main`: the only long-lived branch, protected, always buildable and demonstrable; it can only be entered via PR.
- `<type>/<scope>-<short>`: short-lived work branches, cut from the latest `main`, auto-deleted after merge; lifetime ≤3 days.
- `release/vX.Y.Z`: optional, used only for release freeze windows; merged back into `main` and deleted after the release.
- **No long-lived `dev` integration branch** (decision 2026-10-30; background and review conditions in `docs/decisions.md` 0001).

### 6.2 Process
1. `git switch main && git pull --ff-only`, then `git switch -c feat/ui-3d-snap`.
2. Commit in small steps; every commit passes `.githooks/commit-msg`; run `pnpm verify` locally before pushing.
3. `git push -u origin <branch>`, open a PR (target `main`) with a title conforming to §5.2.
4. CI `verify` green + self-check list ticked → **Squash and merge**.
5. Delete the branch after merging; `main` stays linear, and the PR title becomes the only commit message.

### 6.3 Protection Rules (GitHub ruleset `protect-main`)
- Direct push / force push / deletion forbidden; a PR is mandatory; required approvals = 0 (single maintainer, see decisions 0001).
- Must pass the `verify` status check; linear history required; squash merge only; the PR title format is validated by CI's `verify`.
- Emergency channel: only when GitHub Actions has a global outage, temporarily set the ruleset to `Evaluate`; restore within 24 hours after the fix, and record it in the PR / CHANGELOG.

### 6.4 Version Numbers and Tags
- Follow SemVer; during 0.x, milestones map to minor versions (M0–M1 `0.1.x`, M2 `0.2.x`, and so on).
- Tags are uniformly `vX.Y.Z` (no more `-mN` suffix), tagged only from `main`, never moved or deleted.
- Release PR: `chore(release): vX.Y.Z` (version number + CHANGELOG) → merge → `git tag vX.Y.Z && git push origin vX.Y.Z`.

---

## 7. Test Conventions

### 7.1 Test Layers
- **Unit**: pure functions/models (peripherals, netlist, MiParser). Vitest.
- **Integration**: cross-package chains (DBusChannel↔PeripheralManager). Vitest + mock QEMU.
- **End-to-end**: the real `blink.elf` golden case, asserting UART/snapshots end to end. Node scripts.

### 7.2 Coverage Goals
- peripherals, netlist, MiParser: unit coverage ≥80%.
- shell's QemuRunner/GdbBridge: integration tests with mock subprocesses.
- UI component tests are not required (add them in M5).

### 7.3 Test Style
- Files: `<subject>.test.ts`, in the same directory as the source or under `tests/`.
- Naming: `describe('module', () => { it('does X when Y', ...) })`.
- Assertions use `expect`; abusing `toBeNull()` is forbidden, prefer positive assertions.
- Golden firmware path: `packages/sim-core/fixtures/`, referenced by relative paths in tests.

---

## 8. Documentation Conventions

### 8.1 Two Kinds of Documentation
- **Contract documents**: `PRD.md`, `docs/architecture.md`, `docs/peripheral-sdk.md`. A change = a breaking change and requires review.
- **Process documents**: `docs/dev-plan.md` (this file), `CHANGELOG.md`, `README.md`. These evolve with the code.

### 8.2 CHANGELOG
- Maintain `CHANGELOG.md` (Keep a Changelog format).
- Each PR adds one line under the `Unreleased` section, format `- <type>: <summary> (#PR)`.

### 8.3 AI Readability
- All documents use clear heading hierarchies + numbering, making it easy for an AI to locate things.
- Cross-references use relative links (`[PRD §6](PRD.md)`).
- Code examples MUST be paste-and-run (no pseudocode).

---

## 9. AI Agent Collaboration Conventions

### 9.1 Taking On a Task
- On receiving a task, first read the corresponding PRD chapter + the corresponding phase in this file, and confirm the scope.
- Out-of-scope content: **do not do it**, just record `TODO(PRD)` for later; never expand on your own initiative.
- The header of every generated file MUST note `// PRD: §X.Y`.

### 9.2 Self-Check List (before each commit)
- [ ] `pnpm typecheck` 0 errors
- [ ] New/changed interfaces consistent with PRD §6
- [ ] New files fall under the PRD §7 paths
- [ ] No `any`/`@ts-ignore`/`require` (except C)
- [ ] No binaries committed
- [ ] Corresponding tests exist or `TODO` is marked
- [ ] Commit message conforms to §5.2
- [ ] Merged through a branch + PR, no direct push to `main` (the PR title also conforms to §5.2)
- [ ] PRD updated in sync if the PRD is affected

### 9.3 Prohibited Behaviors
- Refactoring code outside this task's scope "along the way" is forbidden.
- Introducing runtime dependencies not listed in PRD §5 is forbidden.
- Deleting existing tests to make them pass is forbidden.
- Mixing multiple unrelated changes into one commit is forbidden.
- Leaving debug output via `console.log` is forbidden (use the `log()` channel).
- Directly `push`ing `main`, `--no-verify`, and bypassing PR merges are forbidden.

### 9.4 When Unsure
- Ambiguous interface → stop, first raise an issue in the PRD (comment `// TODO(PRD §X.Y): interface to be clarified`), and deliver the minimal runnable implementation.
- Never proceed by "guessing the interface".

---

## 10. Caveats and Risks

### 10.1 Technical Risks
| Risk | Trigger | Mitigation |
|---|---|---|
| Incomplete QEMU-ESP32 peripheral coverage | P1.2 implementing the dbus device | Write our own device model; Renode models can be ported for reference |
| Xtensa instruction boundary cases | Occasional misalignment during debugging | Pin the QEMU version; golden firmware regression |
| I2S/ADC audio synchronization jitter | M2/M3 | Real sample-rate clock + buffering; declare it non-real-time |
| Konva stuttering with many nodes | M2 with many screens | Render the framebuffer straight into Canvas, not per primitive |
| Electron contextIsolation restrictions | Incomplete preload exposure | All cross-process access goes through APIs exposed by preload; the renderer never connects to Node directly |

### 10.2 Process Risks
- **Scope creep**: strictly follow the phase task table; record new ideas as "future work" instead of doing them now.
- **Contract drift**: AI renames → intercepted by the self-checks in §4.2 + §9.2.
- **Binary pollution**: `.gitignore` + hook, double insurance.

### 10.3 Security Notes
- QEMU subprocess `-nic none`, networking disabled (PRD §9).
- Validate `e_machine` before loading an ELF, preventing malicious firmware from crashing QEMU.
- The Bridge never executes arbitrary external commands; `spawn` is limited to the configured qemu/gdb paths.

### 10.4 Performance Notes
- Peripheral snapshot throttling: same instanceId and same type ≤30fps.
- DBus socket frame batching: merge high-frequency small transactions into one frame.
- UI rendering uses `requestAnimationFrame`; triggering setState per transaction is forbidden.

---

## 11. Environment and Toolchain

### 11.1 Development Dependencies
- Node ≥22.12, pnpm ≥9.
- QEMU-ESP32: fetched by `scripts/fetch-qemu.mjs`.
- GDB: `xtensa-esp32-elf-gdb` (provided with ESP-IDF, or installed separately).
- Build firmware: Arduino CLI or ESP-IDF (user side, not a repository dependency).

### 11.2 Environment Variables
- `BREADESP_QEMU_BIN`: absolute path to the QEMU binary (used by handlers).
- `BREADESP_QEMU_DBUS_BIN`: path to a QEMU binary with the `breadesp-dbus` device (e2e test gating).
- `BREADESP_GDB_BIN`: path to the GDB binary.
- `XTENSA_GNU_CONFIG`: esp-gdb Xtensa dynconfig override (usually unnecessary since P4.5 —
  GdbBridge automatically points to `<gdb>/lib/xtensa_<chip>.so` per chip; an explicit setting
  takes precedence).
- `VITE_DEV_SERVER_URL`: UI load address in dev mode (used by Electron main).
- `BREADESP_LOG_DIR`: log directory (default `~/.breadesp/logs`).
- `BREADESP_PERIPHERALS_DIR`: root of the local peripheral catalog (default
  `~/.breadesp/peripherals`, the scan source of the P5.2 offline marketplace).
- `BREADESP_DOCKER_MIRROR`: Docker Hub image prefix (e.g. `docker.1ms.run/`, when building the
  device build of QEMU).
- `BREADESP_SUBPROJECT_MIRRORS`: list of QEMU meson wrap subproject mirror templates
  (comma-separated, `{name}` placeholder).
- `BREADESP_MSYS2_DIR`: Windows MSYS2 root directory (default `C:\msys64`).

### 11.3 Script Commands
| Command | Purpose |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm typecheck` | Full-repo type checking |
| `pnpm test` | Full-repo tests |
| `pnpm fetch-qemu` | Download the QEMU binary |
| `pnpm create-peripheral <name>` | Generate a peripheral package scaffold (PRD §F-EXT-4, P5.3) |
| `pnpm docs:build` | Build the offline docs site into `docs/site/` (PRD §F-DOC-1, P5.4) |
| `pnpm docs:check` | Validate documentation sources and in-site links, zero writes (PRD §F-DOC-3, P5.4) |
| `pnpm docs:serve` | Rebuild and preview the docs site locally (PRD §F-DOC-5, P5.4) |
| `node scripts/build-qemu-device.mjs [--target linux-docker\|windows-msys2]` | Build the breadesp-dbus device build of QEMU |
| `node scripts/make-blink-elf.mjs [--chip esp32\|esp32s3]` / `make-i2c-elf.mjs` / `make-uart-echo-elf.mjs` / `make-knob-elf.mjs` / `make-sht-elf.mjs` | Regenerate test firmware |
| `pnpm dev` | Start Electron + Vite dev |
| `pnpm build` | Build all packages |

---

## 12. Acceptance Checklist

### M0 Checklist (passed 2026-08-31)
- [x] `pnpm install && pnpm typecheck` passes
- [x] `pnpm fetch-qemu` downloads successfully and is executable
- [x] After `blink.elf` starts, UART output is visible
- [x] The GDB breakpoint hits `app_main`
- [x] A non-Xtensa ELF is rejected from loading
- [x] No binaries committed (`git log --diff-filter=A -- '*.bin'` is empty)

> Verification record (re-check 2026-08-31): `pnpm typecheck` 0 errors; full-repo tests 73 passed + 1 skipped, including the real QEMU UART e2e (`qemu-uart.e2e.test.ts`) passing; the GDB breakpoint e2e requires `BREADESP_GDB_BIN` and was verified on 2026-08-29 against real QEMU + `xtensa-esp32-elf-gdb` (see CHANGELOG); the only committed binary is `fixtures/blink.elf` (the ELF fixture allowed by §5.4), with no `*.bin` committed.

### M1 Checklist (in progress, tasks 1.1–1.10 completed: IPC alignment, the breadesp-dbus device and the standalone QEMU build, the DBusChannel frame protocol, NetlistResolver I2C/GPIO routing, PeripheralManager routing robustness + 30fps snapshot throttling, the completed SSD1306 command set, breadboard canvas drag-and-drop placement + pin wiring editing (strict netlist/layout separation: moving a node changes only the layout, wiring changes only the netlist, each serialized independently and the netlist always passing validateNetlist), project save/load (the `.breadesp` directory four-piece set firmware.elf/netlist.json/layout.json/meta.json, the full new/open/save/saveAs/close lifecycle, structurally equal round trip on close and reopen), the debug panel (breakpoint add/remove/clear list + step in/over/continue + local variables/registers/global watching, dbg:connect lazy attach + dbg:stopped/running/exit pushes, blink.elf carrying DWARF4), bidirectional serial console (the sim:sendUart injection chain + the uart-echo.elf golden firmware, UART0 RX/TX end-to-end echo); dbus and routing e2e verified on real QEMU — OLED transactions land on oled1, a continuous 1ms transaction stream is compressed to ≤30fps, the Adafruit_GFX begin()+display() frame path updates video memory correctly, undo/redo (F-BB-5: projectStore past/future dual stacks UNDO_LIMIT=20, six kinds of canvas edits pushed, per-frame drag merged for the same instance into one step, load/reset clearing the stacks, BreadboardCanvas Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z shortcuts + text-input focus protection, 8 contract tests)))
- [ ] The UI can drag LED/push button/OLED onto the canvas
- [x] Can wire to GPIO and save the project
- [x] The LED turns on/off with the GPIO2 level (blink)
- [ ] The OLED renders text drawn by the firmware
- [ ] Push button clicks inject GPIO input that the firmware reads
- [x] Can set breakpoints, step, and inspect global variables
- [x] The serial port can output and inject
- [x] Closing and reopening the project restores the original state
- [x] peripherals unit tests pass

> P1.8 verification record (2026-08-31): `pnpm typecheck` 0 errors; full-repo tests 173 passed + 3 skipped (Windows gating).
> "Closing and reopening restores the original state" was verified in three layers — ProjectManager unit tests (a real temp directory save→close→reopen with structurally equal results,
> 19 items), IPC integration tests of preload→handlers→real ProjectManager (including bidirectional JSON serialization boundaries and
> BB-120/122/124 error propagation, 5 items), UI store hydration/reset and id re-sequencing after loading (14 items);
> the Electron app-level UI manual regression is carried out together with the M1 wrap-up.

> P1.9 verification record (2026-08-31): `pnpm typecheck` 0 errors; full-repo tests 196 passed + 4 skipped (Windows gating).
> Three-layer verification — 15 GdbBridge unit tests against a mock GDB/MI subprocess (newly added vars/regs/evaluate/listBreakpoints/
> clearBreakpoints/stepOver/isConnected); 15 IPC contract items (newly added dbg:connect routing and BB-115 gating,
> sim:step going through GDB's BB-105 gating, dbg:stopped pushes); 11 debuggerStore items (attach/detach state machine,
> breakpoint list maintenance, watch value re-evaluation, discarding late replies after detach — a real race exposed by a test race and fixed). Real QEMU +
> xtensa-esp32-elf-gdb e2e (debug-panel.e2e.test.ts) passed on WSL (Linux breadesp QEMU build +
> standalone esp-gdb 16.3_20250913; the gdb of the esp-2021r2-patch5 toolchain cannot run on Ubuntu 24.04 due to a missing libpython2.7):
> break at `led_state_written` → evaluate('led_state')=="1" → vars() returns app_main's msg_cursor/remaining/
> delay_ticks (remaining==0) → regs().pc hits the breakpoint address → step → breakpoint list cleared. The e2e also exposed a real protocol
> shape deviation — `-break-list`'s `body` is nested inside `BreakpointTable` (the earlier mock-driven parser mistakenly placed it as a top-level
> field), so the parser was corrected to the wire shape and the mock aligned; the P0.5 gdb-breakpoint e2e also regressed green in the same environment.

> P1.10 verification record (2026-08-31): `pnpm typecheck` 0 errors; full-repo tests 199 passed + 4 skipped (Windows gating).
> The bidirectional chain was verified in three layers — 9 QemuRunner unit tests against a mock QEMU (newly added writeStdin stdin forwarding echo,
> BB-102 rejection when not loaded); 15 IPC contract items (newly added sim:sendUart channel and preload exposure alignment); the real
> QEMU e2e (qemu-uart.e2e.test.ts case 2) passed on WSL (Linux breadesp QEMU build): inject
> `Hello BreadESP\n` → the firmware polls UART_STATUS.RXFIFO_CNT, dequeues and assembles a line → echoes `ECHO: Hello BreadESP\r\n`
> → the second line `line two` proves the line buffer reset correctly. The golden firmware `uart-echo.elf` is
> deterministically generated by `scripts/make-uart-echo-elf.mjs` (xtensa-elf.mjs gained l32i encoding), and `--check` mode
> validates that the committed fixture has not drifted. Known platform difference: the Windows stdio backend (char-win-stdio.c) drops `\r` bytes, so the UI and
> the tests uniformly inject lines ending with `\n`.

> Acceptance-fix verification record (2026-09-30): `pnpm typecheck` 0 errors; full-repo tests 776 passed + 14 gated skips
> (ui 182 including 8 new F-BB-5 cases); `pnpm -r build` green across all six packages; `pnpm docs:check` passes. This fix addressed three
> confirmed problems: ① the Electron startup chain had never worked end to end — the three lib packages (netlist/peripherals/sim-core) and shell were all
> changed to produce CommonJS dist via tsc (source relative imports have no extensions, so ESM artifacts are unresolvable in the Node runtime; CJS incidentally
> restores `__dirname` and the CJS requirement of the sandboxed preload), package main points to dist while types stay in src, and shell/ui's
> vitest/vite resolve.alias pins `@breadesp/*` back to the source (tests test the source, with no stale dist); the unused ESM-only
> phantom dependency nanoid was removed, and two `import.meta` uses were converted to `__filename`; ② `pnpm dev` was unusable —
> `tsx watch src/main.ts` runs the electron module under plain Node, which inevitably blows up, and it had no vite step, so root dev now points to a zero-dependency
> `scripts/dev.mjs` (starts vite :5173 → polls the port → spawns electron . with VITE_DEV_SERVER_URL injected,
> recycling both ways on either exit); ③ F-BB-5 undo/redo had no implementation anywhere in the repo — projectStore past/future dual stacks
> with UNDO_LIMIT=20, six kinds of canvas edits pushed, per-frame drag merged for the same instance, load/reset clearing the stacks, BreadboardCanvas
> Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z + text-input focus protection. Smoke-tested for real: `electron .` starts and the main process window is normal,
> and a PrintWindow screenshot confirms the four-area layout renders completely (top bar project/simulation toolbars, left Palette+Marketplace lists
> returned via per:catalogScan IPC, center canvas ESP32 MCU pin array, bottom serial/Screen/oscilloscope/WaveGen
> four panels, right debug panel), and the IPC main↔renderer chain all works — the desktop app really started successfully for the first time.
> Three M1 interaction acceptance items that cannot be completed on native Windows (LED on/off/OLED rendering/push button injection): they depend on
> the breadesp-dbus device chain, whose QEMU build target is linux-docker (win32 rejected by gating), and the local mingw
> QEMU has no such device — these three items need to be rerun against the device build of QEMU on WSL/Linux (the corresponding e2e have already verified the firmware-side
> behavior on WSL: netlist-routing/spi-st7789/pwm-buzzer and 11 other gated files).

> P2.1 verification record (2026-08-31): `pnpm typecheck` 0 errors; full-repo tests 218 passed + 5 skipped (Windows gating,
> with a new spi e2e skip). Verified in three layers — 13 st7789 model unit tests (init→full-frame rendering, DC level applied to the whole frame, half-pixel across frames,
> CASET/RASET window writes and wraparound, MADCTL rotation (including TFT_eSPI drawPixel local-window expectations), BGR channel swap,
> blank screen during off/sleep, INVON/INVOFF inversion, any command terminating the RAMWR stream, SWRESET power-on state, CS filtering and read transaction ignoring,
> missing dc warning once), the unit tests exposed and fixed two real model bugs (MADCTL transform order, RAMWR termination semantics); NetlistResolver
> extended to 20 items (CS claiming, controller-number agnosticism, factory default fallback, unclaimed CS, out-of-range CS rejection, spi-cs role filtering);
> the real QEMU e2e (spi-st7789.e2e.test.ts) passed on WSL (Linux breadesp QEMU rebuilt by Docker,
> with the SPI sniffer): the CS0 transaction stream of spi.elf renders 4 RGB565 pixels into the 240x240 framebuffer in scan order (the rest black),
> no broadcast leakage (only tft1 produces snapshots), and the UART shows the `SPI OK` completion marker. The golden firmware `spi.elf` is
> deterministically generated by `scripts/make-spi-elf.mjs`, and `--check` mode validates that the committed fixture has not drifted.
> Two lessons from building the QEMU device: the `SSI_BUS` macro is not exported (use `qdev_get_child_bus(...,"spi")` cast to `SSIBus*`);
> an SSI peripheral class that does not implement the `realize` callback SIGSEGVs during the realize phase (the sniffer implements an empty callback).

> P2.2 verification record (2026-09-01): `pnpm typecheck` 0 errors; full-repo tests 231 passed + 5 skipped (Windows gating,
> same baseline as P2.1, with 13 new TftRenderer unit tests). Verified in two layers — `TftRenderer.rgb565ToRgba`
> pure decoding (5/6/5→8-bit bit replication: pure red 0xF800→255 rather than 248, matching real ST7789 full-scale color rendering; row order
> row-major, 16-bit masking, over-length truncation, missing values filled black, throwing on too-small buffers, an all-black frame), `TftRenderer.renderRgb565`
> canvas binding (createImageData→putImageData@0,0, resizing the canvas backing store to the snapshot size,
> silent return when the 2d context is missing); plus the ST7789 snapshot shape integration seam (`pixels` payload `{width,height,
> format:'rgb565',buffer:number[]}` decodable as-is). `ScreenView` was refactored from "a single OLED mono canvas"
> into "multi-screen tiles sorted by instanceId", each screen holding its own canvas and dispatching mono/rgb565 renderers by format,
> with the 240×240 TFT scaled proportionally inside the 280px side panel and `imageRendering:pixelated` keeping pixels crisp.

> P2.3 verification record (2026-09-01): `pnpm typecheck` 0 errors; full-repo tests 260 passed + 6 skipped (Windows gating,
> with a new pwm e2e skip). Verified in four layers — 14 buzzer model unit tests (pwm decoding including centi-hertz fractions, silence at zero duty/zero frequency,
> steady-state deduplication, 440→880 pitch change, duty clamping, truncated payload ignoring, read transaction/mixed transaction filtering; bit-bang edge
> frequency measurement, the 4-edge lower bound, drift-band deduplication, frequency tracking, out-of-audio-band rejection); routing/protocol layer, NetlistResolver 21 items (pwm routed by the GPIO
> wiring + unwired pins) and DBusChannel 8 items (pwm frame pass-through ns→ms); UI layer, BuzzerAudio 14 items (pure mapping clamping/non-finite values/
> non-tone rejection, per-instance osc→gain→destination wiring of one square-wave channel, in-place pitch change, mute without stopping the oscillator, custom volume,
> silent without AudioContext, resume only when suspended, one-shot gesture hook, rebuild after dispose); the real QEMU e2e
> (pwm-buzzer.e2e.test.ts) passed on WSL (Linux breadesp QEMU rebuilt by Docker, with the LEDC/GPIO matrix
> shadow): the LEDC 440Hz→880Hz configuration sequence of buzzer.elf lands on buzz1's tone snapshots (430–450Hz → 860–900Hz,
> duty≈0.5), no broadcast leakage, and the UART shows the `BUZZ 440`/`BUZZ 880` markers; spi-st7789/netlist-routing/dbus-device
> e2e regressed green against the same rebuilt binary (WSL full run 127 passed). The golden firmware `buzzer.elf` is
> deterministically generated by `scripts/make-buzzer-elf.mjs`, and `--check` mode validates that the committed fixture has not drifted.
> Design points: QEMU's built-in esp32_ledc model only stores registers and does not drive pins (the GPIO matrix is not modeled), so the device side adds an
> LEDC register shadow + GPIO FUNCn_OUT_SEL observation, decoding timer/channel configuration per the TRM formulas into per-pin
> (frequency, duty) and sending it deduplicated as pwm transactions (6 bytes: centi-hertz u32 LE + per-mille duty u16 LE);
> the snapshot gains a 'tone' type (an additive union extension in §6.4, with duty doubling as visual brightness, avoiding one snapshot slot per instance overwriting each other).

> P2.4 verification record (2026-09-02): `pnpm typecheck` 0 errors; full-repo tests 290 passed + 7 skipped (Windows gating,
> with a new i2s e2e skip). Verified in four layers — 13 speaker model unit tests (s16le stereo downmixed to mono, mono/8-bit/24-bit
> decoding and sign extension, truncated header/zero sample rate/zero channels/invalid bit width rejection, partial trailing frames dropped, batch threshold flushing, frame reassembly across transactions,
> format change flushing at the old sample rate first, mixed/read transaction filtering, i2s-data-in role and bus defaults); routing/protocol layer,
> NetlistResolver 25 items (i2s claimed by controller number, factory default fallback, unclaimed/out-of-range buses, role filtering) and
> DBusChannel 9 items (i2s frame pass-through); PeripheralManager 16 items (the new 'audio' snapshot bypasses 30fps merging — PCM is a stream,
> not a restatable state, and merging loses samples; the e2e had caught this bug as 1867Hz≈1.8× apparent frequency); UI layer, SpeakerAudio 13 items
> (pure mapping, first-chunk lead scheduling, seamless cursor chaining, independent cursor per instance, underrun resync, hard clipping, volume, silent without AudioContext,
> one-shot gesture hook, stopping the source on dispose for rebuild); the real QEMU e2e (i2s-speaker.e2e.test.ts) passed on WSL
> (Linux breadesp QEMU rebuilt by Docker, with the I2S shadow): the I2S0 DMA sine loop of speaker.elf reaches spk1's
> audio snapshots (measured 16667 within the 15800–17500Hz band, zero-crossing estimated frequency 1041.7Hz±5%, peak 0.4–0.7), no broadcast
> leakage, and the UART shows the `SPK SINE` marker; spi-st7789/pwm-buzzer/netlist-routing/dbus-device e2e regressed green against the same rebuilt
> binary (WSL full run 134 passed). The golden firmware `speaker.elf` is deterministically generated by `scripts/make-speaker-elf.mjs`,
> and `--check` mode validates that the committed fixture has not drifted.
> Two real bugs during development were caught and fixed by the verification chain: ① on the QEMU side OUTLINK_ADDR is a 20-bit DRAM window field
> (physical address = 0x3ff00000|field, while lldesc's buf/next are full pointers), and the first version read descriptors as absolute addresses, so the whole stream was silent;
> ② the device's 10ms tick cutting chunks by byte rate split 4-byte stereo frames across two transactions, and the model's first version decoded each transaction independently,
> dropping residual frames, so the stream phase misaligned and appeared as ~2× apparent frequency — the model was changed to reassemble residual frames across transactions (caught by the e2e zero-crossing estimate of 2099.9Hz).

> P2.5 verification record (2026-09-02): `pnpm typecheck` 0 errors; full-repo tests 320 passed + 8 skipped (Windows gating,
> with a new gpio e2e skip). Verified in four layers — 16 oscilloscope model unit tests (viaPin channel attribution, square-wave period
> reconstruction, same-level deduplication, window scroll pruning (one edge before the window kept and re-anchored at t=0), edge count cap,
> filtering of missing viaPin/unknown pins/read transactions/non-finite timestamps/mixed transactions; PWM steady-state synthetic expansion (100Hz/50%→21 edges including the right boundary, 25% duty high edges
> 2.5ms, a flat track in an empty channel after stopping, real gpio writes replacing the synthesis, truncated payload ignoring, very fast tone edge capping), whole-window restatement
> snapshot deduplication on the source side); routing layer, PeripheralManager 17 items (new viaPin passing — CH1/CH3 of the same scope split to their own
> channels, the second waveform within a 30fps window delivered via trailing flush); UI layer, traceBuilder/renderScope 13 items
> (waveformOf payload narrowing, step-polyline geometry (first edge back-propagating the previous level, square-wave alternating tracks, out-of-range clamping, empty channel as a low flat track),
> grid equal division/channel bands/stable colors, canvas binding with a recording 2d context — background/labels/time base annotations, one
> step trace per channel, only the background drawn for non-waveform payloads, silent return without a 2d context); the real QEMU e2e
> (gpio-scope.e2e.test.ts) passed on WSL: the GPIO2 toggle stream of blink.elf lands on scope1 CH1's
> waveform snapshots (≥6 edges, strictly alternating levels, median edge spacing consistent within the 10% band — busy loop symmetry), no broadcast
> leakage, and the UART shows the `Hello ESP32` marker; spi-st7789/pwm-buzzer/i2s-speaker/netlist-routing/
> dbus-device e2e regressed green against the same binary (WSL full run 136 passed + 5 skipped).
> Design points: no changes needed on the QEMU device side — the GPIO shadow already reports level changes on the virtual clock (ns, normalized to ms by DBusChannel);
> the oscilloscope joins the existing wire-level gpio/pwm routing as a breadboard part, and multi-channel attribution is passed via the
> additively optional parameter `Peripheral.onTransaction(tx, viaPin?)` (§6.2 contract-compatible); the 'waveform'
> snapshot payload gains the additive `WaveformPayload` variant ({startMs, windowMs, channels[]}, a whole-window restatement,
> safe for 30fps last-write-wins merging); LEDC driving a pin has no real toggling, so PWM steady state synthesizes edges per window at snapshot build time
> (equivalent to a real oscilloscope's trigger view). I2S bus capture is left as a P3 TODO.

> P2.6 verification record (2026-09-03): `pnpm typecheck` 0 errors; full-repo tests 328 passed + 9 skipped (Windows gating,
> with a new sim-speed e2e skip). Verified in four layers — 12 QemuRunner mock subprocess tests (newly added [BB-116]
> multiplier validation (NaN/∞/0/0.05/10.5/-1 rejected, the 0.1/10 boundaries accepted), 'speed' event pass-through, 0.5x duty-cycle throttling on a
> 40ms quantum (≥4 stop/cont windows, status staying 'running' during throttling, no extra throttling stop after a user pause takes over
> the period, throttling resumed after resume, disarmed back at 1x)); 17 IPC contract items (newly added sim:setSpeed/
> sim:getSpeed channels and the sim:speed push, payloads passed through as-is); UI layer, simulationStore 3 items (default 1x,
> setSpeed mirroring, clear reset); the real QEMU e2e (sim-speed.e2e.test.ts) passed on WSL:
> the GPIO2 transaction stream of blink.elf — full-speed baseline arrival rate >0 → zero transactions for 800ms after pause (the virtual clock frozen) →
> resume recovers → at 0.25x the throttled rate falls in the 5%–60% band of full speed (the same virtual time of blink spread over ~4x wall clock) →
> back at 1x full speed recovers; gpio-scope/spi-st7789/pwm-buzzer/i2s-speaker/netlist-routing/dbus-device/
> qemu-uart e2e regressed green against the same binary (WSL full run 142 passed + 5 skipped).
> Design points: QMP has no CPU clock control, so <1x is implemented as "logical clock throttling" via QMP stop/cont duty-cycle throttling
> (the original PRD §F-SIM-2 wording) — after each quantum the VM runs speed×quantum and stop freezes the virtual clock, stretching dbus timestamps
> accordingly; >1x is accepted but saturates at wall clock (QEMU cannot outrun the host). Throttled stop/cont is an internal implementation detail, and the broadcast status
> stays 'running' (F-SIM-4 unchanged); a generation counter retires in-flight phases, and a racing stop must be undone by cont
> unless a user pause takes over. Two issues surfaced during iteration and were fixed: ① under full parallel runs the long-duty-cycle guest of the sim-speed e2e
> preempted the CPU, causing gpio-scope's 10% edge-spacing band to jitter out of range (10.3%/41%) — shell vitest was changed to single-threaded serial execution so
> real hardware measurements no longer compete; ② on Windows the stderr log of an in-flight stop before pause flushes one beat late,
> making the count assertion 5≠4 — a 60ms settling window was added to the test (stable across 5 consecutive runs).
> UI: a new SimControls bar (Pause/Resume/Reset + 0.1x–10x multiplier selection), with simulationStore
> mirroring the sim:speed push.

> P3.1 verification record (2026-09-05): `pnpm typecheck` 0 errors; full-repo tests on Windows 348 passed + 10 skipped
> (gated e2e), WSL shell full run (including all real QEMU e2e) 146 passed + 5 skipped. Verified in four layers — the mic model
> 19 unit tests (props validation clamping fallback, four waveform generations (sine amplitude/phase continuity across blocks, square wave symmetric tracks, xorshift
> noise determinism and boundedness, silence all zeros), 8/16/24/32-bit little-endian signed encoding, per-block interval emission of
> I2sInjection, dispose stopping emission, one-time warning without an injection channel, mixed transaction ignoring, factory metadata);
> protocol layer, DBusChannel 11 items (newly added sendInject reverse frame `{"v":1,"in":[{"kind":"i2s-in",...}]}`
> wire format and returning false without a device); routing layer, PeripheralManager 18 items (newly added emitInput→'inject'
> event forwarding and dispose stopping the stream); the real QEMU e2e (mic-i2s.e2e.test.ts) passed on WSL:
> mic1 injects a 440Hz sine (33.3kHz 16bit mono) through the reverse channel into the device RX queue, and the device writes it into the in-link ring at the firmware decoding
> rate (owner cleared + length written back + eof), mic.elf polls until 8 non-zero buffers
> then prints `MIC OK` (and `MIC RDY` precedes `MIC OK`); speaker/st7789/buzzer/scope/sim-speed
> and all other e2e regressed green against the same rebuilt binary. The golden firmware `mic.elf` is
> deterministically generated by `scripts/make-mic-elf.mjs`, and `--check` mode validates that the committed fixture has not drifted.
> Iteration caught and fixed two real bugs: ① starvation deadlock — when the injection queue was empty the device zero-filled the descriptor and cleared owner,
> while the firmware only re-armed when it saw non-zero data, so both sides waited forever and the ring stalled (probe reproduction: ticks advance but the firmware never
> receives data) — the device was changed not to claim the descriptor when the queue is exhausted (staying armed), and the firmware was changed to unconditionally
> re-arm every round (the standard ring consumption pattern); ② missing protocol field — the first version of TS `sendInject` omitted
> `"kind":"i2s-in"` during serialization, so the device's ordered scanner could not find the injection object and silently dropped it (probe comparison: a manual injection with kind
> worked, the model chain did not; device-side layer-by-layer printing located the scan miss) — sendInject now fills in kind automatically
> and freezes the wire format with unit tests.

> P3.2 verification record (2026-09-07): `pnpm typecheck` 0 errors; full-repo tests on Windows 382 passed + 11 skipped
> (gated e2e), WSL shell full run (including all real QEMU e2e) 151 passed + 5 skipped. Verified in four layers — the mic model
> 33 unit tests (newly added `drainResampled` pure function 5 items: equal-rate pass-through with position continuity, exact 2:1 integer-point decimation,
> 1:2 linear interpolation upsampling, starvation producing zeros, fractional-ratio decimal-point interpolation; capture path 10 items: capture overriding synth,
> 48k→16k host-rate resampling, no silence injection on starvation, falling back to synth after 500ms without a fed stream, stale buffer clearing,
> source-rate change resetting the buffer, 1s cap dropping the oldest + one-time warning, malformed blocks dropped entirely, out-of-range amplitude clamped to full scale,
> mono duplicated to stereo, dispose stopping capture); routing layer, PeripheralManager 20 items (newly added feedCapture
> routing + silent dropping for unknown instances/models without acceptCapture); protocol layer, IPC contract 19 items (newly added
> `per:captureChunk` channel registration alignment, legal payload pass-through, 9 malformed payloads rejected with [BB-202]); UI layer,
> the MicCapture engine 8 items (zero-gain wiring to prevent feedback, per-instance tagged emit, start idempotency, getUserMedia
> rejection propagation, releasing the stream without AudioContext, stop/dispose tearing down the graph + stopping tracks + closing ctx) + captureStore 6 items
> (state transitions, [BB-210] error surface, chunk→IPC wiring, reconcile stopping capture for instances removed from the netlist);
> the real QEMU e2e (mic-capture.e2e.test.ts) passed on WSL: mic.elf (with props deliberately set to
> waveform:'silence', so only the capture path can produce non-zero samples) is fed 48kHz mono Float32 sine blocks via
> `feedCapture` (the same shape as the payload emitted by the renderer process MicCapture), the model resamples to the firmware's
> 33.3kHz, and the firmware prints `MIC OK` after accumulating 8 non-zero RX DMA buffers; mic-i2s (synth path regression),
> spi-st7789, pwm-buzzer, i2s-speaker, gpio-scope, sim-speed, netlist-routing,
> dbus-device e2e all regressed green against the same binary.
> Design points: capture is a pure runtime override state and does not touch the netlist (reopening a project should not automatically request microphone permission) — while the fed stream
> lives, each chunkMs tick linearly resamples the buffered host audio via `drainResampled`, and after 500ms without a fed stream the buffer is dropped and synth resumes; starvation only sends empty
> (the device keeps the descriptor armed, not preempted by silence); the 1s source-audio buffer cap drops the oldest to limit latency; on the UI side ScriptProcessor is wired to destination through a zero-gain mute (no wiring, no callback;
> a direct connection would feed the local microphone back out through the speakers); `Peripheral.acceptCapture(CaptureChunk)` is an additively optional
> member in §6.2 (backward compatible), with zero QEMU device changes (reusing the P3.1 reverse channel).
> Design points: bidirectional sockets use a GLib watch for reading + length-prefixed frames (the device side is an ordered scanner rather than a full
> JSON parser, so field order is part of the protocol contract); the injection queue is 256KB per controller, and overflow drops the oldest to keep latency low; RX clock
> decoding reuses the TX formulas (the RX half of SAMPLE_RATE_CONF), and APLL remains a documented gap;
> `PeripheralContext.emitInput` is an additively optional member in §6.2 (backward compatible), with local capture and the waveform panel
> left to P3.2/P3.3 respectively.

> P3.3 verification record (2026-09-07): `pnpm typecheck` 0 errors; full-repo tests on Windows 399 passed + 11 skipped
> (gated e2e), WSL shell full run (including all real QEMU e2e) 151 passed + 5 skipped. Verified in two layers — UI pure
> logic layer, 13 `wavegenDraft` unit tests (draftFromProps defaults/clamping fallback delegated to the mic model's own
> micConfigFromProps, draftPatch with exactly six editable keys excluding bus/chunkMs, lossless patch round trip,
> previewTrace determinism/bounded amplitude/single-cycle sine full swing/square wave with only two tracks/noise varied and bounded/silence all zeros/
> higher frequency means more zero crossings within the fixed 5ms window; renderWavePreview canvas binding: background + zero line + all-point polyline,
> out-of-range amplitude clamped into the canvas, degenerate input drawing only the background and zero line, silent return without a 2d context) + 4
> projectStore.updatePeripheralProps unit tests (patch merging preserving existing props, pure-logic editing leaving the layout
> identity unchanged and the netlist still passing validateNetlist, no-op for an unknown instanceId, props persisted through the netlist.json
> serialization half); the end-to-end consumption chain is frozen by the existing mic-i2s e2e — the props shape written by the panel
> (`{waveform, freqHz, amplitude, sampleRate, ...}`) is exactly the same netlist shape in which that e2e verified on real breadesp QEMU
> that the firmware reads injected samples; mic-i2s/mic-capture/spi-st7789/pwm-buzzer/
> i2s-speaker/gpio-scope/sim-speed/netlist-routing/dbus-device e2e all
> regressed green against the same binary.
> Design points: the waveform generator panel introduces no new IPC — edits go through `projectStore.updatePeripheralProps`
> merged into the instance netlist props (pure-logic editing, layout identity unchanged), and a netlist identity change triggers App's existing
> `bb:applyNetlist` effect to atomically rebuild the mic instance and take effect; unlike capture (P3.2, a pure runtime override), generator
> configuration is persisted with netlist.json. All panel normalization is delegated to the model's exported
> `micConfigFromProps`/`waveformSample`/`MIC_LIMITS` (single source of truth; the UI never offers a configuration the model would reject);
> while capture is active the card shows "LIVE capture is overriding the synth waveform".
> Zero QEMU device changes.

> P3.4 verification record (2026-09-11): `pnpm typecheck` 0 errors; full-repo tests on Windows 448 passed + 13 skipped
> (gated e2e), WSL shell full run (including all real QEMU e2e) 168 passed + 5 skipped (existing baseline:
> gdb-breakpoint×2/debug-panel×1 require BREADESP_GDB_BIN, qemu-uart×2 gated on the Windows QEMU manifest). Verified in four layers — the knob model 15 unit tests (props clamping fallback, Gray phase table,
> per-pin assertions for the four transitions of a single detent, CCW reverse order, net merging of mixed directions, repeated clicks clamped to ±64 detents,
> one-time warning for an unwired pin without affecting the other pin, one-time warning without a drivePin channel, dispose stopping the queue,
> factory metadata); the sht30 model 21 unit tests (props validation, CRC-8 against the datasheet 0xBEEF→0x92
> worked example, the 25°C/50% golden vector [0x66,0x66,0x93,0x80,0x00,0xA2], range endpoints without overflow,
> six measurement command words, status register heater bit tracking and soft reset, filtering of wrong address/read transactions/mixed/sub-word-length,
> one-time warning in periodic mode, one-time warning without an injection channel, text snapshot, formatted lines); routing/protocol layer,
> NetlistResolver 28 items (newly added resolveGpioInput bidirectional wire order/unwired/non-GPIO tracks/rebuild) and
> DBusChannel 14 items (the three reverse frame kinds gpio-in/i2c-out/i2s-in frozen as exact strings with field order);
> PeripheralManager 25 items (driveRotate→gpio-in injection sequence, driveInput push button path injection,
> [BB-205] one-time warning for unwired, silent dropping of rotate-less instances, stopping rotation mid-way when the netlist changes);
> IPC contract 23 items (per:rotateKnob registration alignment + [BB-204] validation, per:driveInput [BB-203]
> validation); UI layer, sensorDraft 7 items (stepping/default fallback/invalid props normalization/range saturation/fractional readings).
> The real QEMU e2e (knob-gpio/sht30-i2c, Linux breadesp QEMU rebuilt by Docker) passed on WSL:
> knob.elf polls GPIO_IN, decodes +2 detents and prints `KNOB CW`, returns to zero and prints
> `KNOB ZERO` (the quadrature sequence is merged into the IN shadow read via gpio-in injection); sht.elf sends the 0x2C06 measurement
> command and then retries the read, reading the model's 25°C/50%RH six-byte reply and printing `SHT OK` (the i2c-out
> mailbox supplied via sniffer_recv); mic-i2s/mic-capture/spi-st7789/pwm-buzzer/i2s-speaker/
> gpio-scope/sim-speed/netlist-routing/dbus-device e2e all regressed green against the same rebuilt binary.
> The golden firmware `knob.elf`/`sht.elf` is deterministically generated by `scripts/make-knob-elf.mjs`/`make-sht-elf.mjs`
> (xtensa-elf.mjs gained add/sub encoding, cross-checked against the pinned decoder table),
> and `--check` mode validates that the committed fixture has not drifted.
> Iteration caught and fixed one real defect: applyNetlist created instances before swapping routing, and the knob's construction-time steady-state
> synchronous drive was resolved into the old routing and dropped — changed to build routing in a temporary resolver first, have instance construction reference it, and
> commit atomically only after everything succeeds (unit tests freeze the construction-time injection assertion). Design points: the stock esp32.gpio is a
> strap-only stub (no qdev input lines), so gpio-in injection can only merge IN/IN1 read values on the shadow read path; GPIO edge interrupts are not modeled
> (input firmware polls); esp32_i2c's READ executes synchronously inside TRANS_START, so a read reply cannot round-trip within the same transfer, hence the device side is an atomically replaced mailbox keyed by (bus,addr) +
> firmware retry convergence (the golden firmware retries at most 250 times). The reverse channel was generalized into three kind-discriminated frames
> (i2s-in/gpio-in/i2c-out), and PRD §6.7 was appended accordingly; `PeripheralContext.drivePin` and
> `Peripheral.rotate` are additively optional members in §6.2 (backward compatible), and sendInject serializes field by field per kind
> (field order is the protocol contract, ruling out the class of accidents like the P3.1 lost-kind bug). The button's GPIO injection TODO
> closes along with driveInput being really wired through (the device-side path for the M1 checklist "push button injection" item exists from this point on).

> P4.1 verification record (2026-09-12): `pnpm typecheck` 0 errors; full-repo tests on Windows 464 passed + 13 skipped
> (11 gated breadesp device-build e2e + 2 GDB environment-gated; compared with the P3.4 baseline, the two qemu-uart cases
> turned into real executions this time as the local QEMU manifest became available). Verified in four layers —
> sim-core args/elf 22 unit tests (-machine exact-value assertions for esp32/esp32s3/esp32c3/esp32c6,
> qemuSystemForChip family mapping xtensa|riscv32, EM_RISCV accepted for both c3/c6, Xtensa golden fixtures
> rejected for c3/c6 with the error message naming the chip); netlist schema 10 items (all four chips pass
> validateNetlist); shell ProjectManager 20 items ([BB-101] accept/reject paths for c6);
> the real QEMU e2e (s3-machine.e2e.test.ts) 3 items — blink.elf through the same QemuRunner path
> prints `Hello ESP32\r\n` under `-machine esp32`, s3-blink.elf prints `Hello ESP32-S3\r\n` under `-machine esp32s3`,
> and an Xtensa binary asked to run the esp32c3 machine makes QEMU exit immediately with runner status='error' (F-SIM-4 no hang). The golden firmware `s3-blink.elf` is
> deterministically generated by `scripts/make-blink-elf.mjs --chip esp32s3` (LX6/LX7 encoding identical,
> only the UART/GPIO/IRAM base addresses per chip table; the S3 base addresses verified by real QEMU boot), and `--check`
> mode validates that both fixtures blink.elf and s3-blink.elf have not drifted.
> Design points: espressif/qemu distributes two system simulators by CPU family — esp32/esp32s3 (Xtensa
> LX6/LX7) in qemu-system-xtensa, and esp32c3/esp32c6 (RISC-V) requiring qemu-system-riscv32
> (GitHub was unreachable on the day of verification and the binary could not be fetched, leaving C3/C6 real boot e2e for after integration);
> `qemuSystemForChip()` exports the family mapping for binary resolution, and wrong family combinations fail immediately on the QEMU side with
> "no machine found" (e2e case 3 freezes this behavior). Extending ChipKind with esp32c6
> is a §6.5 contract extension, with the PRD and code committed in the same commit; the chip types in shell/ui converge to
> `@breadesp/netlist`'s ChipKind (eliminating three hand-written union drift points).

> P4.2 verification record (2026-09-12): `pnpm typecheck` 0 errors; full-repo tests on Windows 488 passed
> + 13 skipped (gated e2e, same P4.1 baseline; a net increase of 24 over P4.1). Verified in three layers —
> netlist template layer, 9 unit tests (registry order and non-empty metadata, every template × every supported chip
> producing artifacts that pass validateNetlist/validateLayout with both halves referencing the same instance set, blink-led across all chips
> wiring mcu GPIO2→led-1.A, oled-ssd1306 per-chip I2C0 default pin tables esp32=21/22,
> s3/c3=8/9, c6=6/7, unknown templates and unsupported chips rejected, listTemplates defensive copying,
> templatesForChip filtering preserving order); shell layer, ProjectManager 6 items (template+chip written to disk and returning the
> validated ProjectData, zero drift between the return value and disk, OLED template c6 pins, no options keeping the
> old esp32/empty behavior, unknown template/out-of-range chip [BB-125] both validated before writing, options still
> [BB-124] rejecting overwrite) and IPC contract 3 items (proj:new carrying chip/template pass-through and returning
> ProjectData, old calls without options compatible, 7 malformed payloads rejected with [BB-126] without reaching
> ProjectManager); UI layer, wizardDraft 6 items (default esp32/empty, template list filtered by chip,
> patch merging preserving supported templates across chips, falling back to 'empty' when support is lost, an empty directory blocking
> Create, all chip×template combinations passing validation). Real QEMU e2e does not apply (this task does not touch
> the firmware loading chain); the netlist shape produced by templates (led/ssd1306 + GPIO/I2C wiring) is exactly
> the same shape that netlist-routing/dbus-device e2e has already verified on real breadesp QEMU.
> Design points: the template registry lives in `@breadesp/netlist` (same package and source as types/schema),
> so shell disk writes and the UI wizard share one source of truth; the `proj:new` payload is an additively optional §6.6 extension
> (chip?/template? defaulting to the old behavior), `newProject`'s return value was upgraded from void to validated
> ProjectData (backward compatible, the UI hydrates directly, and open and new go through the same loadProject path);
> ProjectToolbar's New now opens the ProjectWizard modal (directory pre-filled from the toolbar input).

> P4.3 verification record (2026-09-13): `pnpm typecheck` 0 errors; full-repo tests on Windows 543 passed
> + 13 skipped (gated e2e, same P4.2 baseline; a net increase of 55 over P4.2). Verified in four layers —
> ExternalProject scanning layer, 18 unit tests (platformio.ini env parsing including comments/CRLF/deduplication/
> bare [env]→env directory, the detection matrix: pio.ini taking precedence over the IDF dual flags, bare CMake without IDF signals rejected,
> sdkconfig or the project.cmake include as two recognition paths; scanning: union of declared envs and on-disk env directories,
> mtime newest→oldest sorting + path tiebreak, filtering non-.elf/nested directories/missing build root, empty candidates for unbuilt projects);
> ProjectManager 15 new items (41 total: link persisted to meta.external and preserved on reopen,
> archOk annotated by the project chip family (52-byte header read with padding), [BB-127] rejection with zero meta writes,
> [BB-124]/[BB-128] state errors, linked directory disappearing [BB-128], both default-newest and explicit-path imports,
> non-candidate path [BB-129], empty build [BB-129], wrong architecture [BB-101] without leaving firmware.elf,
> idempotent unlink, malformed external [BB-121], saveProject rewriting meta preserving the association);
> IPC contract 5 new items (31 total: four-channel registration alignment, routing pass-through, 8 malformed payloads [BB-130]
> rejected without reaching ProjectManager); external-firmware.integration 3 cases through the real
> preload→handlers→ProjectManager chain (bidirectional JSON boundaries) — PlatformIO dual-env
> linking → rescan after rebuild discovers the new ELF → explicit import of the old env → persisted across reopen → scan turns into [BB-128] after unlink;
> ESP-IDF build/*.elf newest imported by default; [BB-127]/[BB-129]
> propagated across the boundary. UI layer 14 new items (143 total: externalDraft 11 items of labeling/formatting/
> import selection/summary rows + projectStore 3 items of external/firmwareElf hydration and reset).
> Real QEMU e2e does not apply (this task does not touch the simulation chain); the imported artifact firmware.elf reuses
> sim:load's [BB-101] architecture gating (that path has already been verified on real
> QEMU by qemu-uart/s3-machine e2e). PRD §F-PROJ-3 and the §6.6 proj:* channel list were synced (additive extension).
> Design points: the association records only {kind, dir} in meta.json (projects stay portable; external project paths are
> host-local state); the scanning module is pure disk reading with zero writes; the explicit import path must be one of the current scan candidates
> (ruling out copying arbitrary files through this channel); archOk is only a hint, and the real gate remains the
> validateFirmware at import time.
> Iteration exposed and fixed two development-time issues: ① a test fixture bug — makePioProject wrote platformio.ini before creating
> the root directory, causing 7 ENOENT cases (fixed the helper order, not product code);
> ② a UI type seam — externalDraft referenced ExternalProjectKind which bridge.ts did not export;
> typecheck caught it and the export was added. Self-review restored one coverage gap: a regression test for saveProject preserving the
> external association when rewriting meta.

> P4.4 verification record (2026-09-15): `pnpm typecheck` 0 errors; full-repo tests on Windows 555
> passed + 13 skipped (gated e2e, same P4.3 baseline; a net increase of 12 over P4.3). Verified in three layers —
> GdbBridge 19 mock GDB/MI integration tests (4 new: -break-insert -c conditional insertion with
> -break-list reading back cond, -break-condition setting/clearing conditions including the [BB-113] unknown-number error path,
> write/read/access three -break-watch insertions with watchpoint rows read back, watchpoints and
> breakpoints sharing -break-delete removal, multi-word expression MI quoting wire format frozen); mock-gdb
> extended to the real GDB wire shape (-break-insert optional -c parsing, -break-watch returning
> wpt/hw-rwpt/hw-awpt result keys by mode, -break-list watchpoint rows carrying the expression in what,
> -break-condition set/clear); IPC contract 35 items (4 new: dbg:setConditionalBreakpoint/
> dbg:setWatchpoint/dbg:conditionBreakpoint routing with mode defaulting to write, 8 malformed payloads
> [BB-131] rejected without reaching GDB); debuggerStore 15 items (4 new: conditional breakpoint/watchpoint
> actions forwarding payloads and reading back the list, condition clearing round trip, the bridge error surface not polluting breakpoint state).
> UI layer: the Inspector adds a condition input (If) and a Watchpoints section (expression + write/read/
> access modes), with watch/if (…) rendered inline in the breakpoint list.
> Real QEMU e2e does not apply (this task does not touch the QEMU device or the firmware loading chain); GDB/MI dialect
> changes are frozen to the real wire shape via the extended mock, and the existing GDB-gated e2e (gdb-breakpoint/
> debug-panel, requiring BREADESP_GDB_BIN + real QEMU) re-verify the shared session path when the toolchain is present
> (the most recent P1.9 verification passed on WSL with the real xtensa-esp32-elf-gdb).
> Design points: watchpoint stops reuse the existing dbg:stopped push (reason being
> watchpoint-trigger and two other states), with zero new push channels; BreakpointRow's kind/cond are
> additive extensions (§6.6 compatible, old consumers ignore the new fields); the -break-condition expression is a
> trailing argument (GDB semantics), and an empty string clears the condition.

> P4.5 verification record (2026-09-18): `pnpm typecheck` 0 errors; full-repo tests on Windows
> 581 passed + 14 skipped (gated e2e; the shell package with BREADESP_GDB_BIN set: 250 passed +
> 12 skipped). Verified in four layers — DAP frame protocol 9 unit tests (Content-Length round trip, byte-level
> chunking/frame joining, unknown headers and case tolerance, UTF-8 byte counting, partial frame buffering, missing header/non-numeric
> Content-Length [BB-132] rejection); GdbBridge 24 mock integration tests (5 new:
> stackFrames parsing `-stack-list-frames`, stepOut/-exec-finish function-finished stop,
> interrupt/-exec-interrupt signal-received stop, removeBreakpoints batch -break-delete,
> env pass-through of XTENSA_GNU_CONFIG into the subprocess); DAP session 12 integration tests (mock GDB/QEMU dual seams, in-memory transport + TCP socket
> dual modes: initialize→attach→function breakpoint→configurationDone→threads/stackTrace/
> scopes/variables/evaluate full chain, complex-typed variables falling back through evaluate, breakpoint set
> wholesale replacement wire format frozen, GDB ^error degrading to verified=false, protocol misuse/[BB-132]/
> unknown command/unknown variablesReference all returning readable error responses, stopOnEntry reporting an entry
> stop without auto-continuing, launch mode spawning mock QEMU with disconnect reclaiming the VM, malformed
> frames terminating the session; plus XtensaDynconfig 3 items: selecting ../lib/xtensa_<chip>.so per chip,
> returning undefined for RISC-V/missing library, user settings taking precedence); real QEMU + esp-gdb 17.1 e2e
> (dap-launch.e2e.test.ts) — launch→function breakpoint app_main hit→stackTrace two frames
> →register pc→evaluate $pc→stepIn→UART output→disconnect terminateDebuggee,
> the whole chain passing; the existing gdb-breakpoint e2e (P0.5 acceptance) passed for the first time on a native Windows
> machine in the same environment. Zero changes to the golden firmware and the QEMU device.
> Self-iteration caught and fixed four real issues: ① stackFrames() missed the single-key `frame={...}` wrapper of the MI result list
> (isomorphic to -break-list's bkpt, caught by unit tests); ② threads
> missed an initialization gate (exposed by a misuse test); ③ **esp-gdb 17.1 and the QEMU stub register layout
> mismatch** — the built-in 388-byte 'g' packet against a 628-byte reply reports "Remote 'g' packet
> reply is too long", RSP probes confirmed the stub offers no tdesc negotiation and the toolchain ships no XML,
> which finally located esp-gdb 17.x's dynconfig mechanism (`XTENSA_GNU_CONFIG` pointing at
> `lib/xtensa_<chip>.so`), pushed down into GdbBridge via `XtensaDynconfig.ts` (automatically selected per
> chip, benefiting both dbg:connect and DAP, with `QemuRunner.getChip()` added; the existing gdb-breakpoint e2e thus turned green on this machine for the first time); ④ the first stop without a reason when attaching to a frozen VM must be consumed before waiting for a breakpoint hit (real GDB behavior, caught by e2e).
> Design points: in launch mode QemuRunner stays loaded throughout, and continue goes through GDB
> `-exec-continue` (the stub resumes the vCPU) rather than QMP cont — double resuming would tear the stop/run state between GDB and
> the VM; QEMU stdout is forwarded via the backend as stdout-class output events;
> the DAP protocol adds zero new runtime dependencies (§5 unchanged), and PRD §7 directories were synced with the dap/ four files and
> XtensaDynconfig.ts; the usage documentation is docs/dap.md.

### M2 Checklist
- [x] TFT renders rgb565 color images
- [x] The buzzer sounds at the PWM frequency
- [x] The speaker plays an I2S sine wave
- [x] The oscilloscope shows GPIO waveforms
- [x] The simulation can be paused/resumed/speed-adjusted

### M3 Checklist
- [x] After microphone injection the firmware reads samples
- [x] Local microphone real-time input works
- [x] The waveform generator can select sine/square/noise

### M4 Checklist
- [x] The same project runs on ESP32 and ESP32-S3
- [x] The PlatformIO project's `build/*.elf` is discovered automatically
- [x] Conditional breakpoints/watchpoints work
- [x] DAP integrated into VS Code for debugging

> M4 verification record (2026-09-30): the tick for "the same project runs on ESP32 and ESP32-S3" is based on
> P4.1's real QEMU e2e (s3-machine.e2e.test.ts, gated by `BREADESP_QEMU_BIN`) 3 items —
> blink.elf through the same QemuRunner path printing `Hello ESP32\r\n` under `-machine esp32`,
> s3-blink.elf printing `Hello ESP32-S3\r\n` under `-machine esp32s3`, and the wrong family combination
> (an Xtensa binary running the esp32c3 machine) making QEMU exit immediately with status='error', frozen by case 3
> (see the P4.1 verification record, 2026-09-12).

### M5 Checklist
- [x] After a third-party package calls `registerPeripheral()` a new part appears in the UI automatically
- [x] The peripheral packaging scaffold can generate publishable packages
- [x] Docs site and tutorials online (`pnpm docs:build` / `docs:serve`; bilingual: Chinese pages on root routes,
  English pages under the `en/` prefix; 6 Chinese + 6 English tutorials, 13 pages per language, 26 total; link
  integrity gating)

---

## Appendix A: Quick Reference for Common Commands

```bash
# 初始化
pnpm install
pnpm fetch-qemu

# 日常
pnpm typecheck
pnpm test
pnpm dev

# 单包
pnpm --filter @breadesp/peripherals test

# Lint（M0 配置后）
pnpm lint
pnpm format
```

## Appendix B: References
- QEMU-ESP32: https://github.com/espressif/qemu
- ESP-IDF: https://docs.espressif.com/projects/esp-idf/
- GDB Machine Interface: https://sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI.html
- Conventional Commits: https://www.conventionalcommits.org/
- Wokwi (competitor reference): https://wokwi.com/
