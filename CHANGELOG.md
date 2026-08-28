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

### Fixed
- sim-core args: boot the firmware via `-kernel`; the pinned espressif QEMU build rejects `-drive if=mtdblock` ("unsupported bus type"), which made every launch exit before the guest ran. Adds an optional QMP loopback listener arg (`-qmp tcp:127.0.0.1:<port>`).

### Notes
- QEMU binary fetched on demand via scripts/fetch-qemu.mjs (no binary in repo).
