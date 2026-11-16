---
title: 06 · VS Code Debugging (DAP)
description: Use VS Code to debug firmware in the BreadESP simulation through the DAP adapter.
---

# 06 · VS Code Debugging (DAP)

> BreadESP ships a built-in Debug Adapter Protocol adapter (P4.5), so VS Code (or any DAP
> client) can replace the built-in debugging panel to debug the same QEMU instance. For the full reference see
> the [DAP adapter guide](../dap.md); this document is a getting-started guide.

## 0. Prerequisites

- **esp-gdb 17.x** (`xtensa-esp-elf-gdb`) — set `BREADESP_GDB_BIN` or pass `gdbBin` in the debug configuration;
  the Xtensa register-layout difference is corrected automatically by the adapter via `XTENSA_GNU_CONFIG`.
- launch mode also needs QEMU (the output of `pnpm fetch-qemu`, or pass `qemuBin` in the configuration).
- The adapter runs from the compiled output, so build the shell first:

```bash
pnpm --filter @breadesp/shell build
```

## 1. Access method A: `debugServer` (the adapter starts first)

```bash
node packages/shell/dist/debugger/dap/cli.js --port 4711
```

`.vscode/launch.json`:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "gdb",           // 任意能说裸 DAP 的调试扩展
      "request": "attach",
      "debugServer": 4711,
      "name": "BreadESP (socket)"
    }
  ]
}
```

## 2. Access method B: `debugAdapterExecutable` (launched by VS Code, stdio)

```jsonc
{
  "type": "gdb",
  "request": "launch",
  "debugAdapterExecutable": {
    "command": "node",
    "args": ["packages/shell/dist/debugger/dap/cli.js"]
  },
  "name": "BreadESP (stdio)"
}
```

## 3. Core parameters

| Parameter | launch | attach | Notes |
|---|---|---|---|
| `elfPath` (or `program`) | required | required | Firmware ELF (symbol source; for launch it is also `-kernel`) |
| `chip` | optional | optional | `esp32`/`esp32s3`/`esp32c3`/`esp32c6`, default `esp32` |
| `qemuBin` | optional | — | By default resolves `packages/sim-core/bin/qemu.json` |
| `gdbBin` | optional | optional | Defaults to `BREADESP_GDB_BIN` |
| `host`/`port` | — | port required | The stub to attach to (host defaults to 127.0.0.1) |
| `stopOnEntry` | optional | optional | When `true`, stops at entry and does not auto-continue |

## 4. What it can do

- Source breakpoints + function breakpoints + conditional breakpoints (whole-group replacement semantics; locations GDB rejects degrade to
  `verified=false` instead of failing the whole request); watchpoint hits are mapped to data breakpoints.
- `stackTrace`/`scopes`/`variables`/`evaluate`; complex local variables automatically fall back to expression evaluation.
- continue/next/stepIn/stepOut/pause; QEMU stdout is forwarded into the debug console as `output` events (stdout category).
- In launch mode, `disconnect(terminateDebuggee=true)` exits the VM as well; in attach mode,
  `disconnect` only exits GDB and leaves the other process alone.

## 5. Known limitations

- Single-threaded view (threadId is always 1); setVariable/restart/exception breakpoints are not supported.
- Execution control belongs to GDB (`-exec-continue` rather than QMP `cont`): in launch mode, do not simultaneously
  use the app UI speed control/pause on the same VM.

## Next steps

- Built-in debugging panel usage: [03 · Debugging Workflow](03-debugging.md).
- Adapter architecture and full behavior details: [DAP adapter guide](../dap.md).
