---
title: 01 · Quick Start
description: Install BreadESP, fetch the QEMU binaries, launch the app, and get to know the interface.
---

# 01 · Quick Start

> This tutorial walks you through running BreadESP on your machine and getting to know each area of the main window. About 10 minutes.

## Requirements

- **Node.js ≥ 22.12** and **pnpm ≥ 9**.
- Desktop platforms: Windows / macOS / Linux.
- Optional: `xtensa-esp-elf-gdb` (esp-gdb 17.x, used for debugging; see [Debugging Workflow](03-debugging.md)).

## Install and launch

```bash
pnpm install       # 安装 workspace 依赖
pnpm fetch-qemu    # 下载 QEMU-ESP32 二进制到 packages/sim-core/bin/（按需，不入库）
pnpm dev           # 启动 Electron 开发壳（主进程 + Vite 渲染进程）
```

`pnpm fetch-qemu` resolves the pinned espressif/qemu release asset for the current host platform, verifies its SHA-256, and then unzips it; the binaries are never committed (PRD §5, §10.6).

Once launched, the app window is divided into four areas:

| Area | Contents |
|---|---|
| Top bar | Project toolbar (New/Open/Save/Save as/Close), external project linking, simulation controls (Start/Pause/Resume/Reset + 0.1x–10x rate) |
| Left column | Palette part panel (drag-and-droppable built-in peripherals) + Peripheral catalog (local peripheral catalog) |
| Center | Breadboard canvas (drag and drop parts, pin→pin wiring; the MCU node is pinned on the left) |
| Right | Inspector debugging panel (breakpoints/variables/registers/watchpoints) |
| Bottom | SerialConsole serial port, ScreenView screen view, Oscilloscope, WaveGen waveform panel |

## Verify the installation (optional)

```bash
pnpm typecheck   # 全仓类型检查
pnpm test        # 全仓测试（含真实 QEMU 的门控 e2e，无二进制时自动跳过）
```

## Next steps

- [02 · First Project: A Lit LED](02-first-project.md) — from creating a project to the LED lighting up and going dark with the firmware.
- For in-depth usage of each panel, see [04 · Built-in Peripherals Reference](04-peripherals.md).

## FAQ

- **`pnpm dev` reports that QEMU cannot be found**: run `pnpm fetch-qemu` first; or point the environment variable
  `BREADESP_QEMU_BIN` at an existing `qemu-system-xtensa`.
- **The debugger will not connect**: you need esp-gdb 17.x and must set `BREADESP_GDB_BIN`; the register-layout difference between esp-gdb 17.x and the QEMU
  stub is corrected automatically by the Bridge via `XTENSA_GNU_CONFIG` (see
  the prerequisites section of the [DAP adapter guide](../dap.md)).
- **The simulation is not real-time**: BreadESP uses a logical clock (QEMU virtual time) and does not guarantee alignment with wall-clock
  time (PRD §4.3); audio peripherals use a separate real sampling-rate clock.
