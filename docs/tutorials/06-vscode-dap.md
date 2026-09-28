---
title: 06 · VS Code 调试（DAP）
description: 用 VS Code 经 DAP 适配器调试 BreadESP 仿真中的固件。
---

# 06 · VS Code 调试（DAP）

> BreadESP 内置 Debug Adapter Protocol 适配器（P4.5），VS Code（或任何 DAP
> 客户端）可以替代内置调试面板调试同一 QEMU 实例。完整参考见
> [DAP 适配器指南](../dap.md)，本文是上手口径。

## 0. 前置条件

- **esp-gdb 17.x**（`xtensa-esp-elf-gdb`）——设 `BREADESP_GDB_BIN` 或在调试配置里
  传 `gdbBin`；Xtensa 寄存器布局差异由适配器自动经 `XTENSA_GNU_CONFIG` 修正。
- launch 模式还需要 QEMU（`pnpm fetch-qemu` 产物，或配置里传 `qemuBin`）。
- 适配器以编译产物运行，先构建 shell：

```bash
pnpm --filter @breadesp/shell build
```

## 1. 接入方式 A：`debugServer`（适配器先起）

```bash
node packages/shell/dist/debugger/dap/cli.js --port 4711
```

`.vscode/launch.json`：

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

## 2. 接入方式 B：`debugAdapterExecutable`（VS Code 拉起，stdio）

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

## 3. 核心参数

| 参数 | launch | attach | 说明 |
|---|---|---|---|
| `elfPath`（或 `program`） | 必填 | 必填 | 固件 ELF（符号源；launch 同时是 `-kernel`） |
| `chip` | 可选 | 可选 | `esp32`/`esp32s3`/`esp32c3`/`esp32c6`，缺省 `esp32` |
| `qemuBin` | 可选 | — | 缺省解析 `packages/sim-core/bin/qemu.json` |
| `gdbBin` | 可选 | 可选 | 缺省 `BREADESP_GDB_BIN` |
| `host`/`port` | — | port 必填 | attach 目标 stub（host 缺省 127.0.0.1） |
| `stopOnEntry` | 可选 | 可选 | `true` 时入口即停，不自动续跑 |

## 4. 能做什么

- 源码断点 + 函数断点 + 条件断点（整组替换语义；GDB 拒绝的位置降级
  `verified=false` 而不是整个请求失败）；watchpoint 命中映射为 data breakpoint。
- `stackTrace`/`scopes`/`variables`/`evaluate`；复杂局部变量自动回落表达式求值。
- continue/next/stepIn/stepOut/pause；QEMU stdout 以 `output` 事件（stdout 类）
  转发进调试控制台。
- launch 模式 `disconnect(terminateDebuggee=true)` 会一并退出 VM；attach 模式
  `disconnect` 只退 GDB，不动对方进程。

## 5. 已知边界

- 单线程视图（threadId 恒为 1）；不支持 setVariable/restart/异常断点。
- 执行控制归 GDB（`-exec-continue` 而非 QMP `cont`）：launch 模式下不要同时对
  同一 VM 用应用 UI 调速/暂停。

## 下一步

- 内置调试面板用法：[03 · 调试工作流](03-debugging.md)。
- 适配器架构与完整行为要点：[DAP 适配器指南](../dap.md)。
