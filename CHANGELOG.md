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

### Notes
- QEMU binary fetched on demand via scripts/fetch-qemu.mjs (no binary in repo).
