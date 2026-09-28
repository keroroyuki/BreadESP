---
title: 03 · 调试工作流
description: GDB 调试面板：断点、单步、变量与寄存器、条件断点与观察点。
---

# 03 · 调试工作流

> BreadESP 的调试链路：QEMU 以 `-S` 冻结启动并暴露 GDB stub，Bridge 的
> `GdbBridge` 用 GDB/MI 附着，UI 调试面板经 `dbg:*` IPC 驱动（架构见
> [architecture.md §4](../architecture.md)）。本教程用 `blink.elf` 演示完整流程。

## 0. 前置条件

- 安装 **esp-gdb 17.x**（ESP-IDF 工具链自带 `xtensa-esp-elf-gdb`），并把路径设给
  环境变量 `BREADESP_GDB_BIN`。
- 无需手工配置寄存器布局：esp-gdb 17.x 的内建 Xtensa 布局与 espressif QEMU 的
  stub 不匹配（典型报错 `Remote 'g' packet reply is too long`），GdbBridge 会按芯片
  自动指向 `<gdb>/lib/xtensa_<chip>.so`（`XTENSA_GNU_CONFIG`；你显式设置的值优先）。

## 1. 附着调试器

1. 打开 [上一篇](02-first-project.md) 的工程（`blink.elf` 已导入），点 **Start**
   或直接保持 `loaded` 状态。
2. 在右侧 **Inspector** 面板点 **Connect**（`dbg:connect` 惰性附着——stub 端口与
   固件路径由主进程记忆，渲染进程无需关心）。
3. 状态机：`detached → attached ⇄ running`；异步停止经 `dbg:stopped` 推送到面板。

## 2. 断点与单步

- **函数断点**：在 Breakpoints 区输入 `app_main` 并添加——GDB/MI `-break-insert`
  会解析符号并落到函数入口地址。
- **地址断点**：输入 `*0x4008....` 形式的地址同样支持。
- **单步**：`Step`（进入，指令级 `-exec-step-instruction`）、`Step over`、
  `Continue`。停在断点上时面板显示停止帧（函数名/地址）。
- 断点列表支持删除单个、清空全部。

> `blink.elf` 自带手工构建的 DWARF4 调试信息：`app_main` 的局部变量在寄存器里，
> 全局变量 `led_state` 在内存里——两类位置都能真实读到。

## 3. 变量与寄存器

停止时面板自动刷新：

- **Locals**：`-stack-list-variables --simple-values` 的当前帧局部变量；
- **Registers**：`-data-list-register-names/values` 配对的完整寄存器组；
- **Watch**：输入任意表达式（如 `led_state`）经 `-data-evaluate-expression` 求值。

## 4. 条件断点与观察点（P4.4）

- **条件断点**：添加断点时填 **If** 表达式（如 `led_state == 1`），或对既有断点
  设置/清空条件（GDB/MI `-break-condition`）。
- **观察点**：Watchpoints 区输入表达式，选 `write`（默认）/`read`/`access` 模式
  （`-break-watch [-r|-a]`）。数据变化命中时以 `watchpoint-trigger` 停止，经同一条
  `dbg:stopped` 推送到达面板。
- 断点列表内联显示 `if (...)` 与 `watch` 标记。

## 5. 与仿真控制的关系

- 执行控制归 GDB：`Continue` 是 `-exec-continue`（stub 恢复 vCPU），不是 QMP `cont`。
- 未附着调试器时顶栏 `Step` 不可用（`[BB-105]` 提示先连接）；附着后 `sim:step`
  路由到指令级单步（PRD §F-SIM-1）。
- 不要对同一 VM 同时用 UI 调速/暂停与 DAP 调试（停走状态会撕裂，见
  [DAP 适配器指南](../dap.md)）。

## 下一步

- 用 VS Code 调试同一仿真：[06 · VS Code 调试（DAP）](06-vscode-dap.md)。
- 契约细节：[PRD §F-DBG](../../PRD.md) 与 [architecture.md §4](../architecture.md)。
