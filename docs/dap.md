# BreadESP DAP 适配器使用指南（P4.5，PRD §F-DBG-6）

BreadESP 内置一个 **Debug Adapter Protocol (DAP)** 适配器，使 VS Code（或任何
DAP 客户端）可以直接调试 QEMU 中运行的 ESP32 固件——与内置调试面板共用同一条
QEMU gdb stub 链路。

## 架构

```
VS Code ──DAP(Content-Length 帧)── DapServer ── DapBackend
                                              ├─ launch: QemuRunner(-S) + GdbBridge
                                              └─ attach: GdbBridge → 已在跑的 stub
                                                           │
                                                 GDB/MI ───┘ → QEMU gdb stub
```

- `packages/shell/src/debugger/dap/DapProtocol.ts` — Content-Length 帧编解码（零依赖手写）。
- `packages/shell/src/debugger/dap/QemuGdbBackend.ts` — launch/attach 后端：launch 模式经
  `QemuRunner` 拉起冻结 VM（`-S`），attach 模式连到既有 stub（如 Electron 应用里的仿真）。
- `packages/shell/src/debugger/dap/DapServer.ts` — DAP 会话：initialize/launch/attach、
  断点（源码 + 函数 + 条件）、stackTrace/scopes/variables/evaluate、continue/step/next/
  stepOut/pause、disconnect/terminate。
- `packages/shell/src/debugger/dap/cli.ts` — 入口（stdio 或 `--port` TCP 模式）。

## 前置条件

- `xtensa-esp-elf-gdb`（esp-gdb 17.x），路径传给 launch 参数 `gdbBin` 或设
  `BREADESP_GDB_BIN`。GdbBridge 会自动按芯片选择 Xtensa dynconfig
  （`XTENSA_GNU_CONFIG=<gdb>/lib/xtensa_esp32.so`）——esp-gdb 17.x 的内建寄存器
  布局与 espressif QEMU 的 stub 不匹配（`Remote 'g' packet reply is too long`），
  缺省不设置时适配器自动补上；用户显式设置的 `XTENSA_GNU_CONFIG` 优先。
- launch 模式还需要 QEMU：launch 参数 `qemuBin`，或 `pnpm fetch-qemu` 产物。

## VS Code 接入

### 方式 A：`debugServer`（适配器先起，VS Code 直连）

```bash
# 先启动 socket 模式适配器（仓库内）
node packages/shell/dist/debugger/dap/cli.js --port 4711
```

`.vscode/launch.json`：

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

### 方式 B：`debugAdapterExecutable`（VS Code 负责拉起适配器，stdio）

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

两种方式下，launch/attach 请求参数由 VS Code 的扩展层传递或手工在
`launch.json` 的 `initializeArgs`/调试扩展里给出；本适配器接受的核心参数：

| 参数 | launch | attach | 说明 |
|---|---|---|---|
| `elfPath`（或 `program`） | 必填 | 必填 | 固件 ELF（符号源）；launch 模式同时是 `-kernel` |
| `chip` | 可选 | 可选 | `esp32`/`esp32s3`/`esp32c3`/`esp32c6`；缺省 `esp32` |
| `qemuBin` | 可选 | — | 缺省从 `packages/sim-core/bin/qemu.json` manifest 解析 |
| `gdbBin` | 可选 | 可选 | 缺省 `BREADESP_GDB_BIN` |
| `host` / `port` | — | port 必填 | attach 目标 gdb stub（host 缺省 127.0.0.1） |
| `stopOnEntry` | 可选 | 可选 | `true` 时 configurationDone 不自动 resume |

launch 与 attach 互斥（一个会话只能一次）。

## 行为要点

- **执行控制归 GDB**：attach 成功后 continue 是 GDB/MI `-exec-continue`（stub 恢复
  vCPU），不是 QMP `cont`。launch 模式下 QemuRunner 全程停留在 `loaded` 状态，只提供
  UART 流与进程回收——对同一 VM 同时用 UI 调速/暂停与 DAP 调试是不支持的组合。
- **停止原因映射**：`breakpoint-hit→breakpoint`、`end-stepping-range/function-finished→step`、
  `*watchpoint-trigger→data breakpoint`、附着冻结 VM 的无 reason 停止与
  `signal-received`（pause）→`pause`。
- **断点集合语义**：每个源文件的 `setBreakpoints` 先删旧集合再插新集合；GDB 拒绝的
  位置降级为 `verified=false` 行而不是让整个请求失败。条件断点走 `-break-insert -c`。
- **UART**：QEMU stdout 以 `output` 事件（category `stdout`）转发；GDB 的 console/log
  流转发为 `console`/`log`。
- **局部变量**：`-stack-list-variables --simple-values` 里无值的条目（复杂类型）自动
  回落到 `-data-evaluate-expression`，仍不可得时显示 `<unavailable>`。

## 已知边界

- 单线程视图（threadId 恒为 1）；栈帧 id 即 MI 层级（0 = 最内帧）。
- 不支持 setVariable、restart、异常断点（capabilities 中显式声明为 false/空）。
- attach 模式不碰对方进程的生命周期：`disconnect` 默认只退 GDB；launch 模式
  `disconnect(terminateDebuggee=true)` 会一并 QMP quit 掉 VM。
