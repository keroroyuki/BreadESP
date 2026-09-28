---
title: 01 · 快速上手
description: 安装 BreadESP、拉取 QEMU 二进制、启动应用并认识界面。
---

# 01 · 快速上手

> 本教程带你在本机跑起 BreadESP，并认识主界面的每个区域。约 10 分钟。

## 环境要求

- **Node.js ≥ 20**、**pnpm ≥ 9**。
- 桌面平台：Windows / macOS / Linux。
- 可选：`xtensa-esp-elf-gdb`（esp-gdb 17.x，调试功能用，见 [调试工作流](03-debugging.md)）。

## 安装与启动

```bash
pnpm install       # 安装 workspace 依赖
pnpm fetch-qemu    # 下载 QEMU-ESP32 二进制到 packages/sim-core/bin/（按需，不入库）
pnpm dev           # 启动 Electron 开发壳（主进程 + Vite 渲染进程）
```

`pnpm fetch-qemu` 会按当前宿主平台解析固定的 espressif/qemu release 资产并校验
SHA-256 后解压；二进制永不入库（PRD §5、§10.6）。

启动后应用窗口分为四个区域：

| 区域 | 内容 |
|---|---|
| 顶栏 | 工程工具条（New/Open/Save/Save as/Close）、外部工程关联、仿真控制（Start/Pause/Resume/Reset + 0.1x–10x 倍率） |
| 左列 | Palette 器件面板（可拖拽的内建外设）+ Peripheral catalog（本地外设目录） |
| 中央 | 面包板画布（拖放器件、pin→pin 连线；左侧固定 MCU 节点） |
| 右侧 | Inspector 调试面板（断点/变量/寄存器/观察点） |
| 底部 | SerialConsole 串口、ScreenView 屏幕视图、Oscilloscope 示波器、WaveGen 波形面板 |

## 验证安装（可选）

```bash
pnpm typecheck   # 全仓类型检查
pnpm test        # 全仓测试（含真实 QEMU 的门控 e2e，无二进制时自动跳过）
```

## 下一步

- [02 · 首个工程：点亮的 LED](02-first-project.md) — 从新建工程到 LED 随固件亮灭。
- 界面各面板的深入用法见 [04 · 内建外设参考](04-peripherals.md)。

## 常见问题

- **`pnpm dev` 提示找不到 QEMU**：先跑 `pnpm fetch-qemu`；或用环境变量
  `BREADESP_QEMU_BIN` 指向已有的 `qemu-system-xtensa`。
- **调试器连不上**：需要 esp-gdb 17.x 并设 `BREADESP_GDB_BIN`；esp-gdb 17.x 与 QEMU
  stub 的寄存器布局差异由 Bridge 自动经 `XTENSA_GNU_CONFIG` 修正（见
  [DAP 适配器指南](../dap.md) 的前置条件一节）。
- **仿真不是实时的**：BreadESP 使用逻辑时钟（QEMU 虚拟时间），不保证与墙钟对齐
  （PRD §4.3）；音频类外设单独走真实采样率时钟。
