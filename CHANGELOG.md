# Changelog

All notable changes to BreadESP are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), adhering to [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Project skeleton: monorepo (netlist, peripherals, sim-core, shell, ui) with PRD-driven contracts.
- PRD.md as single source of truth (§1–§11).
- docs/dev-plan.md — development plan, milestones, code style, commit conventions.
- docs/architecture.md, docs/peripheral-sdk.md.
- MVP peripheral models: led, button, ssd1306 (st7789/buzzer/speaker/mic stubs).
- GDB/MI parser + GdbBridge scaffold.
- QemuRunner + sim-core args builder.
- fetch-qemu.mjs real download: per-host release asset resolution, SHA-256 chain (pinned manifest -> official checksum -> archive), system-tar extraction. Pinned espressif/qemu `esp-develop-9.2.2-20260417`.
- feat(sim-core): golden firmware `packages/sim-core/fixtures/blink.elf` (P0.3) — deterministic Xtensa ELF built by `scripts/make-blink-elf.mjs` (no toolchain needed; encodings verified against the pinned QEMU's core-esp32 decoder tables). Prints `Hello ESP32\r\n` on UART0 and toggles GPIO2 forever; verified live under `qemu-system-xtensa -M esp32 -kernel`. Fixture-invariant tests added (`tests/blink-elf.test.ts`).
- fix: remove dead skeleton code across peripherals/ui/shell so `pnpm typecheck` passes (unused fields/imports, Fragment mismatch, wrong store import path); add minimal netlist validation unit tests.
- QemuRunner real `load`/`start` lifecycle (P0.4): `load()` spawns QEMU frozen (`-S`) with an ephemeral loopback QMP listener and pre-flight input validation (`[BB-1xx]` errors); `start()` resumes via QMP `cont`; stdout is decoded (UTF-8, chunk-safe) and re-emitted as `uart` events (PRD §F-SER-1). QmpClient implements the QMP handshake/request protocol over loopback TCP (Node cannot reach AF_UNIX sockets on Windows).
- Shell test harness: vitest + QMP unit tests, mock-subprocess QemuRunner lifecycle tests, and a real-QEMU end-to-end (`tests/qemu-uart.e2e.test.ts`) asserting the P0.4 acceptance — `blink.elf` boots and UART prints `Hello ESP32`.
- GdbBridge real GDB/MI implementation (P0.5): spawns `xtensa-esp32-elf-gdb --interpreter=mi2`, attaches to QEMU's loopback gdb stub (`-target-select remote`), and drives tokenized `-break-insert` / `-break-delete` / `-exec-continue` / `-exec-step-instruction` with per-command deadlines and readable `[BB-11x]` errors; breakpoint/step halts surface as typed `stopped` events (`reason`, `frame.func`, `bkptno`). MiParser upgraded to the full MI value grammar (nested tuples, value/result lists, C-string escapes). Covered by MiParser unit tests, mock GDB/MI subprocess integration tests (dev-plan §7.2) and an e2e (`tests/gdb-breakpoint.e2e.test.ts`): a QEMU RSP stub smoke test plus the literal P0.5 acceptance — `setBreakpoint('app_main')` + continue stops GDB at `app_main` — skipped until `BREADESP_GDB_BIN` points at xtensa GDB (verified offline at RSP level: `Z0,app_main` → continue → PC == app_main).

### Fixed
- sim-core args: `load()` now actually freezes the VM (`-S`), so no guest code runs before QMP `cont` or a GDB `continue` — previously the guest reached `app_main` before a debugger could arm breakpoints; the GDB stub now binds `127.0.0.1` only (PRD §9).

### Fixed
- sim-core args: boot the firmware via `-kernel`; the pinned espressif QEMU build rejects `-drive if=mtdblock` ("unsupported bus type"), which made every launch exit before the guest ran. Adds an optional QMP loopback listener arg (`-qmp tcp:127.0.0.1:<port>`).

### Notes
- QEMU binary fetched on demand via scripts/fetch-qemu.mjs (no binary in repo).
