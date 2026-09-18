# BreadESP 开发计划与规范

> 本文件是 BreadESP 项目的**执行手册**，配合 [`PRD.md`](../PRD.md)（需求真相源）使用。
> PRD 回答"做什么"，本文件回答"怎么做、按什么顺序、按什么规范"。
> AI Agent 在开始任一开发任务前 MUST 同时阅读 PRD 对应章节与本文件对应阶段。

---

## 目录
1. [总体策略](#1-总体策略)
2. [里程碑与阶段划分](#2-里程碑与阶段划分)
3. [分阶段开发步骤](#3-分阶段开发步骤)
4. [代码风格规范](#4-代码风格规范)
5. [Git 提交规范](#5-git-提交规范)
6. [分支与发布流程](#6-分支与发布流程)
7. [测试规范](#7-测试规范)
8. [文档规范](#8-文档规范)
9. [AI Agent 协作规范](#9-ai-agent-协作规范)
10. [注意事项与风险点](#10-注意事项与风险点)
11. [环境与工具链](#11-环境与工具链)
12. [验收检查清单](#12-验收检查清单)

---

## 1. 总体策略

### 1.1 核心原则
- **PRD 优先**：任何实现冲突以 PRD 为准；需求变更先改 PRD 再改代码。
- **垂直切片**：每个阶段交付一条"端到端可演示"的最小链路，而非按层横切。
- **契约先行**：接口（PRD §6）先冻结再实现，禁止"边写边定接口"。
- **可测先行**：每个模块落地即配测试；无测试的代码视为未完成。
- **二进制零入库**：QEMU/工具链一律按需拉取，仓库永不包含二进制。

### 1.2 工程节奏
- 以"阶段（Phase）→ 里程碑（Milestone）→ 任务（Task）"三级拆解。
- 每个任务对应一个可独立提交的 PR/commit 组。
- 每个里程碑结束做一次回归验证（跑 §12 验收清单）。

---

## 2. 里程碑与阶段划分

| 阶段 | 名称 | 目标 | 预估 | 里程碑标志 |
|---|---|---|---|---|
| P0 | 技术验证 | QEMU-ESP32 跑通 blink，GDB 能接上 | 1–2 周 | `M0` |
| P1 | MVP 核心 | 加载 ELF + LED/按键/OLED + 调试 + 串口 | 4–6 周 | `M1` |
| P2 | 显示与音频 | ST7789 TFT + 蜂鸣器 + 喇叭(I2S) + 示波器 | 4–6 周 | `M2` |
| P3 | 输入类外设 | 麦克风(I2S/ADC) + 旋钮 + 温湿度传感器 | 3–4 周 | `M3` |
| P4 | 多芯片与工程化 | S3/C3/C6 + 项目管理 + PlatformIO 集成 | 4–6 周 | `M4` |
| P5 | 生态与扩展 | 外设插件 SDK + 本地外设目录 + 文档站 | 持续 | `M5` |

> 预估基于"AI 生成 + 人工审查"节奏；纯人工需 ×2–3。

### 2.1 里程碑验收标志
- **M0**（已达成 2026-08-31）：`blink.elf` 启动，UART 打印 `Hello`，GDB 断在 `app_main`。
- **M1**（任务 1.1–1.10 已完成，Electron 应用级手动回归随收尾统一进行）：UI 拖拽 LED 连 GPIO2，OLED 显示固件绘制的文字，可断点单步。
- **M2**（进行中，任务 2.1–2.3 已完成）：TFT 渲染彩图，蜂鸣器发声，喇叭播放正弦波。
- **M3**（已达成 2026-09-11，任务 3.1–3.4 完成）：麦克风波形注入后固件能读到采样值；旋钮正交序列与 SHT30 读回复经真实 QEMU e2e 验证。
- **M4**（进行中，任务 4.1–4.5 已完成）：切换芯片型号后同一工程可在 ESP32/S3 跑通（S3 已真实 QEMU 验证；C3/C6 的 machine/仿真器映射与门控就绪，等待 riscv32 版 QEMU 二进制接入后做真实启动验证）；新建工程向导支持选芯片/选模板；PlatformIO/IDF 工程目录可关联并自动发现 build/*.elf 导入为 firmware.elf；条件断点/watchpoint 已接入调试面板（GDB/MI 线格式经扩展 mock 冻结，真实 GDB e2e 维持 BREADESP_GDB_BIN 门控）；DAP 适配器上线（stdio/TCP 双模式，launch/attach，真实 QEMU + esp-gdb 17.1 e2e 通过，见 docs/dap.md）。
- **M5**（进行中，任务 5.1 已完成）：第三方包 `registerPeripheral()` 后 UI 自动出现新器件（palette 注册表驱动 + 画布通用节点体，经单测冻结；SDK 注册校验 [BB-220/221/222] 与 sdkVersion 门控落地）。

---

## 3. 分阶段开发步骤

### Phase 0 — 技术验证（M0）

**目标**：打通"固件 → QEMU → 串口 + GDB"最关键链路，验证可行性。

| # | 任务 | 产物 | 验收 | 状态 |
|---|---|---|---|---|
| 0.1 | 搭建 monorepo 与工具链 | 已有骨架，`pnpm install` 通过 | `pnpm typecheck` 0 错误 | 已完成 2026-08-28 |
| 0.2 | 实现 `scripts/fetch-qemu.mjs` 真实下载 | 按 host 解析 release 资产、校验 checksum | `qemu-system-xtensa --version` 可执行 | 已完成 2026-08-28 |
| 0.3 | 准备黄金固件 `blink.elf` + 测试用例 | `packages/sim-core/fixtures/blink.elf` | 文件存在且为 Xtensa ELF | 已完成 2026-08-29 |
| 0.4 | 实现 `QemuRunner.load/start` 真实启动 | stdout→uart 事件 | UART 收到 `Hello ESP32` | 已完成 2026-08-29 |
| 0.5 | 实现 `GdbBridge` 连接 + 断点 | `setBreakpoint('app_main')` | GDB 停在 app_main | 已完成 2026-08-29 |
| 0.6 | ELF 架构校验（e_machine==0x5e Xtensa, EM_XTENSA=94） | `ProjectManager` 加载前校验 | 非目标 ELF 报错拒绝 | 已完成 2026-08-31 |

**禁止在 P0 做**：UI 美化、外设模型、网表校验扩展。

### Phase 1 — MVP 核心（M1，对齐 PRD §8）

**目标**：端到端可演示的虚拟面包板最小可用版。

| # | 任务 | 产物 | 验收 | 状态 |
|---|---|---|---|---|
| 1.1 | 补齐 preload↔handlers IPC 通道对齐 | `sim:load/onUart` 等 | 无"未注册通道"错误 | 已完成 2026-08-31 |
| 1.2 | 实现 QEMU 自定义设备 `breadesp-dbus`（C） | 独立 QEMU 构建产物 | 总线事务能序列化到 socket | 已完成 2026-08-31 |
| 1.3 | 实现 `DBusChannel` 帧协议（长度前缀 JSON） | Node 侧解析器 | 收到一条 I2C 事务 | 已完成 2026-08-31 |
| 1.4 | 实现 `NetlistResolver` I2C/GPIO 解析 | 按 address/pin 路由 | OLED 事务落到 oled1 | 已完成 2026-08-31 |
| 1.5 | 完善 `PeripheralManager` 路由 + 快照节流 | 30fps 上限 | UI 不卡顿 | 已完成 2026-08-31 |
| 1.6 | `ssd1306` 命令集补全（gfx 库常用路径） | 显存更新正确 | Adafruit_GFX demo 正常 | 已完成 2026-08-31 |
| 1.7 | `BreadboardCanvas` 拖拽放置 + 连线编辑 | 可视化连线 | 网表与布局分离持久化 | 已完成 2026-08-31 |
| 1.8 | 工程保存/加载（`.breadesp` 目录） | ProjectManager | 关闭重开恢复原样 | 已完成 2026-08-31 |
| 1.9 | 调试面板：断点/单步/变量/寄存器 | Inspector | 可看 `app_main` 局部变量 | 已完成 2026-08-31 |
| 1.10 | 串口控制台双向（输出+注入） | SerialConsole | 键入回车被固件读到 | 已完成 2026-08-31 |

**M1 回归**：跑 §12 的 M1 清单全部通过。

### Phase 2 — 显示与音频（M2）

| # | 任务 | 产物 | 验收 | 状态 |
|---|---|---|---|---|
| 2.1 | `st7789` SPI 命令解释 + rgb565 帧缓冲 | TFT 彩屏渲染 | SPI 事务落到 tft1 且像素入帧缓冲 | 已完成 2026-08-31 |
| 2.2 | `TftRenderer`（rgb565→ImageData） | UI Canvas | 画布显示 TFT 内容 | 已完成 2026-09-01 |
| 2.3 | `buzzer` PWM 频率→WebAudio 方波 | 发声 | 蜂鸣器按频率发声 | 已完成 2026-09-01 |
| 2.4 | `speaker` I2S PCM→WebAudio 播放 | 音频流 | 喇叭播放正弦波 | 已完成 2026-09-02 |
| 2.5 | `Oscilloscope` 抓 GPIO/PWM/I2S 时序 | 波形面板 | 波形面板显示 GPIO 波形 | 已完成 2026-09-02 |
| 2.6 | 仿真速度倍率 + 暂停/继续（QMP） | sim 控制 | sim 可暂停/继续/调速 | 已完成 2026-09-03 |

### Phase 3 — 输入类外设（M3）

| # | 任务 | 产物 | 状态 |
|---|---|---|---|
| 3.1 | `mic` I2S 输入注入 | 固件读到采样 | 已完成 2026-09-05 |
| 3.2 | 本地麦克风采集→注入 | 实时输入 | 已完成 2026-09-07 |
| 3.3 | 波形生成器面板 | 正弦/方波/噪声 | 已完成 2026-09-07 |
| 3.4 | 旋钮、温湿度传感器模型 | 扩展外设集 | 已完成 2026-09-11 |

### Phase 4 — 多芯片与工程化（M4）

| # | 任务 | 产物 | 状态 |
|---|---|---|---|
| 4.1 | sim-core 支持 S3/C3/C6 machine 映射 | 多芯片 | 已完成 2026-09-12 |
| 4.2 | 工程向导（选芯片/选模板） | 新建流程 | 已完成 2026-09-12 |
| 4.3 | PlatformIO/IDF 工程关联（自动发现 build/*.elf） | 联动 | 已完成 2026-09-13 |
| 4.4 | 条件断点 / watchpoint | 调试增强 | 已完成 2026-09-15 |
| 4.5 | DAP 适配器（接入 VS Code） | 跨工具调试 | 已完成 2026-09-18 |

### Phase 5 — 生态与扩展（M5）

| # | 任务 | 产物 | 状态 |
|---|---|---|---|
| 5.1 | 外设插件 SDK 稳定化 + 版本化 | 第三方可扩展 | 已完成 2026-09-19 |
| 5.2 | 本地外设目录扫描 | 离线市场 | 未开始 |
| 5.3 | 外设打包模板（脚手架） | 降低门槛 | 未开始 |
| 5.4 | 文档站 + 教程 | 可用性 | 未开始 |

> P5.1 验证记录（2026-09-19）：`pnpm typecheck` 0 错误；全仓测试 Windows 613 通过
> + 14 跳过（门控 e2e，同 P4.5 基线；较 P4.5 净增 32 项）；`pnpm --filter
> @breadesp/ui build`（tsc -b + vite）成功。分四层验证——
> 注册表层 19 项单测（`packages/peripherals/tests/registry.test.ts`：内建集
> 注册顺序/自校验全过/registerBuiltins 幂等、合法第三方工厂注册与按 kind 解析、
> listPeripherals 返回新鲜数组隔离、[BB-220] 形状矩阵（非对象/缺 create、9 种
> 非法 kind 对 5 种合法 kind、6 种非 semver version 对 prerelease/build 接受、
> 空/空白 displayName、6 种畸形 pins 表、非对象 defaults、非 semver sdkVersion）、
> [BB-220] 错误消息列出全部问题项、sdkVersion 兼容（同 major/旧 major 接受、
> 新 major 拒绝 [BB-222] 且双方版本点名、被拒工厂不留存、缺省 sdkVersion 按
> P5.1 前兼容接受）、semver 助手行为含前导零拒绝与 PERIPHERAL_SDK_VERSION
> 自检）；UI 层 13 项单测（paletteEntries 4 项——纯映射保序保字段、空快照、
> 内建集 displayName/semver 齐全、**M5 验收直译**：第三方 registerPeripheral()
> 后自动出现在 live palette；genericNode 9 项——无快照回退、level 百分比与
> 钳制含 NaN、tone Hz/silent、text 截断、pixels 几何、audio 采样率与灯态、
> waveform 通道数、未知未来快照类型仍可渲染）；shell 层未知 kind 测试改钉
> [BB-206] 编码消息（含 kind/instanceId 与注册指引）。真实 QEMU e2e 不适用
> （本任务不触碰仿真链路）；第三方消费链路（registry → PeripheralManager
> 实例化/路由）与既有 probe 工厂测试及全部内建外设 e2e 走的是同一通用路径。
> 自我迭代抓出并已修复两处：① registerBuiltins 幂等标志若置前，中途失败会
> 静默留下部分注册——改为循环完成后置位，失败保持每次调用都显式抛出；
> ② 新增 UI 测试的未用参数 typecheck 错误。
> 契约同步：PRD §6.2 补齐至现状契约（props 参数、viaPin、emitInput/drivePin、
> acceptCapture、rotate、sdkVersion）并新增注册与版本化段落（[BB-220/221/222]
> + [BB-206]）；PRD §7 追加 paletteEntries.ts 与 genericNode.ts；
> docs/peripheral-sdk.md 重写 §2（双进程注册 + 编码校验错误）与 §6（版本化
> 规则），新增 §7 UI 自动呈现（含已知限制：第三方 tone/audio 不自动发声）。
> 设计要点：palette 由注册表驱动取代硬编码清单；画布对无专属渲染的 kind
> 回退到快照驱动的通用节点体（内建 st7789 由此结束裸盒状态）；UI 零新 IPC、
> QEMU 设备零改动、零新运行时依赖（PRD §5 不变）。

---

## 4. 代码风格规范

### 4.1 总则
- 语言：TypeScript（`strict: true`），C（QEMU 设备，遵循 QEMU 上游风格）。
- UI 文案、日志、错误信息：英文。文档与注释：可中文。
- 一切对外可复用类型/接口放包内 `types.ts`，禁止散落。

### 4.2 命名
- **文件**：`kebab-case.ts`；React 组件文件 `PascalCase.tsx`。
- **类型/接口**：`PascalCase`，接口不加 `I` 前缀（`interface Peripheral` 非 `IPeripheral`）。
- **函数/变量**：`camelCase`。
- **常量**：`UPPER_SNAKE_CASE`。
- **枚举**：`PascalCase` 类型名 + `PascalCase` 成员。
- **私有字段**：前缀 `_` 仅用于与公开 API 区分时；其余用 `private`/`#`。
- **事件/IPC 通道**：`域:动作` 小写（PRD §6.6，如 `sim:start`）。

### 4.3 TypeScript 约束
- 禁止 `any`；遇不确定用 `unknown` + 类型守卫。
- 禁止 `// @ts-ignore`；必须用 `// @ts-expect-error: <原因>` 且附近有 TODO。
- 禁止 `as` 断言除非边界（IPC 入参），且 MUST 注释为何安全。
- 函数返回类型显式标注（公共 API）。
- 优先 `interface` 描述对象形状，`type` 用于联合/映射。
- 导入：统一 ESM `import`，禁用 `require`（C 代码除外）。
- 路径：包间用 workspace 包名，包内用相对路径。

### 4.4 React 约束
- 函数组件 + Hooks，禁用 class 组件。
- 状态：跨组件用 Zustand store；局部用 `useState`/`useReducer`。
- 副作用：`useEffect` 依赖数组 MUST 完整，禁用空数组+闭包旧值。
- 样式：内联 style 用于布局骨架，复用样式抽 `const`；M5 再评估 CSS-in-JS。
- 列表 key：用业务 id（`instanceId`），禁用数组下标。

### 4.5 格式化（硬约束）
- 缩进：2 空格。
- 引号：单引号（JS/TS）；C 遵循 QEMU 上游（Tab）。
- 行尾：无分号结尾争议 → **统一加分号**。
- 行宽：120。
- 末尾换行：文件以一个 `\n` 结尾。
- 工具：Prettier + ESLint（M0 配置完成）。

### 4.6 注释
- 文件头：`// PRD: §X.Y — <一句话职责>`。
- TODO：`// TODO(PRD §X.Y): <动作>`，便于全局检索。
- 公共 API：JSDoc 简述 + `@param`/`@returns`（仅当非显而易见时）。
- 禁止"死代码注释"——删除即删，不留 `// 旧逻辑`。

### 4.7 错误处理
- 边界（IPC 入参、文件 IO、子进程）MUST try/catch 并产出可读错误。
- 内部不变式用 `assert`/throw，禁用静默吞错。
- 错误信息 MUST 含上下文（哪个 instanceId / 哪条事务）。
- 用户可见错误用英文短句 + 错误码前缀（如 `[BB-001] ...`）。

---

## 5. Git 提交规范

### 5.1 提交粒度
- 一个 commit = 一个逻辑变更（一个任务或其子步骤）。
- 禁止"杂项更新"巨型 commit；拆分到可单独 review。
- 每个 commit 必须能独立通过 `pnpm typecheck`。

### 5.2 Commit Message 格式（Conventional Commits + scope）

```
<type>(<scope>): <subject>

<body 可选>

<footer 可选>
```

- **type**：`feat | fix | refactor | docs | test | chore | build | ci | perf`
- **scope**：包名或模块，如 `shell`、`ui`、`peripherals`、`sim-core`、`netlist`、`prd`、`docs`
- **subject**：祈使句、英文、≤50 字符、首字母小写、末尾无句号
- **body**：说明"为什么"（非"做了什么"），每行 ≤72 字符
- **footer**：`Refs: PRD §X.Y`、`Breaking:`、`Closes #N`

**示例**：
```
feat(peripherals): implement SSD1306 data write path

Covers the Adafruit_GFX common draw path (page addressing mode).
Command set is partial; full set deferred to M2.

Refs: PRD §F-PER-3
```

```
fix(shell): handle duplicate instanceId in PeripheralManager

Previously applyNetlist leaked old instances on re-apply.
```

### 5.3 PRD 关联
- 任何改动 PRD 契约（§6）或目录（§7）的 commit，footer MUST 含 `Breaking:` 与 `Refs: PRD §X.Y`，且 PRD 改动在**同一 commit 或其前序 commit**。

### 5.4 禁止项
- 禁止 `--no-verify` 跳过 hook。
- 禁止提交二进制（QEMU/ELF 除外，ELF 进 fixtures）。
- 禁止提交 `node_modules/`、`dist/`、`*.log`。
- 禁止一个 commit 同时含"功能"与"格式化全文件"——拆开。

---

## 6. 分支与发布流程

### 6.1 分支模型
- `main`：稳定主干，始终可构建可演示。
- `dev`：集成分支，PR 目标。
- `feat/<scope>-<short>`：功能分支。
- `fix/<scope>-<short>`：修复分支。
- `release/vX.Y.Z`：发布分支。

### 6.2 流程
1. 从 `dev` 切功能分支。
2. 每个任务一个或多个 commit，推送前本地跑 `pnpm typecheck && pnpm test`。
3. PR 到 `dev`，CI 必须绿。
4. 里程碑达成：`dev` → `main` 的 PR，打 tag `vX.Y.Z`（里程碑号）。

### 6.3 版本号
- 遵循 SemVer。
- 0.x 期间：M0–M1 为 `0.1.x`，M2 为 `0.2.x`，依此类推。
- 1.0：M4 完成、文档齐全、有集成测试覆盖。

### 6.4 Tag 命名
- `v0.1.0-m1`、`v0.2.0-m2`...里程碑发布用 `-mN` 后缀。

---

## 7. 测试规范

### 7.1 测试分层
- **单元**：纯函数/模型（peripherals、netlist、MiParser）。Vitest。
- **集成**：跨包链路（DBusChannel↔PeripheralManager）。Vitest + mock QEMU。
- **端到端**：真实 `blink.elf` 黄金用例，跑通断言 UART/快照。Node 脚本。

### 7.2 覆盖目标
- peripherals、netlist、MiParser：单元覆盖 ≥80%。
- shell 的 QemuRunner/GdbBridge：集成测试用 mock 子进程。
- 不强求 UI 组件测试（M5 再加）。

### 7.3 测试风格
- 文件：`<被测>.test.ts`，与源同目录或 `tests/` 下。
- 命名：`describe('module', () => { it('does X when Y', ...) })`。
- 断言用 `expect`；禁用 `toBeNull()` 滥用，优先正向断言。
- 黄金固件路径：`packages/sim-core/fixtures/`，测试用相对路径引用。

---

## 8. 文档规范

### 8.1 文档分两类
- **契约文档**：`PRD.md`、`docs/architecture.md`、`docs/peripheral-sdk.md`。改动 = 破坏性变更，需 review。
- **过程文档**：`docs/dev-plan.md`（本文件）、`CHANGELOG.md`、`README.md`。随代码演进。

### 8.2 CHANGELOG
- 维护 `CHANGELOG.md`（Keep a Changelog 格式）。
- 每个 PR 在 `Unreleased` 段补一行，格式 `- <type>: <摘要> (#PR)`。

### 8.3 AI 可读性
- 所有文档用清晰标题层级 + 编号，便于 AI 定位。
- 交叉引用用相对链接（`[PRD §6](../PRD.md#6-核心接口契约6)`）。
- 代码示例 MUST 可粘贴运行（无伪代码）。

---

## 9. AI Agent 协作规范

### 9.1 任务接洽
- 收到任务先读 PRD 对应章节 + 本文件对应阶段，确认范围。
- 范围外内容：**不做**，仅记 `TODO(PRD)` 留给后续，不擅自扩展。
- 每个生成的文件头 MUST 注 `// PRD: §X.Y`。

### 9.2 自检清单（每次提交前）
- [ ] `pnpm typecheck` 0 错误
- [ ] 新增/改动接口与 PRD §6 一致
- [ ] 新文件落在 PRD §7 路径下
- [ ] 无 `any`/`@ts-ignore`/`require`（C 除外）
- [ ] 无二进制入库
- [ ] 有对应测试或标注 `TODO`
- [ ] commit message 符合 §5.2
- [ ] 改动 PRD 的同步更新 PRD

### 9.3 禁止行为
- 禁止"顺便"重构未在本任务范围的代码。
- 禁止引入未列在 PRD §5 的运行时依赖。
- 禁止删除既有测试以让其通过。
- 禁止在 commit 中混入多个无关变更。
- 禁止用 `console.log` 留调试输出（用 `log()` 通道）。

### 9.4 不确定时
- 接口含糊 → 停下，先在 PRD 提 issue（注释 `// TODO(PRD §X.Y): 接口待澄清`），交付最小可运行实现。
- 不得靠"猜测接口"推进。

---

## 10. 注意事项与风险点

### 10.1 技术风险
| 风险 | 触发 | 对策 |
|---|---|---|
| QEMU-ESP32 外设覆盖不全 | P1.2 实现 dbus 设备 | 自写设备模型；参考 Renode 模型可移植 |
| Xtensa 指令边界 case | 调试偶发错位 | 锁定 QEMU 版本；黄金固件回归 |
| I2S/ADC 音频同步抖动 | M2/M3 | 真实采样率时钟 + 缓冲；声明非实时 |
| Konva 大量节点卡顿 | M2 屏幕多 | 帧缓冲直渲 Canvas，非逐图元 |
| Electron contextIsolation 限制 | preload 暴露不全 | 所有跨进程走 preload 暴露 API，renderer 不直连 Node |

### 10.2 流程风险
- **范围蔓延**：严格按阶段任务表，新想法记入"未来工作"而非即做。
- **契约漂移**：AI 改名 → §4.2 + §9.2 自检拦截。
- **二进制污染**：`.gitignore` + hook 双保险。

### 10.3 安全注意
- QEMU 子进程 `-nic none`，禁用网络（PRD §9）。
- ELF 加载前校验 `e_machine`，防恶意固件崩溃 QEMU。
- Bridge 不执行任意外部命令；`spawn` 仅限配置的 qemu/gdb 路径。

### 10.4 性能注意
- 外设快照节流：同一 instanceId 同类型 ≤30fps。
- DBus socket 帧批量合并：高频小事务合并为一帧。
- UI 渲染用 `requestAnimationFrame`，禁止每事务触发 setState。

---

## 11. 环境与工具链

### 11.1 开发依赖
- Node ≥20，pnpm ≥9。
- QEMU-ESP32：`scripts/fetch-qemu.mjs` 拉取。
- GDB：`xtensa-esp32-elf-gdb`（随 ESP-IDF 提供，或单独安装）。
- 编译固件：Arduino CLI 或 ESP-IDF（用户侧，非仓库依赖）。

### 11.2 环境变量
- `BREADESP_QEMU_BIN`：QEMU 二进制绝对路径（handlers 使用）。
- `BREADESP_QEMU_DBUS_BIN`：带 `breadesp-dbus` 设备的 QEMU 二进制路径（e2e 测试门控）。
- `BREADESP_GDB_BIN`：GDB 二进制路径。
- `XTENSA_GNU_CONFIG`：esp-gdb Xtensa dynconfig 覆盖（P4.5 起通常无需设置——
  GdbBridge 按 chip 自动指向 `<gdb>/lib/xtensa_<chip>.so`；显式设置时优先生效）。
- `VITE_DEV_SERVER_URL`：dev 模式 UI 加载地址（Electron main 使用）。
- `BREADESP_LOG_DIR`：日志目录（默认 `~/.breadesp/logs`）。
- `BREADESP_DOCKER_MIRROR`：Docker Hub 镜像前缀（如 `docker.1ms.run/`，构建设备版 QEMU 时）。
- `BREADESP_SUBPROJECT_MIRRORS`：QEMU meson wrap 子项目镜像模板列表（逗号分隔，`{name}` 占位）。
- `BREADESP_MSYS2_DIR`：Windows MSYS2 根目录（默认 `C:\msys64`）。

### 11.3 脚本命令
| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test` | 全仓测试 |
| `pnpm fetch-qemu` | 下载 QEMU 二进制 |
| `node scripts/build-qemu-device.mjs [--target linux-docker\|windows-msys2]` | 构建 breadesp-dbus 设备版 QEMU |
| `node scripts/make-blink-elf.mjs [--chip esp32\|esp32s3]` / `make-i2c-elf.mjs` / `make-uart-echo-elf.mjs` / `make-knob-elf.mjs` / `make-sht-elf.mjs` | 重新生成测试固件 |
| `pnpm dev` | 启动 Electron + Vite dev |
| `pnpm build` | 构建所有包 |

---

## 12. 验收检查清单

### M0 清单（已通过 2026-08-31）
- [x] `pnpm install && pnpm typecheck` 通过
- [x] `pnpm fetch-qemu` 下载成功且可执行
- [x] `blink.elf` 启动后 UART 输出可见
- [x] GDB 断点命中 `app_main`
- [x] 非 Xtensa ELF 被拒绝加载
- [x] 无二进制入库（`git log --diff-filter=A -- '*.bin'` 为空）

> 验证记录（2026-08-31 复验）：`pnpm typecheck` 0 错误；全仓测试 73 通过 + 1 跳过，含真实 QEMU UART e2e（`qemu-uart.e2e.test.ts`）通过；GDB 断点 e2e 需设 `BREADESP_GDB_BIN`，已于 2026-08-29 对真实 QEMU + `xtensa-esp32-elf-gdb` 验证通过（见 CHANGELOG）；入库二进制仅 `fixtures/blink.elf`（§5.4 允许的 ELF fixture），无 `*.bin` 入库。

### M1 清单（进行中，任务 1.1–1.10 已完成：IPC 对齐、breadesp-dbus 设备与独立 QEMU 构建、DBusChannel 帧协议、NetlistResolver I2C/GPIO 路由、PeripheralManager 路由健壮性 + 30fps 快照节流、SSD1306 命令集补全、面包板画布拖拽放置 + pin 连线编辑（网表/布局严格分离：移动节点只改 layout、连线只改 netlist，序列化各自独立且 netlist 始终过 validateNetlist）、工程保存/加载（`.breadesp` 目录四件套 firmware.elf/netlist.json/layout.json/meta.json，new/open/save/saveAs/close 全生命周期，关闭重开往返结构相等）、调试面板（断点增删清列 + 单步进入/跨过/继续 + 局部变量/寄存器/全局观察，dbg:connect 惰性附着 + dbg:stopped/running/exit 推送，blink.elf 携带 DWARF4）、串口控制台双向（sim:sendUart 注入链路 + uart-echo.elf 金标固件，UART0 RX/TX 端到端回显）；dbus 与路由 e2e 已在真实 QEMU 上验证——OLED 事务落到 oled1，持续 1ms 事务流被压到 ≤30fps，Adafruit_GFX begin()+display() 帧路径显存更新正确）
- [ ] UI 可拖拽 LED/按键/OLED 到画布
- [x] 可连线到 GPIO 并保存工程
- [ ] LED 随 GPIO2 电平亮灭（blink）
- [ ] OLED 渲染固件绘制文字
- [ ] 按键点击注入 GPIO 输入被固件读取
- [x] 可设断点、单步、看全局变量
- [x] 串口可输出可注入
- [x] 关闭重开工程恢复原样
- [ ] peripherals 单元测试通过

> P1.8 验证记录（2026-08-31）：`pnpm typecheck` 0 错误；全仓测试 173 通过 + 3 跳过（Windows 门控）。
> "关闭重开恢复原样"分三层验证——ProjectManager 单测（真实临时目录 save→close→reopen 结构相等，
> 19 项）、preload→handlers→真实 ProjectManager 的 IPC 集成测试（含双向 JSON 序列化边界与
> BB-120/122/124 错误传播，5 项）、UI store 水合/重置与加载后续排 id（14 项）；
> Electron 应用级 UI 手动回归随 M1 收尾统一进行。

> P1.9 验证记录（2026-08-31）：`pnpm typecheck` 0 错误；全仓测试 196 通过 + 4 跳过（Windows 门控）。
> 三层验证——GdbBridge 对 mock GDB/MI 子进程的 15 项单测（新增 vars/regs/evaluate/listBreakpoints/
> clearBreakpoints/stepOver/isConnected）；IPC 契约 15 项（新增 dbg:connect 路由与 BB-115 门控、
> sim:step 经 GDB 的 BB-105 门控、dbg:stopped 推送）；debuggerStore 11 项（attach/detach 状态机、
> 断点列表维护、观察值重估、detach 后迟到回复丢弃——由测试竞态暴露的真实竞态修复）。真实 QEMU +
> xtensa-esp32-elf-gdb 的 e2e（debug-panel.e2e.test.ts）于 WSL 验证通过（Linux breadesp QEMU 构建 +
> 独立 esp-gdb 16.3_20250913；esp-2021r2-patch5 工具链的 gdb 在 Ubuntu 24.04 缺 libpython2.7 无法运行）：
> 断 `led_state_written` → evaluate('led_state')=="1" → vars() 返回 app_main 的 msg_cursor/remaining/
> delay_ticks（remaining==0）→ regs().pc 命中断点地址 → 单步 → 断点清列。e2e 另暴露一处真实协议
> 形状偏差——`-break-list` 的 `body` 嵌套于 `BreakpointTable` 内部（此前 mock 驱动的解析误置为顶层
> 字段），已按 wire 形状修正解析并对齐 mock；P0.5 的 gdb-breakpoint e2e 亦于同环境回归通过。

> P1.10 验证记录（2026-08-31）：`pnpm typecheck` 0 错误；全仓测试 199 通过 + 4 跳过（Windows 门控）。
> 双向链路分三层验证——QemuRunner 对 mock QEMU 的 9 项单测（新增 writeStdin stdin 转发回显、
> 未 load 时 BB-102 拒绝）；IPC 契约 15 项（新增 sim:sendUart 通道与 preload 暴露对齐）；真实
> QEMU e2e（qemu-uart.e2e.test.ts 第 2 例）于 WSL 验证通过（Linux breadesp QEMU 构建）：注入
> `Hello BreadESP\n` → 固件轮询 UART_STATUS.RXFIFO_CNT 出队组行 → 回显 `ECHO: Hello BreadESP\r\n`
> → 第二行 `line two` 证明行缓冲正确复位。金标固件 `uart-echo.elf` 由
> `scripts/make-uart-echo-elf.mjs` 确定性生成（xtensa-elf.mjs 新增 l32i 编码），`--check` 模式
> 可校验入库 fixture 无漂移。已知平台差异：Windows stdio 后端（char-win-stdio.c）丢弃 `\r` 字节，故 UI 与
> 测试统一以 `\n` 结尾注入行。

> P2.1 验证记录（2026-08-31）：`pnpm typecheck` 0 错误；全仓测试 218 通过 + 5 跳过（Windows 门控，
> 新增 spi e2e 跳过项）。分三层验证——st7789 模型 13 项单测（init→全帧渲染、DC 电平整帧适用、半像素跨帧、
> CASET/RASET 窗口写入与回绕、MADCTL 旋转（含 TFT_eSPI drawPixel 局部窗口期望）、BGR 通道交换、
> 熄屏/休眠空白、INVON/INVOFF 反色、任意命令终止 RAMWR 流、SWRESET 上电态、CS 过滤与读事务忽略、
> 缺 dc 告警一次），单测暴露并修复两个真实模型 bug（MADCTL 变换顺序、RAMWR 终止语义）；NetlistResolver
> 扩至 20 项（CS 认领、控制器号无关、factory 缺省回退、未认领 CS、越界 CS 拒绝、spi-cs 角色过滤）；
> 真实 QEMU e2e（spi-st7789.e2e.test.ts）于 WSL 验证通过（Docker 重建的 Linux breadesp QEMU，
> 含 SPI sniffer）：spi.elf 的 CS0 事务流把 4 个 RGB565 像素按扫描序渲染进 240x240 帧缓冲（其余为黑）、
> 无广播泄漏（仅 tft1 产生快照）、UART 出现 `SPI OK` 完成标记。金标固件 `spi.elf` 由
> `scripts/make-spi-elf.mjs` 确定性生成，`--check` 模式可校验入库 fixture 无漂移。
> QEMU 设备构建两条教训：`SSI_BUS` 宏未导出（用 `qdev_get_child_bus(...,"spi")` 强转 `SSIBus*`）；
> SSI 外设类不实现 `realize` 回调会在 realize 阶段 SIGSEGV（sniffer 实现了空回调）。

> P2.2 验证记录（2026-09-01）：`pnpm typecheck` 0 错误；全仓测试 231 通过 + 5 跳过（Windows 门控，
> 与 P2.1 同基线，新增 13 项 TftRenderer 单测）。分两层验证——`TftRenderer.rgb565ToRgba`
> 纯解码（5/6/5→8 位位复制扩展：纯红 0xF800→255 而非 248，对应真实 ST7789 满量程显色；行序
> row-major、16 位掩码、超长截断、缺省补黑、缓冲过小抛错、全黑帧）、`TftRenderer.renderRgb565`
> 画布绑定（createImageData→putImageData@0,0、按快照尺寸调整 canvas backing store、
> 2d context 缺失静默返回）；以及 ST7789 快照形状集成缝（`pixels` payload `{width,height,
> format:'rgb565',buffer:number[]}` 原样可解码）。`ScreenView` 由"单一 OLED mono 画布"
> 重构为"按 instanceId 排序的多屏瓦片"，每屏各自持 canvas、按 format 分派 mono/rgb565 渲染器，
> 240×240 TFT 在 280px 侧栏内等比缩放且 `imageRendering:pixelated` 保持像素清晰。

> P2.3 验证记录（2026-09-01）：`pnpm typecheck` 0 错误；全仓测试 260 通过 + 6 跳过（Windows 门控，
> 新增 pwm e2e 跳过项）。分四层验证——buzzer 模型 14 项单测（pwm 解码含小数厘赫、零占空/零频静默、
> 稳态去重、440→880 变调、占空比钳制、截断负载忽略、读事务/异类事务过滤；bit-bang 沿测频、4 沿下限、
> 漂移带去重、频率跟踪、超音频段拒绝）；路由/协议层 NetlistResolver 21 项（pwm 按 GPIO 连线路由 +
> 未连线引脚）与 DBusChannel 8 项（pwm 帧透传 ns→ms）；UI 层 BuzzerAudio 14 项（纯映射钳制/非有限值/
> 非 tone 拒绝，每实例一条方波声道的 osc→gain→destination 接线、原地变调、静音不停振、自定义音量、
> 无 AudioContext 静默、suspended 才 resume、一次性手势钩子、dispose 后重建）；真实 QEMU e2e
> （pwm-buzzer.e2e.test.ts）于 WSL 验证通过（Docker 重建的 Linux breadesp QEMU，含 LEDC/GPIO 矩阵
> 影子）：buzzer.elf 的 LEDC 440Hz→880Hz 配置序列落到 buzz1 的 tone 快照（430–450Hz → 860–900Hz，
> duty≈0.5），无广播泄漏，UART 出现 `BUZZ 440`/`BUZZ 880` 标记；spi-st7789/netlist-routing/dbus-device
> e2e 对同一重建二进制回归通过（WSL 全量 127 通过）。金标固件 `buzzer.elf` 由
> `scripts/make-buzzer-elf.mjs` 确定性生成，`--check` 模式可校验入库 fixture 无漂移。
> 设计要点：QEMU 自带 esp32_ledc 模型只存寄存器不驱动引脚（GPIO 矩阵未建模），故设备侧新增
> LEDC 寄存器影子 + GPIO FUNCn_OUT_SEL 观测，把定时器/通道配置按 TRM 公式解码为每引脚
> (频率, 占空比) 并以 pwm 事务（6 字节：厘赫 u32 LE + 千分占空 u16 LE）去重下发；
> 快照新增 'tone' 类型（§6.4 追加式联合扩展，duty 兼作视觉亮度，避免每实例单快照位相互覆盖）。

> P2.4 验证记录（2026-09-02）：`pnpm typecheck` 0 错误；全仓测试 290 通过 + 7 跳过（Windows 门控，
> 新增 i2s e2e 跳过项）。分四层验证——speaker 模型 13 项单测（s16le 立体声混单声道、mono/8-bit/24-bit
> 解码与符号扩展、截断头/零采样率/零声道/非法位宽拒绝、部分尾帧丢弃、批量阈值冲刷、跨事务分帧重组、
> 格式变更按旧采样率先冲刷、异类/读事务过滤、i2s-data-in 角色与 bus 缺省）；路由/协议层
> NetlistResolver 25 项（i2s 按控制器号认领、factory 缺省回退、未认领/越界总线、角色过滤）与
> DBusChannel 9 项（i2s 帧透传）；PeripheralManager 16 项（新增 'audio' 快照绕过 30fps 合并——PCM 是流
> 不是可重述状态，合并即丢样本，e2e 曾以 1867Hz≈1.8× 倍频抓出此 bug）；UI 层 SpeakerAudio 13 项
> （纯映射、首块 lead 调度、游标无缝接龙、每实例独立游标、欠载重同步、硬削波、音量、无 AudioContext
> 静默、一次性手势钩子、dispose 停源重建）；真实 QEMU e2e（i2s-speaker.e2e.test.ts）于 WSL 验证通过
> （Docker 重建的 Linux breadesp QEMU，含 I2S 影子）：speaker.elf 的 I2S0 DMA 正弦环流到 spk1 的
> audio 快照（采样率 15800–17500Hz 区间实测 16667，过零法估频 1041.7Hz±5%，峰值 0.4–0.7），无广播
> 泄漏，UART 出现 `SPK SINE` 标记；spi-st7789/pwm-buzzer/netlist-routing/dbus-device e2e 对同一重建
> 二进制回归通过（WSL 全量 134 通过）。金标固件 `speaker.elf` 由 `scripts/make-speaker-elf.mjs`
> 确定性生成，`--check` 模式可校验入库 fixture 无漂移。
> 开发期两个真实 bug 被验证链抓出并修复：① QEMU 侧 OUTLINK_ADDR 是 20 位 DRAM 窗口字段
> （物理地址 = 0x3ff00000|field，lldesc 的 buf/next 才是完整指针），首版按绝对地址读描述符导致全流无声；
> ② 设备 10ms tick 按字节速率切 chunk 会把 4 字节立体声帧劈到两条事务里，模型首版逐事务独立解码
> 丢弃残帧，流相位错位表现为 ~2× 视在频率——模型改为跨事务残帧重组（e2e 过零估频 2099.9Hz 抓出）。

> P2.5 验证记录（2026-09-02）：`pnpm typecheck` 0 错误；全仓测试 320 通过 + 8 跳过（Windows 门控，
> 新增 gpio e2e 跳过项）。分四层验证——oscilloscope 模型 16 项单测（viaPin 通道归属、方波周期
> 重建、同电平去重、窗口滚动剪枝（窗前一沿保留并重锚定 t=0）、边缘数上限、无 viaPin/未知引脚/
> 读事务/非有限时间戳/异类事务过滤；PWM 稳态合成展开（100Hz/50%→21 沿含右边界、25% 占空高沿
> 2.5ms、停止出空通道平轨、真实 gpio 写取代合成、截断负载忽略、极速音调边缘封顶）、全窗重述态
> 快照源侧去重）；路由层 PeripheralManager 17 项（新增 viaPin 传递——同一 scope 的 CH1/CH3 分线
> 各归其通道，30fps 窗口内第二条波形经尾随冲刷送达）；UI 层 traceBuilder/renderScope 13 项
> （waveformOf 载荷收窄、阶梯折线几何（首沿反推前级、方波交替轨、越界钳制、空通道平低轨）、
> 网格等分/通道分带/稳定配色、记录式 2d context 画布绑定——背景/标签/时基标注、每通道一条
> step trace、非波形载荷只画背景、无 2d context 静默返回）；真实 QEMU e2e
> （gpio-scope.e2e.test.ts）于 WSL 验证通过：blink.elf 的 GPIO2 翻转流落到 scope1 CH1 的
> waveform 快照（≥6 沿、电平严格交替、沿间距中位数 10% 带内一致——busy 环对称性），无广播
> 泄漏，UART 出现 `Hello ESP32` 标记；spi-st7789/pwm-buzzer/i2s-speaker/netlist-routing/
> dbus-device e2e 对同一二进制回归通过（WSL 全量 136 通过 + 5 跳过）。
> 设计要点：QEMU 设备侧无需改动——GPIO 影子本就以虚拟时钟（ns，DBusChannel 归一化为 ms）
> 上报电平变化；示波器作为面包板器件接入既有连线级 gpio/pwm 路由，多通道归属通过
> `Peripheral.onTransaction(tx, viaPin?)` 追加式可选参数传递（§6.2 契约兼容）；'waveform'
> 快照载荷追加 `WaveformPayload` 变体（{startMs, windowMs, channels[]}，全窗重述态，
> 30fps last-write-wins 合并安全）；LEDC 驱动引脚无真实翻转，PWM 稳态在快照构建时按窗口
> 合成边沿（等效真实示波器触发视图）。I2S 总线抓取留作 P3 TODO。

> P2.6 验证记录（2026-09-03）：`pnpm typecheck` 0 错误；全仓测试 328 通过 + 9 跳过（Windows 门控，
> 新增 sim-speed e2e 跳过项）。分四层验证——QemuRunner 12 项 mock 子进程测试（新增 [BB-116]
> 倍率校验（NaN/∞/0/0.05/10.5/-1 拒绝，0.1/10 边界接受）、'speed' 事件透传、40ms 量子的
> 0.5x 占空比节流（≥4 个 stop/cont 停走窗口、节流期 status 保持 'running'、用户 pause 取代
> 周期后无新增节流 stop、resume 后恢复节流、回 1x 撤防））；IPC 契约 17 项（新增 sim:setSpeed/
> sim:getSpeed 通道与 sim:speed 推送，payload 原样透传）；UI 层 simulationStore 3 项（默认 1x、
> setSpeed 镜像、clear 复位）；真实 QEMU e2e（sim-speed.e2e.test.ts）于 WSL 验证通过：
> blink.elf 的 GPIO2 事务流——全速基线到达率 >0 → pause 后 800ms 零事务（虚拟时钟冻结）→
> resume 恢复 → 0.25x 时节流速率落在全速的 5%–60% 带内（同一虚拟时间 blink 摊到 ~4x 墙钟）→
> 回 1x 恢复全速；gpio-scope/spi-st7789/pwm-buzzer/i2s-speaker/netlist-routing/dbus-device/
> qemu-uart e2e 对同一二进制回归通过（WSL 全量 142 通过 + 5 跳过）。
> 设计要点：QMP 无 CPU 时钟控制，<1x 通过 QMP stop/cont 占空比节流实现"逻辑时钟节流"
> （PRD §F-SIM-2 原文）——每个量子 VM 运行 speed×quantum 后以 stop 冻结虚拟时钟，dbus 时间戳
> 随之拉伸；>1x 接受但饱和于墙钟（QEMU 不能快过宿主机）。节流停走是内部实现，广播 status
> 保持 'running'（F-SIM-4 不变）；世代计数器退役在途相位，竞态的 stop 必以 cont 撤销，
> 除非用户 pause 接管。两处迭代暴露并已修复：① 全量并行下 sim-speed e2e 的长时占空比客户机
> 抢占 CPU 致 gpio-scope 10% 沿距带抖动超界（10.3%/41%）——shell vitest 改为单线程串行，
> 真实硬件测量不再互相竞争；② Windows 上 pause 前在途 stop 的 stderr 日志晚一拍 flush
> 导致计数断言 5≠4——测试加 60ms 沉降窗口（连跑 5 次稳定）。
> UI：新增 SimControls 控制条（Pause/Resume/Reset + 0.1x–10x 倍率选择），simulationStore
> 镜像 sim:speed 推送。

> P3.1 验证记录（2026-09-05）：`pnpm typecheck` 0 错误；全仓测试 Windows 348 通过 + 10 跳过
> （门控 e2e），WSL shell 全量（含全部真实 QEMU e2e）146 通过 + 5 跳过。分四层验证——mic 模型
> 19 项单测（props 校验钳制回退、四波形生成（正弦幅值/相位跨块连续、方波对称轨、xorshift
> 噪声确定性与有界、静音全零）、8/16/24/32 位小端带符号编码、interval 逐块发射
> I2sInjection、dispose 停发、无注入通道一次性告警、异类事务忽略、factory 元数据）；
> 协议层 DBusChannel 11 项（新增 sendInject 反向帧 `{"v":1,"in":[{"kind":"i2s-in",...}]}`
> 线格式与无设备返回 false）；路由层 PeripheralManager 18 项（新增 emitInput→'inject'
> 事件转发与 dispose 停流）；真实 QEMU e2e（mic-i2s.e2e.test.ts）于 WSL 验证通过：
> mic1 注入 440Hz 正弦（33.3kHz 16bit mono）经反向通道进设备 RX 队列，设备按固件解码
> 速率写入 in-link 环（owner 清零 + length 回填 + eof），mic.elf 轮询到 8 个非零缓冲
> 后打印 `MIC OK`（且 `MIC RDY` 先于 `MIC OK`）；speaker/st7789/buzzer/scope/sim-speed
> 等全部 e2e 对同一重建二进制回归通过。金标固件 `mic.elf` 由 `scripts/make-mic-elf.mjs`
> 确定性生成，`--check` 模式可校验入库 fixture 无漂移。
> 迭代抓出并已修复两个真实 bug：① 饥饿死锁——注入队列空时设备零填充描述符并清 owner，
> 而固件只在见到非零数据时才 re-arm，双方互等致环形停摆（探针复现：tick 走但固件永远
> 等不到数据）——设备改为队列枯竭时不认领描述符（保持 armed），固件改为每轮无条件
> re-arm（标准环形消费模式）；② 协议字段缺失——TS `sendInject` 首版序列化漏掉
> `"kind":"i2s-in"`，设备有序扫描器找不到注入对象而静默丢弃（探针对比：手工带 kind 的
> 注入可通、模型链路不通；设备侧逐层打印定位到 scan miss）——sendInject 现自动补 kind
> 并以单测冻结线格式。

> P3.2 验证记录（2026-09-07）：`pnpm typecheck` 0 错误；全仓测试 Windows 382 通过 + 11 跳过
> （门控 e2e），WSL shell 全量（含全部真实 QEMU e2e）151 通过 + 5 跳过。分四层验证——mic 模型
> 33 项单测（新增 `drainResampled` 纯函数 5 项：等速率透传带位置续接、2:1 整数点精确抽取、
> 1:2 线性插值升采样、饥饿产零、非整数比率小数点插值；采集路径 10 项：采集覆盖 synth、
> 48k→16k 宿主速率重采样、饥饿不注入静音、500ms 无喂流回退 synth、stale 缓冲清除、
> 源速率变更重置缓冲、1s 上限丢最旧+一次性告警、畸形块整包丢弃、超幅值钳制满量程、
> mono 复制成立体声、dispose 停采）；路由层 PeripheralManager 20 项（新增 feedCapture
> 路由 + 未知实例/无 acceptCapture 模型静默丢弃）；协议层 IPC 契约 19 项（新增
> `per:captureChunk` 通道注册对齐、合法负载透传、9 种畸形负载 [BB-202] 拒绝）；UI 层
> MicCapture 引擎 8 项（零增益接线防回授、按实例打标 emit、start 幂等、getUserMedia
> 拒绝传播、无 AudioContext 释放流、stop/dispose 拆解图+停轨+关 ctx）+ captureStore 6 项
> （状态迁移、[BB-210] 错误面、chunk→IPC 接线、reconcile 停采已从网表移除的实例）；
> 真实 QEMU e2e（mic-capture.e2e.test.ts）于 WSL 验证通过：mic.elf（props 故意配
> waveform:'silence'，只有采集路径能产生非零样本）被以 48kHz mono Float32 正弦块经
> `feedCapture` 喂入（与渲染进程 MicCapture 发出的负载同形），模型重采样到固件的
> 33.3kHz，固件累计 8 个非零 RX DMA 缓冲后打印 `MIC OK`；mic-i2s（synth 路径回归）、
> spi-st7789、pwm-buzzer、i2s-speaker、gpio-scope、sim-speed、netlist-routing、
> dbus-device e2e 对同一二进制全部回归通过。
> 设计要点：采集是纯运行时覆盖态，不落网表（重开工程不应自动请求麦克风权限）——喂流
> 存活期间每个 chunkMs tick 经 `drainResampled` 线性重采样缓冲的宿主音频，500ms 无喂流
> 则丢缓冲回退 synth；饥饿只发空（设备保持描述符 armed，不用静音抢占）；缓冲上限 1s
> 源音频丢最旧限延迟；UI 侧 ScriptProcessor 经零增益 mute 接 destination（不连线不回调，
> 直连则本地麦克风外放回授）；`Peripheral.acceptCapture(CaptureChunk)` 为 §6.2 追加式
> 可选成员（向后兼容），QEMU 设备零改动（复用 P3.1 反向通道）。
> 设计要点：socket 双向化采用 GLib watch 读 + 长度前缀帧（设备侧为有序扫描器而非完整
> JSON 解析器，字段顺序是协议契约）；注入队列 256KB/控制器，溢出丢最旧保低延迟；RX 时钟
> 解码复用 TX 公式（SAMPLE_RATE_CONF 的 RX 半边字段），APLL 仍为文档化缺口；
> `PeripheralContext.emitInput` 为 §6.2 追加式可选成员（向后兼容），本地采集与波形面板
> 分别留给 P3.2/P3.3。

> P3.3 验证记录（2026-09-07）：`pnpm typecheck` 0 错误；全仓测试 Windows 399 通过 + 11 跳过
> （门控 e2e），WSL shell 全量（含全部真实 QEMU e2e）151 通过 + 5 跳过。分两层验证——UI 纯
> 逻辑层 13 项 `wavegenDraft` 单测（draftFromProps 默认/钳制回退委托 mic 模型自身
> micConfigFromProps、draftPatch 恰好六个可编辑键且不含 bus/chunkMs、补丁往返无损、
> previewTrace 确定性/幅值有界/单周期正弦满摆/方波仅双轨/噪声多样且有界/静音全零/
> 固定 5ms 窗内频率越高过零越多；renderWavePreview 画布绑定：背景+零线+全点折线、
> 超幅值钳制进画布、退化输入只画背景与零线、无 2d context 静默返回）+ 4 项
> projectStore.updatePeripheralProps 单测（补丁合并保留既有 props、纯逻辑编辑 layout
> 标识不变且网表仍过 validateNetlist、未知 instanceId 无操作、props 经 netlist.json
> 序列化半区持久化）；端到端消费链由既有 mic-i2s e2e 冻结——面板写出的 props 形状
> （`{waveform, freqHz, amplitude, sampleRate, ...}`）正是该 e2e 在真实 breadesp QEMU
> 上验证固件读到注入采样的同一网表形状；mic-i2s/mic-capture/spi-st7789/pwm-buzzer/
> i2s-speaker/gpio-scope/sim-speed/netlist-routing/dbus-device e2e 对同一二进制全部
> 回归通过。
> 设计要点：波形生成器面板不引入新 IPC——编辑经 `projectStore.updatePeripheralProps`
> 合并进实例 netlist props（纯逻辑编辑，layout 标识不变），netlist 标识变化触发 App 既有
> `bb:applyNetlist` 效应原子重建 mic 实例即生效；与采集（P3.2，纯运行时覆盖）不同，生成器
> 配置随 netlist.json 持久化。面板全部归一化委托给模型导出的
> `micConfigFromProps`/`waveformSample`/`MIC_LIMITS`（单一真相源，UI 永不提供模型会拒绝的
> 配置）；采集进行中卡片提示"LIVE capture is overriding the synth waveform"。
> QEMU 设备零改动。

> P3.4 验证记录（2026-09-11）：`pnpm typecheck` 0 错误；全仓测试 Windows 448 通过 + 13 跳过
> （门控 e2e），WSL shell 全量（含全部真实 QEMU e2e）168 通过 + 5 跳过（既有基线：
> gdb-breakpoint×2/debug-panel×1 需 BREADESP_GDB_BIN，qemu-uart×2 门控于 Windows 版
> QEMU manifest）。分四层验证——knob 模型 15 项单测（props 钳制回退、Gray 相位表、
> 单 detent 四迁移逐针脚断言、CCW 逆序、混合方向净额合并、连击钳制 ±64 detents、
> 未接线引脚一次性告警且不影响另一针、无 drivePin 通道一次性告警、dispose 停队列、
> factory 元数据）；sht30 模型 21 项单测（props 校验、CRC-8 对 datasheet 0xBEEF→0x92
>  worked example、25°C/50% 金标向量 [0x66,0x66,0x93,0x80,0x00,0xA2]、量程端点无溢出、
> 六种测量命令字、状态寄存器 heater 位跟踪与软复位、异地址/读事务/异类/子字长过滤、
> 周期模式一次性告警、无注入通道一次性告警、text 快照、格式化行）；路由/协议层
> NetlistResolver 28 项（新增 resolveGpioInput 双向线序/未接线/非 GPIO 轨/重建）与
> DBusChannel 14 项（gpio-in/i2c-out/i2s-in 三种反向帧精确字符串冻结字段顺序）；
> PeripheralManager 25 项（driveRotate→gpio-in 注入序列、driveInput 按键路径注入、
> [BB-205] 未接线一次性告警、rotate-less 实例静默丢弃、换网表停播中途旋转）；
> IPC 契约 23 项（per:rotateKnob 注册对齐 + [BB-204] 校验、per:driveInput [BB-203]
> 校验）；UI 层 sensorDraft 7 项（步进/缺省回退/非法 props 归一化/量程饱和/分数读数）。
> 真实 QEMU e2e（knob-gpio/sht30-i2c，Docker 重建的 Linux breadesp QEMU）于 WSL
> 验证通过：knob.elf 轮询 GPIO_IN 解码出 +2 detents 打印 `KNOB CW`、回零打印
> `KNOB ZERO`（正交序列经 gpio-in 注入合并进 IN 影子读）；sht.elf 发 0x2C06 测量
> 命令后重试读取，读到模型应答的 25°C/50%RH 六字节读出打印 `SHT OK`（i2c-out
> 邮箱经 sniffer_recv 供应）；mic-i2s/mic-capture/spi-st7789/pwm-buzzer/i2s-speaker/
> gpio-scope/sim-speed/netlist-routing/dbus-device e2e 对同一重建二进制全部回归通过。
> 金标固件 `knob.elf`/`sht.elf` 由 `scripts/make-knob-elf.mjs`/`make-sht-elf.mjs`
> 确定性生成（xtensa-elf.mjs 新增 add/sub 编码，对照 pinned 解码器表核对），
> `--check` 模式可校验入库 fixture 无漂移。
> 迭代抓出并已修复一个真实缺陷：applyNetlist 先建实例后换路由，knob 构造期的静止态
> 同步驱动被解析进旧路由而丢弃——改为先在临时 resolver 建路由、实例构造引用之、
> 全部成功才原子提交（单测冻结构造期注入断言）。设计要点：stock esp32.gpio 是
> strap-only stub（无 qdev 输入线），gpio-in 注入只能在影子读路径合并 IN/IN1 读值，
> GPIO 边沿中断未建模（输入固件以轮询读取）；esp32_i2c 的 READ 在 TRANS_START 内
> 同步执行，读回复无法同传输往返，故设备侧为按 (bus,addr) 键控的原子替换邮箱 +
> 固件重试收敛（金标固件重试上限 250 次）。反向通道泛化为 kind 判别三帧
> （i2s-in/gpio-in/i2c-out），PRD §6.7 已同步追加；`PeripheralContext.drivePin` 与
> `Peripheral.rotate` 为 §6.2 追加式可选成员（向后兼容），sendInject 按 kind 逐字段
> 序列化（字段顺序即协议契约，杜绝 P3.1 丢 kind 事故类）。button 的 GPIO 注入 TODO
> 随 driveInput 真接通透随之闭合（M1 清单"按键注入"项的设备侧路径自此存在）。

> P4.1 验证记录（2026-09-12）：`pnpm typecheck` 0 错误；全仓测试 Windows 464 通过 + 13 跳过
> （门控 e2e 11 项 breadesp 设备版 + 2 项 GDB 环境门控；较 P3.4 基线的 qemu-uart 两例
> 本次随本地 QEMU manifest 就绪转为真实执行）。分四层验证——
> sim-core args/elf 22 项单测（-machine 精确对值断言 esp32/esp32s3/esp32c3/esp32c6、
> qemuSystemForChip 族映射 xtensa|riscv32、EM_RISCV 对 c3/c6 双双接受、Xtensa 金标
> 对 c3/c6 拒绝且错误消息点名 chip）；netlist schema 10 项（四种 chip 全部过
> validateNetlist）；shell ProjectManager 20 项（[BB-101] 对 c6 的接受/拒绝路径）；
> 真实 QEMU e2e（s3-machine.e2e.test.ts）3 项——blink.elf 经同一 QemuRunner 路径
> 在 `-machine esp32` 打印 `Hello ESP32\r\n`、s3-blink.elf 在 `-machine esp32s3`
> 打印 `Hello ESP32-S3\r\n`、Xtensa 二进制被要求跑 esp32c3 machine 时 QEMU 立即
> 退出且 runner status='error'（F-SIM-4 不挂起）。金标固件 `s3-blink.elf` 由
> `scripts/make-blink-elf.mjs --chip esp32s3` 确定性生成（LX6/LX7 编码相同，
> 仅 UART/GPIO/IRAM 基址随芯片分表；S3 基址经真实 QEMU 启动验证），`--check`
> 模式校验 blink.elf 与 s3-blink.elf 双 fixture 无漂移。
> 设计要点：espressif/qemu 按 CPU 族分发两个系统仿真器——esp32/esp32s3（Xtensa
> LX6/LX7）在 qemu-system-xtensa，esp32c3/esp32c6（RISC-V）需 qemu-system-riscv32
> （本任务验证当日 GitHub 不可达未能拉取，留待接入后做 C3/C6 真实启动 e2e）；
> `qemuSystemForChip()` 导出族映射供二进制解析使用，错误族组合在 QEMU 侧以
> "no machine found" 立即失败（e2e 第 3 例冻结该行为）。ChipKind 扩展 esp32c6
> 为 §6.5 契约扩展，PRD 与代码同一 commit 提交；shell/ui 的 chip 类型收敛到
> `@breadesp/netlist` 的 ChipKind（消灭三处手写联合漂移点）。

> P4.2 验证记录（2026-09-12）：`pnpm typecheck` 0 错误；全仓测试 Windows 488 通过
> + 13 跳过（门控 e2e，同 P4.1 基线；较 P4.1 净增 24 项）。分三层验证——
> netlist 模板层 9 项单测（注册表顺序与元数据非空、每个模板 × 每个支持的芯片
> 产物均过 validateNetlist/validateLayout 且两半引用同一实例集、blink-led 全芯片
> 连线 mcu GPIO2→led-1.A、oled-ssd1306 按芯片 I2C0 默认引脚表 esp32=21/22,
> s3/c3=8/9, c6=6/7、未知模板与不支持芯片拒绝、listTemplates 防御性拷贝、
> templatesForChip 过滤保序）；shell 层 ProjectManager 6 项（模板+芯片落盘并返回
> 校验后的 ProjectData、返回与磁盘零漂移、OLED 模板 c6 引脚、无选项保持
> esp32/empty 旧行为、未知模板/越界芯片 [BB-125] 均先验证不落盘、带选项仍
> [BB-124] 拒绝覆盖）与 IPC 契约 3 项（proj:new 携带 chip/template 透传并返回
> ProjectData、无选项旧调用兼容、7 种畸形负载 [BB-126] 拒绝且未触达
> ProjectManager）；UI 层 wizardDraft 6 项（默认 esp32/empty、模板列表随芯片
> 过滤、patch 合并且跨芯片保留受支持模板、失去支持时回退 'empty'、空目录阻断
> Create、全部芯片×模板组合可通过校验）。真实 QEMU e2e 不适用（本任务不触碰
> 固件加载链路）；模板产出的网表形状（led/ssd1306 + GPIO/I2C 连线）正是
> netlist-routing/dbus-device e2e 已在真实 breadesp QEMU 上验证过的同一形状。
> 设计要点：模板注册表落在 `@breadesp/netlist`（与 types/schema 同包同源），
> shell 写盘与 UI 向导共用一处真相；`proj:new` 负载为 §6.6 追加式可选扩展
> （chip?/template? 缺省保持旧行为），`newProject` 返回值由 void 升级为校验后
> ProjectData（向后兼容，UI 直接水合，打开与新建走同一 loadProject 路径）；
> ProjectToolbar 的 New 改为打开 ProjectWizard 模态（目录预填自工具栏输入）。

> P4.3 验证记录（2026-09-13）：`pnpm typecheck` 0 错误；全仓测试 Windows 543 通过
> + 13 跳过（门控 e2e，同 P4.2 基线；较 P4.2 净增 55 项）。分四层验证——
> ExternalProject 扫描层 18 项单测（platformio.ini env 解析含注释/CRLF/去重/
> 裸 [env]→env 目录、检测矩阵：pio.ini 优先于 IDF 双标志、裸 CMake 无 IDF 信号拒绝、
> sdkconfig 或 project.cmake include 两路识别；扫描：声明 env 与磁盘 env 目录取并集、
> mtime 新→旧排序 + 路径 tiebreak、非 .elf/嵌套目录/缺失 build 根过滤、未构建工程
> 空候选）；ProjectManager 15 项新增（41 总：link 持久化 meta.external 且重开保留、
> archOk 按工程芯片族标注（52 字节头封端读取）、[BB-127] 拒绝且 meta 零写、
> [BB-124]/[BB-128] 状态错误、链接目录消失 [BB-128]、缺省取最新与显式路径两种导入、
> 非候选路径 [BB-129]、空构建 [BB-129]、错架构 [BB-101] 且不留 firmware.elf、
> 幂等 unlink、畸形 external [BB-121]、saveProject 重写 meta 保留关联）；
> IPC 契约 5 项新增（31 总：四通道注册对齐、路由透传、8 种畸形负载 [BB-130]
> 拒绝且未触达 ProjectManager）；external-firmware.integration 3 例经真实
> preload→handlers→ProjectManager 链路（双向 JSON 边界）——PlatformIO 双 env
> 关联→重构建后 rescan 发现新 ELF→显式选旧 env 导入→重开持久化→unlink 后
> scan 转 [BB-128]；ESP-IDF build/*.elf 缺省最新导入；[BB-127]/[BB-129]
> 跨边界传播。UI 层 14 项新增（143 总：externalDraft 11 项标签/格式化/
> 导入挑选/汇总行 + projectStore 3 项 external/firmwareElf 水合与复位）。
> 真实 QEMU e2e 不适用（本任务不触碰仿真链路）；导入产物 firmware.elf 复用
> sim:load 的 [BB-101] 架构门控（该路径已被 qemu-uart/s3-machine e2e 在真实
> QEMU 上验证）。PRD §F-PROJ-3 与 §6.6 proj:* 通道列表已同步（追加式扩展）。
> 设计要点：关联只记 {kind, dir} 于 meta.json（工程可移植，外部工程路径是
> 宿主本地状态）；扫描模块纯读盘零写入；导入的显式路径必须是当前扫描候选
> 之一（杜绝经此通道复制任意文件）；archOk 仅是提示，真正的门控仍是导入时的
> validateFirmware。
> 迭代暴露并已修复两个开发期问题：① 测试夹具 bug——makePioProject 在创建
> 根目录前写 platformio.ini 致 7 例 ENOENT（修 helper 顺序，非产品代码）；
> ② UI 类型缝——externalDraft 引用了 bridge.ts 未导出的 ExternalProjectKind，
> typecheck 拦截后补导出。自我审查补回一处覆盖缺口：saveProject 重写 meta 时
> external 关联的保留回归测试。

> P4.4 验证记录（2026-09-15）：`pnpm typecheck` 0 错误；全仓测试 Windows 555
> 通过 + 13 跳过（门控 e2e，同 P4.3 基线；较 P4.3 净增 12 项）。分三层验证——
> GdbBridge 19 项 mock GDB/MI 集成测试（新增 4 项：-break-insert -c 条件插入且
> -break-list 回读 cond、-break-condition 设/清条件含 [BB-113] 未知编号错误路径、
> write/read/access 三种 -break-watch 插入并以 watchpoint 行回读、watchpoint 与
> breakpoint 共用 -break-delete 移除、多词表达式 MI 引号线格式冻结）；mock-gdb
> 扩展为真实 GDB 线形状（-break-insert 可选 -c 解析、-break-watch 按模式返回
> wpt/hw-rwpt/hw-awpt 结果键、-break-list watchpoint 行以 what 携带表达式、
> -break-condition 设/清）；IPC 契约 35 项（新增 4：dbg:setConditionalBreakpoint/
> dbg:setWatchpoint/dbg:conditionBreakpoint 路由与 mode 缺省 write、8 种畸形负载
> [BB-131] 拒绝且未触达 GDB）；debuggerStore 15 项（新增 4：条件断点/watchpoint
> 动作转发负载并回读列表、条件清空往返、bridge 错误面不污染断点状态）。
> UI 层 Inspector 新增条件输入（If）与 Watchpoints 区（表达式 + write/read/
> access 模式），断点列表内联渲染 watch/if (…)。
> 真实 QEMU e2e 不适用（本任务不触碰 QEMU 设备与固件加载链路）；GDB/MI 方言
> 变更经扩展 mock 按真实线形状冻结，既有 GDB 门控 e2e（gdb-breakpoint/
> debug-panel，需 BREADESP_GDB_BIN + 真实 QEMU）在工具链在场时复验共享会话
> 路径（最近一次 P1.9 于 WSL 真实 xtensa-esp32-elf-gdb 验证通过）。
> 设计要点：watchpoint 停机沿用既有 dbg:stopped 推送（reason 为
> watchpoint-trigger 等三态），零新增推送通道；BreakpointRow 的 kind/cond 为
> 追加式扩展（§6.6 兼容，旧消费者忽略新字段）；-break-condition 的表达式为
> 行尾参数（GDB 语义），空串即清条件。

> P4.5 验证记录（2026-09-18）：`pnpm typecheck` 0 错误；全仓测试 Windows
> 581 通过 + 14 跳过（门控 e2e；shell 包带 BREADESP_GDB_BIN 时 250 通过 +
> 12 跳过）。分四层验证——DAP 帧协议 9 项单测（Content-Length 往返、字节级
> 分块/合帧、未知头与大小写容忍、UTF-8 字节计数、残帧缓冲、缺头/非数字
> Content-Length [BB-132] 拒绝）；GdbBridge 24 项 mock 集成测试（新增 5：
> stackFrames 解析 `-stack-list-frames`、stepOut/-exec-finish 的
> function-finished 停止、interrupt/-exec-interrupt 的 signal-received 停止、
> removeBreakpoints 批量 -break-delete、env 透传 XTENSA_GNU_CONFIG 进子进程）；
> DAP 会话 12 项集成测试（mock GDB/QEMU 双 seam，in-memory 传输 + TCP socket
> 双模式：initialize→attach→函数断点→configurationDone→threads/stackTrace/
> scopes/variables/evaluate 全链路、复杂类型变量经 evaluate 回落、断点集合
> 整组替换的线格式冻结、GDB ^error 降级 verified=false、协议误用/[BB-132]/
> 未知命令/未知 variablesReference 全部可读错误响应、stopOnEntry 报 entry
> 停止且不自动续跑、launch 模式拉起 mock QEMU 且 disconnect 回收 VM、畸形
> 帧终止会话；另 XtensaDynconfig 3 项：按芯片选 ../lib/xtensa_<chip>.so、
> RISC-V/缺库返回 undefined、用户设置优先）；真实 QEMU + esp-gdb 17.1 e2e
> （dap-launch.e2e.test.ts）——launch→函数断点 app_main 命中→stackTrace 两帧
> →寄存器 pc→evaluate $pc→stepIn→UART output→disconnect terminateDebuggee，
> 全链路通过；既有 gdb-breakpoint e2e（P0.5 验收）同环境首次在 Windows 本机
> 真实通过。金标固件与 QEMU 设备零改动。
> 自我迭代抓出并已修复四个真实问题：① stackFrames() 漏解 MI 结果列表的
> `frame={...}` 单键包装（与 -break-list 的 bkpt 同构，单测抓出）；② threads
> 漏初始化门控（误用测试暴露）；③ **esp-gdb 17.1 与 QEMU stub 寄存器布局
> 不匹配**——内建配置 388 字节 'g' 包对 628 字节回复报 "Remote 'g' packet
> reply is too long"，RSP 探针确认 stub 不提供 tdesc 协商、工具链不带 XML，
> 最终定位 esp-gdb 17.x 的 dynconfig 机制（`XTENSA_GNU_CONFIG` 指向
> `lib/xtensa_<chip>.so`），以 `XtensaDynconfig.ts` 下沉到 GdbBridge（按
> chip 自动选择，dbg:connect 与 DAP 共同受益，`QemuRunner.getChip()` 新增，
> 既有 gdb-breakpoint e2e 由此首次在本机转绿）；④ 附着冻结 VM 的无 reason
> 首停需消费后再等断点命中（真实 GDB 行为，e2e 抓出）。
> 设计要点：launch 模式下 QemuRunner 全程保持 loaded，continue 走 GDB
> `-exec-continue`（stub 恢复 vCPU）而非 QMP cont——双重恢复会撕裂 GDB 与
> VM 的停走状态；QEMU stdout 经 backend 以 stdout 类 output 事件转发；
> DAP 协议零新运行时依赖（§5 不变），PRD §7 目录同步追加 dap/ 四文件与
> XtensaDynconfig.ts；用法文档 docs/dap.md。

### M2 清单
- [x] TFT 渲染 rgb565 彩图
- [x] 蜂鸣器按 PWM 频率发声
- [x] 喇叭播放 I2S 正弦波
- [x] 示波器显示 GPIO 波形
- [x] 仿真可暂停/继续/调速

### M3 清单
- [x] 麦克风注入后固件读到采样
- [x] 本地麦克风实时输入可用
- [x] 波形生成器可选正弦/方波/噪声

### M4 清单
- [ ] 同一工程可在 ESP32 与 ESP32-S3 跑通
- [x] PlatformIO 工程 `build/*.elf` 自动被发现
- [x] 条件断点/watchpoint 可用
- [x] DAP 接入 VS Code 可调试

### M5 清单
- [x] 第三方包 `registerPeripheral()` 后 UI 自动出现新器件
- [ ] 外设打包脚手架可生成可发布包
- [ ] 文档站与教程上线

---

## 附录 A：常用命令速查

```bash
# 初始化
pnpm install
pnpm fetch-qemu

# 日常
pnpm typecheck
pnpm test
pnpm dev

# 单包
pnpm --filter @breadesp/peripherals test

# Lint（M0 配置后）
pnpm lint
pnpm format
```

## 附录 B：参考资料
- QEMU-ESP32: https://github.com/espressif/qemu
- ESP-IDF: https://docs.espressif.com/projects/esp-idf/
- GDB Machine Interface: https://sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI.html
- Conventional Commits: https://www.conventionalcommits.org/
- Wokwi（竞品参考）: https://wokwi.com/
