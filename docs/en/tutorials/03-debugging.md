---
title: 03 · Debugging Workflow
description: GDB debugging panel: breakpoints, stepping, variables and registers, conditional breakpoints, and watchpoints.
---

# 03 · Debugging Workflow

> BreadESP's debugging path: QEMU starts frozen with `-S` and exposes a GDB stub; the Bridge's
> `GdbBridge` attaches over GDB/MI, and the UI debugging panel is driven through `dbg:*` IPC (see
> [architecture.md §4](../architecture.md) for the architecture). This tutorial uses `blink.elf` to demonstrate the complete flow.

## 0. Prerequisites

- Install **esp-gdb 17.x** (the ESP-IDF toolchain ships `xtensa-esp-elf-gdb`), and set its path in the
  environment variable `BREADESP_GDB_BIN`.
- No manual register-layout configuration is needed: esp-gdb 17.x's built-in Xtensa layout does not match the espressif QEMU
  stub (the typical error is `Remote 'g' packet reply is too long`); GdbBridge automatically points to
  `<gdb>/lib/xtensa_<chip>.so` according to the chip (`XTENSA_GNU_CONFIG`; an explicit value you set takes precedence).

## 1. Attach the debugger

1. Open the project from [the previous tutorial](02-first-project.md) (`blink.elf` already imported), click **Start**,
   or just keep the `loaded` state.
2. In the **Inspector** panel on the right, click **Connect** (`dbg:connect` attaches lazily — the stub port and
   firmware path are remembered by the main process, so the renderer process does not need to care).
3. State machine: `detached → attached ⇄ running`; asynchronous stops are pushed to the panel via `dbg:stopped`.

## 2. Breakpoints and stepping

- **Function breakpoints**: enter `app_main` in the Breakpoints area and add it — GDB/MI `-break-insert`
  resolves the symbol and lands on the function entry address.
- **Address breakpoints**: addresses of the form `*0x4008....` are supported as well.
- **Stepping**: `Step` (step in, instruction-level `-exec-step-instruction`), `Step over`,
  `Continue`. When stopped at a breakpoint, the panel shows the stopped frame (function name/address).
- The breakpoint list supports deleting a single breakpoint and clearing all of them.

> `blink.elf` ships hand-built DWARF4 debug information: `app_main`'s local variables live in registers,
> while the global variable `led_state` lives in memory — both kinds of locations can be read for real.

## 3. Variables and registers

When stopped, the panel refreshes automatically:

- **Locals**: the current frame's local variables from `-stack-list-variables --simple-values`;
- **Registers**: the full register set paired from `-data-list-register-names/values`;
- **Watch**: enter any expression (e.g. `led_state`) to evaluate it via `-data-evaluate-expression`.

## 4. Conditional breakpoints and watchpoints (P4.4)

- **Conditional breakpoints**: fill in an **If** expression when adding a breakpoint (e.g. `led_state == 1`), or
  set/clear a condition on an existing breakpoint (GDB/MI `-break-condition`).
- **Watchpoints**: enter an expression in the Watchpoints area and choose the `write` (default)/`read`/`access` mode
  (`-break-watch [-r|-a]`). When a data change hits, it stops as a `watchpoint-trigger` and reaches the panel
  through the same `dbg:stopped` push.
- The breakpoint list shows `if (...)` and the `watch` marker inline.

## 5. Relationship with simulation controls

- Execution control belongs to GDB: `Continue` is `-exec-continue` (the stub resumes the vCPU), not QMP `cont`.
- When no debugger is attached, the top-bar `Step` is unavailable (`[BB-105]` prompts you to connect first); once attached, `sim:step`
  routes to instruction-level stepping (PRD §F-SIM-1).
- Do not use the UI speed control/pause and DAP debugging on the same VM at the same time (the stop-and-go state will tear; see
  the [DAP adapter guide](../dap.md)).

## Next steps

- Debug the same simulation with VS Code: [06 · VS Code Debugging (DAP)](06-vscode-dap.md).
- Contract details: [PRD §F-DBG](../PRD.md) and [architecture.md §4](../architecture.md).
