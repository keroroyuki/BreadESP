# BreadESP DAP Adapter Usage Guide (P4.5, PRD §F-DBG-6)

BreadESP ships a built-in **Debug Adapter Protocol (DAP)** adapter, so VS Code (or any
DAP client) can debug ESP32 firmware running in QEMU directly — sharing the same
QEMU gdb stub link as the built-in debug panel.

## Architecture

```
VS Code ──DAP(Content-Length 帧)── DapServer ── DapBackend
                                              ├─ launch: QemuRunner(-S) + GdbBridge
                                              └─ attach: GdbBridge → 已在跑的 stub
                                                           │
                                                 GDB/MI ───┘ → QEMU gdb stub
```

- `packages/shell/src/debugger/dap/DapProtocol.ts` — Content-Length frame encoding/decoding (hand-written, zero dependencies).
- `packages/shell/src/debugger/dap/QemuGdbBackend.ts` — launch/attach backend: launch mode brings up a frozen VM
  via `QemuRunner` (`-S`); attach mode connects to an existing stub (e.g. the simulation inside the Electron app).
- `packages/shell/src/debugger/dap/DapServer.ts` — DAP session: initialize/launch/attach,
  breakpoints (source + function + conditional), stackTrace/scopes/variables/evaluate, continue/step/next/
  stepOut/pause, disconnect/terminate.
- `packages/shell/src/debugger/dap/cli.ts` — entry point (stdio or `--port` TCP mode).

## Prerequisites

- `xtensa-esp-elf-gdb` (esp-gdb 17.x); pass its path in the launch argument `gdbBin` or set
  `BREADESP_GDB_BIN`. GdbBridge automatically selects the Xtensa dynconfig by chip
  (`XTENSA_GNU_CONFIG=<gdb>/lib/xtensa_esp32.so`) — the built-in register
  layout of esp-gdb 17.x does not match the espressif QEMU stub (`Remote 'g' packet reply is too long`),
  so the adapter fills it in automatically when it is unset; an explicitly set `XTENSA_GNU_CONFIG` takes precedence.
- launch mode also needs QEMU: the launch argument `qemuBin`, or the artifact produced by `pnpm fetch-qemu`.

## VS Code Integration

### Option A: `debugServer` (adapter started first, VS Code connects directly)

```bash
# 先启动 socket 模式适配器（仓库内）
node packages/shell/dist/debugger/dap/cli.js --port 4711
```

`.vscode/launch.json`:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "gdb",              // 任意能说裸 DAP 的 gdb 适配器扩展
      "request": "attach",
      "debugServer": 4711,        // VS Code 直接与本适配器对话
      "name": "BreadESP (socket)"
    }
  ]
}
```

### Option B: `debugAdapterExecutable` (VS Code launches the adapter, stdio)

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

In both options, launch/attach request parameters are passed by VS Code's extension layer or given manually in
`launch.json`'s `initializeArgs`/debug extension; the core parameters this adapter accepts:

| Parameter | launch | attach | Description |
|---|---|---|---|
| `elfPath` (or `program`) | Required | Required | Firmware ELF (symbol source); in launch mode it is also the `-kernel` |
| `chip` | Optional | Optional | `esp32`/`esp32s3`/`esp32c3`/`esp32c6`; default `esp32` |
| `qemuBin` | Optional | — | Resolved from the `packages/sim-core/bin/qemu.json` manifest by default |
| `gdbBin` | Optional | Optional | Defaults to `BREADESP_GDB_BIN` |
| `host` / `port` | — | port required | attach target gdb stub (host defaults to 127.0.0.1) |
| `stopOnEntry` | Optional | Optional | When `true`, configurationDone does not auto-resume |

launch and attach are mutually exclusive (only one per session).

## Behavioral Notes

- **Execution control belongs to GDB**: after a successful attach, continue is GDB/MI `-exec-continue` (the stub
  resumes the vCPU), not QMP `cont`. In launch mode QemuRunner stays in the `loaded` state throughout and only
  provides the UART stream and process reaping — using UI speed control/pause and DAP debugging on the same VM
  at the same time is an unsupported combination.
- **Stop reason mapping**: `breakpoint-hit→breakpoint`, `end-stepping-range/function-finished→step`,
  `*watchpoint-trigger→data breakpoint`, a reasonless stop from attaching to a frozen VM and
  `signal-received` (pause)→`pause`.
- **Breakpoint set semantics**: each source file's `setBreakpoints` deletes the old set before inserting the new
  one; positions that GDB rejects degrade to a `verified=false` line instead of failing the whole request.
  Conditional breakpoints use `-break-insert -c`.
- **UART**: QEMU stdout is forwarded as `output` events (category `stdout`); GDB's console/log
  streams are forwarded as `console`/`log`.
- **Local variables**: entries without a value in `-stack-list-variables --simple-values` (complex types)
  automatically fall back to `-data-evaluate-expression`, and show `<unavailable>` when still unavailable.

## Known Boundaries

- Single-thread view (threadId is always 1); stack frame ids are the MI level (0 = innermost frame).
- setVariable, restart, and exception breakpoints are not supported (explicitly declared as false/empty in capabilities).
- attach mode does not touch the peer process's lifecycle: `disconnect` only quits GDB by default; in launch mode
  `disconnect(terminateDebuggee=true)` also QMP-quits the VM.
