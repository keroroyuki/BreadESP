# BreadESP — ESP32 虚拟面包板仿真器

> 项目代号 BreadESP。本地运行的 ESP32 功能级仿真器，提供图形化外设搭建、真实固件烧录与 GDB 调试。
> 本仓库**全部由 AI 生成**。任何实现 MUST 以 [`PRD.md`](./PRD.md) 为唯一真相源。

## 快速开始

```bash
pnpm install
pnpm fetch-qemu        # 下载 QEMU-ESP32 二进制到 packages/sim-core/bin (PRD §5, §10.6)
pnpm dev               # 启动 Electron 开发壳
```

## 文档

- [PRD.md](./PRD.md) — 唯一真相源，AI 生成代码前必读
- [docs/dev-plan.md](./docs/dev-plan.md) — 开发计划、里程碑、代码风格、提交规范
- [docs/architecture.md](./docs/architecture.md) — 架构详解
- [docs/peripheral-sdk.md](./docs/peripheral-sdk.md) — 外设 SDK 开发指南
- [CHANGELOG.md](./CHANGELOG.md) — 变更记录

## 包结构

| 包 | 职责 |
|---|---|
| `packages/shell` | Electron 主进程 / Bridge（QEMU、GDB、外设管理、IPC） |
| `packages/ui` | React 渲染进程（面包板、调试面板、串口、屏幕） |
| `packages/peripherals` | 外设设备模型（运行于 Bridge） |
| `packages/netlist` | 网表 schema 与校验 |
| `packages/sim-core` | QEMU 二进制占位与启动参数构造 |

## AI Agent 约定（PRD §10）

- 代码改动前先读对应 PRD 章节，文件头注释 `// PRD: §X.Y`。
- 不得引入未列在 PRD §5 的运行时依赖。
- 接口（PRD §6）改动须向后兼容。
- 文件 MUST 落在 PRD §7 路径下。
- 不得放置二进制；QEMU 由 `scripts/fetch-qemu.mjs` 拉取。
