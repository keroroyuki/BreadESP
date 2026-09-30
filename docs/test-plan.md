# BreadESP 测试方案（AI 可读）

> 本文档是 BreadESP 项目的**测试执行手册**，配合 [`PRD.md`](../PRD.md)（需求真相源）与
> [`docs/dev-plan.md`](./dev-plan.md)（开发计划）使用。
> 面向 AI Agent 编写：结构编号化、路径精确化、每个待办测试项有稳定 ID 与验收标准。
> 生成基线：commit `06c604c`（P5.4 完成），全仓 783 个 `it()` 用例，Windows 全量绿（769 通过 + 14 门控跳过）。
> 2026-09-30 更新：F-BB-5 撤销/重做入账（ui +8），实测全仓 790 个 `it()` 用例，Windows 全量绿（776 通过 + 14 门控跳过）。

---

## 0. 使用指南（给 AI Agent）

- 新增/修改代码前，先读本文件 §3 对应包的"现有覆盖"，**禁止重复造已冻结的用例**。
- 每个测试任务完成后：跑 `pnpm typecheck && pnpm test`，并在 §5 backlog 中勾销对应 ID。
- 测试代码 MUST 遵守 §2.4 约定（命名、断言、PRD 引用、错误码断言风格）。
- 带 `E2E` 标记的用例需要 §2.2 的环境变量门控；本地缺二进制时它们自动 skip，不算失败。
- 本文档与代码冲突时，以 PRD.md 为最终裁决；发现本文档过时 MUST 同步更新。

---

## 1. 项目与测试现状总览

### 1.1 项目结构速览

BreadESP = ESP32 虚拟面包板仿真器（Electron 桌面应用），pnpm monorepo，六包分层：

```
packages/ui (React 渲染进程) ──IPC──> packages/shell (Bridge/主进程) ──socket+QMP──> QEMU-ESP32
                                             │
                    packages/peripherals (外设模型，跑在 Bridge)
                    packages/netlist (网表 schema/校验，双进程共用)
                    packages/sim-core (QEMU 参数构造 + ELF 解析 + dbus 设备 C 源码 + 金样固件)
packages/docs-site (离线文档站构建器，纯工具链)
scripts/ (fetch-qemu / build-qemu-device / 10 个 make-*-elf 固件生成器)
```

### 1.2 测试规模基线（783 用例）

| 包 | src 文件 | 测试文件 | 用例数 | 测试类型构成 |
|---|---|---|---|---|
| `packages/shell` | 20 (~3990 行） | 34 vitest + 2 冒烟 + 2 helpers | **317** | 13 单元（271) + 5 集成（26) + 16 e2e(20，全部门控） |
| `packages/ui` | 46 (.ts+.tsx) | 18 | **182** | 全部单元（纯逻辑/store/渲染器绑定，含 F-BB-5 撤销重做契约 8 例），.tsx 组件零测试（dev-plan §7.2 策略） |
| `packages/peripherals` | 13 | 10 | **163** | 全部单元（模型 + 注册表） |
| `packages/docs-site` | 9 | 6 + helpers | **81** | 单元为主 + 真实 HTTP（serve) + 真实仓构建 |
| `packages/sim-core` | 3 (+2235 行 C) | 3 | **28** | 单元 + 金样固件不变量 |
| `packages/netlist` | 5 | 2 | **19** | 单元 |
| `scripts/` | 14 个 .mjs | 0 | **0** | **无任何自动化测试**（`dev.mjs` 为开发编排脚本，纯 spawn/端口轮询） |

### 1.3 最近基线运行（本次分析实测）

```
corepack pnpm -r test   → exit 0
shell: 303 passed + 14 skipped (13 门控文件)   ui: 182 passed   sim-core: 28 passed
docs-site / netlist / peripherals: 全绿         总计 ≈776 passed + 14 skipped
```

- 本机已具备 `BREADESP_QEMU_BIN`（qemu-uart×2、s3-machine×3、gdb-breakpoint×1 真实执行）。
- 14 个 skip = 11 个 breadesp-dbus 设备版 e2e（缺 `BREADESP_QEMU_DBUS_BIN`）+ dap-launch、debug-panel、gdb-breakpoint 第 2 例（缺 `BREADESP_GDB_BIN`）。

---

## 2. 测试基础设施与运行规程

### 2.1 命令矩阵

| 命令 | 作用 | 何时用 |
|---|---|---|
| `pnpm test` | 全仓 vitest（`pnpm -r test`） | 提交前必跑 |
| `pnpm typecheck` | 全仓 tsc strict | 提交前必跑 |
| `pnpm --filter @breadesp/<pkg> test` | 单包测试 | 开发循环 |
| `pnpm --filter @breadesp/shell exec vitest run tests/X.test.ts` | 单文件 | 调试单点 |
| `pnpm build` | 全仓构建（shell tsc + ui tsc/vite） | 里程碑回归 |
| `pnpm docs:check` | 文档站链接门（零写入） | 改 docs 后 |
| `node scripts/make-<x>-elf.mjs --check` | 单个金样固件漂移自检 | 改 scripts/lib 后（目前手动，见 TP-001） |
| `pnpm --filter @breadesp/shell exec tsx tests/manual-smoke-p52.ts` | P5.2 纯 Node 冒烟 | 改 catalog 后 |
| `pnpm --filter @breadesp/shell exec tsx tests/manual-smoke-p53.ts` | P5.3 纯 Node 冒烟 | 改 scaffold 后 |

注意：shell 包 vitest 配置为**单线程串行**（`packages/shell/vitest.config.ts`），因为多个 e2e 会拉起真实 QEMU，并行会让客户机争抢宿主 CPU 导致时序断言抖动。新增 e2e 时不得破坏该配置。

### 2.2 环境变量门控表

| 变量 | 门控的测试 | 获取方式 |
|---|---|---|
| `BREADESP_QEMU_BIN` | qemu-uart(2)、s3-machine(3)、gdb-breakpoint(2，还需 GDB) | `pnpm fetch-qemu` |
| `BREADESP_QEMU_DBUS_BIN` | dbus-device、netlist-routing、spi-st7789、pwm-buzzer、i2s-speaker、gpio-scope、sim-speed、mic-i2s、mic-capture、knob-gpio、sht30-i2c（各 1） | `node scripts/build-qemu-device.mjs`（产物 manifest `packages/sim-core/bin/qemu-breadesp.json`，linux-docker 产物仅 Linux 可跑） |
| `BREADESP_GDB_BIN` | debug-panel、dap-launch、gdb-breakpoint 第 2 例（各 1） | ESP-IDF 工具链的 `xtensa-esp32-elf-gdb`；esp-gdb 17.x 经 `XtensaDynconfig` 自动配 `XTENSA_GNU_CONFIG` |
| `BREADESP_PERIPHERALS_DIR` | PluginCatalog 测试注入临时目录（测试内自管，非门控） | 缺省 `~/.breadesp/peripherals` |

门控 helper：`packages/shell/tests/helpers/dbus-qemu.ts`（`resolveDbusQemuBin()`，跨平台路径归一化）。**新增需要设备版 QEMU 的 e2e MUST 复用该 helper。**

### 2.3 测试分层定义（dev-plan §7.1）

| 层 | 文件后缀 | 运行环境 | 断言对象 |
|---|---|---|---|
| 单元 | `*.test.ts` | vitest，纯 Node | 纯函数/模型/解析器，mock 边界 |
| 集成 | `*.integration.test.ts` | vitest，真实 IPC 面（preload→handlers→真实服务） | 跨包链路 + JSON 边界 + 错误码穿透 |
| 端到端 | `*.e2e.test.ts` | vitest，真实 QEMU/GDB 子进程 | 金样固件行为（UART 标记/快照内容） |
| 手动冒烟 | `manual-smoke-*.ts` | tsx 直跑，非 vitest | 纯 Node 运行时的真实用户旅程 |

### 2.4 测试编写约定（硬约束）

1. 文件位置：`<pkg>/tests/<被测名>.test.ts`；文件头 MUST 注 `// PRD: §X.Y — 一句话`。
2. 命名：`describe('<module>', ...)` + `it('does X when Y', ...)`；断言用 `expect`，优先正向断言。
3. 错误码断言 MUST 精确匹配 `[BB-xxx]` 前缀字符串（如 `rejects.toThrow('[BB-224]')`），禁止只断言"抛错"。
4. 边界负载校验测试 MUST 断言"未触达下游"（如 mock 的 catalog/ProjectManager 未被调用）。
5. 禁止删除既有测试让其通过（dev-plan §9.3）；修改既有断言必须在 commit message 说明原因。
6. 金样固件路径：`packages/sim-core/fixtures/`，测试用相对路径引用。
7. UI 文案/测试名用英文；注释可中文（PRD §10.7）。
8. 新模块落地即配测试——无测试的代码视为未完成（dev-plan §1.1）。

### 2.5 测试接缝与共享夹具（复用清单）

| 接缝 | 位置 | 用法 |
|---|---|---|
| `argsBuilder` 注入 | `QemuRunner.load` / `GdbBridge.start` / `QemuGdbBackend`（三缝） | mock 子进程全 argv 覆盖，替代真 QEMU/GDB |
| `now()` 时钟注入 | `PeripheralManager` 构造器 | 30fps 快照节流确定性测试 |
| `throttleQuantumMs` | `QemuRunner` 选项 | 缩小占空比周期加速节流测试 |
| `HandlerDeps` 对象注入 | `ipc/handlers.ts registerIpcHandlers` | 假 ipcMain/webContents 钉通道清单 |
| in-memory DAP 客户端 | `shell/tests/helpers/dap-client.ts`（PassThrough） | 无 socket 驱动 DapServer.serve() |
| 设备版 QEMU 解析 | `shell/tests/helpers/dbus-qemu.ts` | e2e 门控统一入口 |
| 临时目录夹具 | Project/External/Catalog/Scaffold 测试 | `mkdtemp(tmpdir())` + 清理 |
| mock GDB/QEMU 子进程 | GdbBridge/DapServer/QemuRunner 测试 | 脚本化 MI/QMP 线格式对答 |
| 假 AudioContext / 2d context | ui 音频与渲染器测试 | 记录式 stub 断言接线与绘制调用 |
| catalog rootDir 参数 | `PluginCatalog` 构造器 | 扫描隔离（也认环境变量） |

---

## 3. 分包测试方案（现状清单 + 缺口 + 新增设计）

### 3.1 packages/sim-core（28 用例，充分但有 fixture 盲区）

**现有覆盖**：
- `args.test.ts`（10）：`buildQemuArgs` 逐标志断言——`-kernel` 直启、四芯片 machine 映射、族→系统二进制映射、`-serial stdio`/`-nographic`/`-nic none` 默认、`noNetwork:false` 保留网络、`-S` 冻结、GDB/QMP 端口绑 loopback、dbus unix socket/TCP 互斥校验。
- `elf.test.ts`（8→11 实测）：`readElfHeader`/`expectedElfMachine`/`validateElf`——金样解析、截断/坏 magic、大端、EM_XTENSA=94/EM_RISCV=243 交叉接受拒绝矩阵、EM_ARM 拒绝且消息含期望值、ELF64/非可执行拒绝。
- `blink-elf.test.ts`（6）：blink.elf 字节级不变量——ELF32 LSB Xtensa ET_EXEC、单一 RWX PT_LOAD@0x40080000、`_start`/`app_main` FUNC 符号、`led_state` 全局+`led_state_written` 标签、`Hello ESP32\r\n` 负载、DWARF4 段。

**缺口**：
- G1: 其余 9 个金样固件（buzzer/i2c/knob/mic/s3-blink/sht/speaker/spi/uart-echo）无字节级不变量测试。
- G2: `device/breadesp_dbus.c`（2235 行 C）零单测，仅靠 e2e 黑盒。
- G3: `make-*-elf.mjs --check` 漂移自检无任何自动化入口（见 §3.7）。

### 3.2 packages/netlist（19 用例，充分）

**现有覆盖**：
- `validate.test.ts`（11）：validateNetlist 合法接受/四芯片 chip 全过/重复 instanceId 拒绝/未知实例导线拒绝/schema 违规拒绝；validateLayout 合法/未知 version/非数值非有限坐标/重复 instanceId/非对象不抛。
- `templates.test.ts`（10 含子用例）：模板注册表顺序、每模板×每芯片产物双过 validateNetlist+validateLayout、empty/blink-led/oled-ssd1306 三模板语义、每芯片默认 I2C0 引脚表、未知模板/不支持芯片拒绝、防御性拷贝、按芯片过滤保序。

**缺口**：
- G4: schema.ts 的细枝末節分支（wire id 重复、layout 边界坐标、peripheral props 任意 JSON）仅经 zod 默认行为覆盖，无显式用例。优先级低（zod 背书）。

### 3.3 packages/peripherals（163 用例，两个 MVP 模型裸奔）

**现有覆盖**（按模型）：
- `ssd1306.test.ts`（15）：Adafruit_GFX begin+display 整帧、页/水平/垂直三种寻址、列 nibble 回绕、orientation 矩阵、0xA4-0xA7 反色/强制点亮、熄屏空白、start line 移位、Co=1 单字节帧、无控制字节续流、异地址/读过滤。
- `st7789.test.ts`（13）：TFT_eSPI init 全帧、DC 电平逐帧、半像素跨帧、CASET/RASET 窗口与回绕、MADCTL 旋转（含 drawPixel 局部窗口）、BGR 交换、熄屏/休眠、INVON/INVOFF、任意命令终止 RAMWR、SWRESET 上电态、CS 过滤、缺 dc 一次告警。
- `buzzer.test.ts`（14）：pwm 路径（厘赫小数、零占空/零频静默、稳态去重、变调、占空钳制、截断忽略、读/异类过滤）+ gpio bit-bang 沿测频（4 沿下限、漂移带去重、频率跟踪、超音频段拒绝）。
- `speaker.test.ts`（13）：s16le 立体声混单声道、8/16/24 位解码与符号扩展、截断头/零率/零声道/非法位宽拒绝、部分尾帧丢弃、≥512 采样批量阈值、跨事务分帧重组、格式变更按旧率冲刷、异类/读过滤、工厂元数据。
- `oscilloscope.test.ts`（16）：viaPin 通道归属、方波周期重建、同电平去重、窗口滚动剪枝、边缘上限、无 viaPin/未知引脚/读/非有限时间戳过滤；PWM 稳态合成展开（占空、停止出平轨、真实 gpio 写取代合成、截断忽略、极速封顶）；快照全窗重述态+去重。
- `mic.test.ts`（33）：props 钳制回退、四波形生成（相位连续/对称轨/噪声确定性有界/静音全零）、8/16/24/32 位编码、interval 逐块注入、dispose 停发、无注入通道一次告警、drainResampled 重采样 5 例、采集路径 10 例（覆盖 synth/重采样/饥饿/500ms 回退/stale 清除/源率变更/1s 上限/畸形块/超幅钳制/mono 复制）。
- `knob.test.ts`（15）：props 钳制、Gray 相位表、单 detent 四迁移逐针脚、CCW 逆序、混合方向净额、连击钳制 ±64、未接线一次告警、无 drivePin 告警、dispose 停队列、工厂元数据。
- `sht30.test.ts`（21）：props 校验、CRC-8 datasheet worked example（0xBEEF→0x92）、25°C/50% 金标向量、量程端点、六种测量命令字、状态寄存器 heater 位、异地址/读/异类/子字长过滤、周期模式告警、text 快照、格式化行。
- `registry.test.ts`（19）：内建集注册+幂等+自校验、第三方注册/[BB-221]/listPeripherals 新鲜数组、[BB-220] 形状矩阵（kind/version/displayName/pins/defaults/sdkVersion）、[BB-222] SDK major 门控、semver 助手。
- `remote.test.ts`（5）：registerRemotePeripheral 元数据存根+[BB-207] 警戒+全套门控重过、unregisterPeripheral 移除/未知 false。

**缺口**：
- G5: **`led.ts`（40 行）与 `button.ts`（33 行）无专属单元测试**——两个 MVP 外设（F-PER-1/F-PER-2）仅靠 e2e/集成间接覆盖。见 TP-002。
- G6: led 的 PWM 亮度路径是 TODO（`// TODO(PRD §F-PER-1)`），实现时需同步补测试。

### 3.4 packages/shell（317 用例，主干充分，边缘有缺口）

**现有覆盖**（详见 §6 错误码索引）：
- 单元 13 文件 271 例：QemuRunner(12)、QmpClient(6)、DBusChannel(14)、MiParser(9)、GdbBridge(24)、DapProtocol(9)、NetlistResolver(28+3)、PeripheralManager(25)、PluginCatalog(23)、PeripheralScaffold(24)、ProjectManager(41)、ExternalProject(18)、ipc-contract(38)。
- 集成 5 文件 26 例：DapServer(12)、catalog(5)、external-firmware(3)、project-roundtrip(5)、dbus-throttle(1)。
- e2e 16 文件 20 例（全部门控，见 §4 矩阵）。
- 冒烟 2 个：manual-smoke-p52/p53（纯 Node tsx）。

**缺口**：
- G7: `main.ts`（43 行 Electron 装配）无任何测试——无 Electron 应用级冒烟（M1 清单中 3 项 UI 验收仍勾选未完成，靠手动回归）。
- G8: `debugger/dap/cli.ts`（36 行）无测试——`--port` 解析、exit 2 路径、**stdio 模式 stdout 纯净性**（日志污染 stdout 即破坏 DAP 协议）无保护。见 TP-004。
- G9: `preload.ts` 仅通道清单被钉死；`onXxx` 解订阅闭包与参数透传无行为测试。
- G10: `QemuGdbBackend` 无直接单测——attach 重试窗口（200ms/10s deadline）、断点集替换语义仅经 DapServer 集成间接覆盖。
- G11: `ProjectManager` 写盘非原子（无 tmp+rename），中途崩溃可留半文件，无测试钉住该行为（设计决策待 PRD 澄清）。
- G12: 已知 flake——`DapServer.integration.test.ts` launch-flow 计时敏感（dev-plan P5.2 记录，曾单条瞬态失败，复测绿）；`sim-speed.e2e` 的 0.25x 占空比带在负载高的机器上有余量风险。

### 3.5 packages/ui（182 用例，纯逻辑全覆盖，组件层按策略裸奔）

**现有覆盖**（18 文件全单元）：
- store 5 件：projectStore(29，网表/布局分离不变式+外部固件态+F-BB-5 撤销/重做契约：≥20 步保留、混合编辑全链撤销、redo/新编辑清 future、拖拽逐帧合并、无效操作不入栈、空栈 no-op、load/reset 清栈)、debuggerStore(15，状态机+P4.4)、marketplaceStore(8)、captureStore(6)、simulationStore(3)。
- 纯逻辑 6 件：wizardDraft(6)、externalDraft(11)、marketplaceDraft(7)、sensorDraft(7)、wavegenDraft(13)、paletteEntries(4)。
- 渲染/几何 3 件：pinLayout(6)、genericNode(9)、traceBuilder(13)、TftRenderer(13)。
- 音频 3 件：BuzzerAudio(14)、SpeakerAudio(11)、MicCapture(8)。

**缺口**：
- G13: **`OledRenderer.ts`（17 行 mono→Canvas）无测试**——TftRenderer 有 13 例而它裸奔，明显不对称。见 TP-003。
- G14: `ipc/bridge.ts`（190 行类型化封装）无专属测试——仅经 store 测试的 mock 间接对齐。见 TP-005。
- G15: 全部 28 个 .tsx 组件零测试（dev-plan §7.2 明确"M5 再评估"，现已过 M5——应重新评估）。最大风险文件：`BreadboardCanvas.tsx`（拖拽/连线交互状态机与渲染耦合；撤销/重做栈已于 2026-09-30 落到 projectStore 层并有 8 例契约测试，组件仅剩 Ctrl+Z/Y 快捷键绑定与输入焦点保护未钉）。见 TP-006。
- G16: `App.tsx`/`main.tsx` 装配无冒烟。

### 3.6 packages/docs-site（81 用例，充分）

**现有覆盖**：markdown(34)、site(11)、links(11)、build(10，含双构建字节可复现+真实仓构建)、cli(9，真实构建+serve)、serve(5，真实 HTTP+穿越拒绝+MIME+no-store)。

**缺口**：
- G17: `theme.ts`（214 行 HTML 壳+CSS）无专属单测——标题转义、active 标记、toc-h3 层级、无 TOC 布局分支仅经 build.test.ts 间接断言。
- G18: markdown 方言的"刻意不支持"面（缩进代码块/`~~~` 围栏/下划线强调）无拒绝性测试钉住退化行为。
- G19: serve.ts 的 bind 失败路径（端口占用 reject）未测。

### 3.7 scripts/ 与金样固件（0 用例，最大裸奔区）

**现状**：13 个 .mjs 脚本无任何 vitest 覆盖——
- `fetch-qemu.mjs`（231 行，SHA256 信任链）、`build-qemu-device.mjs`（416 行，Docker/MSYS2）含网络/子进程重依赖，单测化成本高，可接受手工验证。
- **`lib/xtensa-elf.mjs`（413 行指令编码器）+ 10 个 `make-*-elf.mjs` 是纯确定性代码**，自带 `--check` 漂移自检，但**没有任何自动化入口执行它**——改编码器表忘重生成 fixture 时，除 blink.elf 外无测试会失败。

见 TP-001（最高优先级）。

---

## 4. 真实链路（e2e）测试矩阵

全部位于 `packages/shell/tests/`，门控变量见 §2.2。金样固件由 `scripts/make-*-elf.mjs` 确定性生成。

| e2e 文件 | 金样 | 验证的 PRD 契约 | 门控 |
|---|---|---|---|
| qemu-uart（2 例） | blink.elf、uart-echo.elf | F-SER-1/2：UART0 输出 + stdin 注入回显 | QEMU_BIN |
| s3-machine（3 例） | blink.elf、s3-blink.elf | F-FW-3：esp32/esp32s3 启动；Xtensa 二进制跑 riscv machine 响亮失败 | QEMU_BIN |
| gdb-breakpoint（2 例） | blink.elf | F-DBG-1/5：RSP halt + app_main 断点命中（P0.5 验收） | QEMU_BIN + GDB_BIN |
| debug-panel（1 例） | blink.elf(DWARF4) | F-DBG-1..3：断点/步进/局部/全局/寄存器 | 同上 |
| dap-launch（1 例） | blink.elf | F-DBG-6：DAP launch→断点→stack/regs/evaluate→step→disconnect | 同上 |
| dbus-device（1 例） | i2c.elf | §6.7：GPIO+I2C 事务长度前缀帧 | DBUS_BIN |
| netlist-routing（1 例） | i2c.elf | §4.2/§6.5：OLED 事务落 oled1、GPIO2 落 led1 | DBUS_BIN |
| spi-st7789（1 例） | spi.elf | F-PER-4：CS 路由 SPI 渲染像素流 | DBUS_BIN |
| pwm-buzzer（1 例） | buzzer.elf | F-PER-5：LEDC 440→880Hz→tone 快照 | DBUS_BIN |
| i2s-speaker（1 例） | speaker.elf | F-PER-6：I2S DMA 正弦→audio 快照 | DBUS_BIN |
| gpio-scope（1 例） | blink.elf | F-PER-8：GPIO2 方波捕获 | DBUS_BIN |
| sim-speed（1 例） | blink.elf | F-SIM-1/2/4：暂停/恢复/QMP 占空比节流 | DBUS_BIN |
| mic-i2s（1 例） | mic.elf | F-PER-7：i2s-in 反向注入进 RX DMA 环 | DBUS_BIN |
| mic-capture（1 例） | mic.elf | F-PER-7：宿主采集重采样注入 | DBUS_BIN |
| knob-gpio（1 例） | knob.elf | F-BB-3：gpio-in 正交序列→detent 计数 | DBUS_BIN |
| sht30-i2c（1 例） | sht.elf | F-BB-3：i2c-out 邮箱供固件读测量值 | DBUS_BIN |

**e2e 编写规程**：新 e2e MUST 复用 `tests/helpers/dbus-qemu.ts` 门控；固件 MUST 由确定性生成器产出并支持 `--check`；断言 MUST 含"无广播泄漏"（仅目标实例产快照）与 UART 完成标记。

---

## 5. 测试缺口 Backlog（按优先级）

> 每项有稳定 ID；完成后在 checkbox 打勾并记录日期。估计按"AI 生成 + 人工审查"节奏。

### P0 — 立即做（低成本高价值，回归风险敞口）

- [ ] **TP-001** 金样固件漂移自检自动化（G1+G3）
  - 目标：`scripts/make-*-elf.mjs --check` × 10 进入 vitest。
  - 做法：新增 `packages/sim-core/tests/fixtures-check.test.ts`，对每个生成器 spawn `node scripts/make-<x>-elf.mjs --check`（秒级、确定性），非零退出即失败；对 9 个无不变量测试的 fixture 补最低限度字节断言（ELF32/正确 e_machine/入口符号存在）。
  - 验收：`pnpm --filter @breadesp/sim-core test` 含 10 个 --check 用例且全绿；故意改动 `scripts/lib/xtensa-elf.mjs` 某编码后测试变红（验证后还原）。
  - 估计：0.5 天。

- [ ] **TP-002** led/button 模型单元测试（G5）
  - 目标：新增 `packages/peripherals/tests/led.test.ts` 与 `button.test.ts`。
  - 测试点：led——gpio write 0/1→level 快照、同电平去重、非 gpio/读事务忽略、PWM 事务当前忽略（钉住 TODO 行为）、工厂元数据（pins A/gpio-out + K/gnd optional）；button——onTransaction 空操作、工厂元数据（pins 1/gpio-in + 2/gnd）、create 的 instanceId 透传与缺省 uuid。
  - 验收：两文件全绿；`registerBuiltins` 自校验仍全过。
  - 估计：0.5 天。

- [ ] **TP-003** OledRenderer 单元测试（G13）
  - 目标：新增 `packages/ui/tests/OledRenderer.test.ts`，对齐 TftRenderer.test.ts 结构。
  - 测试点：mono 1bpp 位解包（MSB-first 字节序）、128×64 几何、on/off 像素 RGBA 值、画布 backing store 尺寸调整、无 2d context 静默返回、与 SSD1306 `pixels` 快照形状的集成缝。
  - 验收：≥8 例全绿。
  - 估计：0.5 天。

### P1 — 近期做（契约保护）

- [ ] **TP-004** DAP CLI 与 stdout 纯净性测试（G8）
  - 目标：新增 `packages/shell/tests/dap-cli.test.ts`。
  - 测试点：`--port` 解析（合法/非法/缺值→exit 2 + stderr 用法）、stdio 模式装配；**关键**：stdio 模式下 `runDapCli` 全程 stdout 只出 DAP 帧（`[breadesp-dap]` 日志必须走 stderr）——用注入 IO 断言 stdout 每块均以 `Content-Length:` 开头。
  - 验收：≥5 例全绿；日志污染 stdout 的回归会变红。
  - 估计：0.5 天。

- [ ] **TP-005** ui ipc/bridge 契约测试（G14）
  - 目标：新增 `packages/ui/tests/bridge.test.ts`。
  - 测试点：每个 bridge 方法→正确的 `window.breadesp` 通道与负载透传；`onXxx` 订阅返回的解订阅函数真实移除监听；window.breadesp 缺失时的错误面。
  - 验收：通道清单与 shell ipc-contract 测试的断言互为镜像（一侧加通道另一侧必须同步）。
  - 估计：0.5 天。

- [ ] **TP-006** BreadboardCanvas 逻辑抽离 + 测试（G15，分两步）
  - Step 1（纯抽离）：把组件中的交互状态机（拖拽中态/连线预览/命中判定）抽为 `components/Breadboard/canvasInteraction.ts` 纯逻辑模块，组件只留 Konva 绑定。撤销/重做栈已于 2026-09-30 落在 projectStore 层（不在抽离范围）。
  - Step 2：新增 `canvasInteraction.test.ts`——放置/移动/连线起止合法性（自环/重复拒绝已在 projectStore 层，此处钉 UI 态）、快捷键触发 store undo/redo（Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z 与文本输入焦点保护，F-BB-5 组件面）、删除实例级联删线。F-BB-5「至少 20 步」的 store 层契约已先行交付（projectStore 8 例）。
  - 验收：抽离后 .tsx ≤300 行；≥12 例全绿；F-BB-5 组件面（快捷键→store 动作）首次有自动化断言。
  - 估计：2 天。**注意**：此为大重构，先确认 PRD §7 允许新增 `canvasInteraction.ts` 路径。

- [ ] **TP-007** QemuGdbBackend 直接单测（G10）
  - 目标：新增 `packages/shell/tests/QemuGdbBackend.test.ts`（mock 三缝：gdbArgsBuilder/qemuArgsBuilder/qemuBinResolver）。
  - 测试点：attach 重试窗口（stub 未就绪→200ms 间隔重试→10s deadline 超时 [BB-110/132]）、断点集整组替换的 MI 线格式、launch 模式 disconnect 回收 VM（QMP quit 被调用）、mode 二态门（重复 launch [BB-132]、未启动 [BB-115]）。
  - 验收：≥8 例全绿；DapServer 集成测试不变。
  - 估计：1 天。

- [ ] **TP-008** theme.ts 专属测试 + markdown 拒绝性测试（G17+G18）
  - 目标：新增 `packages/docs-site/tests/theme.test.ts`；扩充 `markdown.test.ts`。
  - 测试点：renderPage 标题 HTML 转义（`<script>` 入标题不漏）、当前页 active 类、toc-h3 层级、无 h2/h3 时不渲染 TOC 容器；markdown——`~~~~` 围栏退化为段落、缩进代码块不作代码、下划线不斜体（已有部分）补 `_foo_` 字面量断言。
  - 验收：theme ≥6 例 + markdown ≥3 例全绿。
  - 估计：0.5 天。

### P2 — 计划做（健壮性与策略项）

- [ ] **TP-009** preload.ts 行为测试（G9）：onXxx 解订阅闭包、事件负载透传——需 electron mock（`contextBridge.exposeInMainWorld` 捕获暴露面）。估计 0.5 天。
- [ ] **TP-010** ProjectManager 原子写盘（G11）：先提 PRD 议题（tmp+rename 是否入契约），再钉测试。估计 1 天（含契约讨论）。
- [ ] **TP-011** .tsx 组件测试策略重评估（G15/G16，dev-plan §7.2 的 M5 欠账）：选型（@testing-library/react + jsdom 或组件截图），先覆盖 Inspector/SerialConsole 两个高交互组件。估计 2 天。**需先更新 dev-plan §7.2 与 PRD §5（如引入新 devDependency）**。
- [ ] **TP-012** serve.ts bind 失败与 theme 无 TOC 分支（G19 残余）。估计 0.25 天。
- [ ] **TP-013** DapServer launch-flow flake 加固（G12）：将计时敏感断言改为事件序列断言（等事件而非等时长），或提高 mock 子进程启动余量；加固后连跑 20 次全绿。估计 0.5 天。
- [ ] **TP-014** CI 骨架（全仓无任何 CI）：`.github/workflows/test.yml`——`pnpm install && pnpm typecheck && pnpm test`（无 QEMU 门控环境下跑非 e2e 全量，验证 769 绿 + 14 skip 基线）。**需 PRD/dev-plan 同步**。估计 0.5 天。

### 明确不做（防止范围蔓延）

- `breadesp_dbus.c` 的 C 级单测（G2）：需引入 C 测试框架，违背 PRD §5 依赖约束；维持 e2e 黑盒 + 协议字段序 TS 侧冻结现状。重估时机：设备代码大改前。
- `fetch-qemu.mjs`/`build-qemu-device.mjs` 全链路单测：网络/Docker 重依赖；仅在未来抽离纯函数（URL 拼接/checksum 校验/meson 注册文本）后补测。
- C3/C6 riscv32 真实启动 e2e：等待 riscv32 版 QEMU 二进制接入（dev-plan M4 已记录），接入后按 §4 矩阵补 `c3-machine.e2e.test.ts`。

---

## 6. 附录 A：错误码 [BB-xxx] → 覆盖测试索引

| 错误码 | 含义 | 抛出点 | 覆盖测试 |
|---|---|---|---|
| BB-002 | Xtensa 编码器范围断言 | scripts/lib/xtensa-elf.mjs | 无直接（TP-001 间接） |
| BB-003 | blink.elf 缺 .symtab | sim-core/tests/blink-elf.test.ts 自身 | 测试工具码 |
| BB-100 | QEMU/固件二进制不可读 | QemuRunner/QemuGdbBackend | QemuRunner.test.ts、DapServer.integration |
| BB-101 | 固件 ELF 架构不匹配 | ProjectManager.validateFirmware | ProjectManager.test.ts(5 例）、external-firmware.integration |
| BB-102 | 未 load 先 start/writeStdin | QemuRunner | QemuRunner.test.ts(2 例） |
| BB-103 | 未 running 操作 | QemuRunner | QemuRunner.test.ts |
| BB-104 | QMP 连接/请求失败 | QmpClient/QemuRunner | QmpClient.test.ts(6 例全码） |
| BB-105 | 未连调试器先单步 | ipc/handlers | ipc-contract.test.ts |
| BB-110 | GDB 二进制缺失 | GdbBridge/handlers/QemuGdbBackend | GdbBridge.test.ts、ipc-contract |
| BB-111 | GDB 进程异常退出 | GdbBridge | GdbBridge.test.ts |
| BB-112 | GDB 命令超时 | GdbBridge | GdbBridge.test.ts |
| BB-113 | GDB ^error / 无断点号 | GdbBridge | GdbBridge.test.ts（含 watchpoint） |
| BB-114 | GDB 未运行 | GdbBridge | GdbBridge.test.ts、debuggerStore.test.ts |
| BB-115 | 无固件连调试器/会话未启动 | handlers/QemuGdbBackend | ipc-contract、debuggerStore.test.ts |
| BB-116 | 倍率越界 [0.1,10] | QemuRunner | QemuRunner.test.ts(NaN/∞/0/0.05/10.5/-1) |
| BB-120 | 工程目录不存在/非工程 | ProjectManager | ProjectManager.test.ts、project-roundtrip.integration |
| BB-121 | meta.json 畸形（含 external） | ProjectManager | ProjectManager.test.ts(3 例） |
| BB-122 | netlist.json 无效 | ProjectManager | ProjectManager.test.ts、project-roundtrip.integration |
| BB-123 | layout.json 无效 | ProjectManager | ProjectManager.test.ts |
| BB-124 | 无打开工程/工程已存在 | ProjectManager | ProjectManager.test.ts（多例）、external-firmware.integration |
| BB-125 | 未知模板/芯片 | ProjectManager | ProjectManager.test.ts(3 例） |
| BB-126 | proj:new 负载畸形 | ipc/handlers | ipc-contract.test.ts(7 种负载） |
| BB-127 | 非 PIO/IDF 目录 | ProjectManager | ProjectManager.test.ts、external-firmware.integration |
| BB-128 | 无外链/外链失效 | ProjectManager | ProjectManager.test.ts(3 例） |
| BB-129 | 无构建产物/路径非候选 | ProjectManager | ProjectManager.test.ts(3 例） |
| BB-130 | proj:link/importExternal 负载畸形 | ipc/handlers | ipc-contract.test.ts(8 种负载） |
| BB-131 | dbg P4.4 负载畸形 | ipc/handlers | ipc-contract.test.ts(8 种负载） |
| BB-132 | DAP 协议/参数错误 | DapProtocol/DapServer/QemuGdbBackend | DapProtocol.test.ts、DapServer.integration |
| BB-200 | 网表重复 instanceId | PeripheralManager | PeripheralManager.test.ts |
| BB-201 | 外设 onTransaction 抛错隔离 | PeripheralManager | PeripheralManager.test.ts |
| BB-202 | per:captureChunk 负载畸形 | ipc/handlers | ipc-contract.test.ts(9 种负载） |
| BB-203 | per:driveInput 负载畸形 | ipc/handlers | ipc-contract.test.ts |
| BB-204 | per:rotateKnob 负载畸形 | ipc/handlers | ipc-contract.test.ts |
| BB-205 | 输入引脚未接线（一次告警） | PeripheralManager | PeripheralManager.test.ts |
| BB-206 | 未知外设 kind | PeripheralManager | PeripheralManager.test.ts |
| BB-207 | 渲染进程误实例化远端模型 | peripherals/registry | remote.test.ts |
| BB-210 | 麦克风采集失败 | ui/captureStore | captureStore.test.ts |
| BB-220 | 外设工厂形状非法 | peripherals/registry | registry.test.ts（矩阵）、remote.test.ts、PluginCatalog.test.ts |
| BB-221 | kind 重复注册 | peripherals/registry | registry.test.ts、remote.test.ts、PluginCatalog.test.ts |
| BB-222 | sdkVersion major 超宿主 | peripherals/registry | registry.test.ts、PluginCatalog.test.ts |
| BB-223 | 包加载失败/零注册 | PluginCatalog | PluginCatalog.test.ts(5 例）、marketplaceStore.test.ts |
| BB-224 | 加载路径不在当前扫描 | PluginCatalog | PluginCatalog.test.ts、catalog.integration |
| BB-225 | per:catalogLoad 负载畸形 | ipc/handlers | ipc-contract.test.ts、catalog.integration |
| BB-230 | 脚手架请求/用法非法 | PeripheralScaffold/scaffold-cli | PeripheralScaffold.test.ts（矩阵+CLI) |
| BB-231 | 脚手架目标非空 | PeripheralScaffold | PeripheralScaffold.test.ts(2 例） |
| BB-240 | docs CLI 用法错误 | docs-site/cli | cli.test.ts(9 种用法） |
| BB-241 | 文档站内容校验失败 | docs-site/build | build.test.ts(3 例）、cli.test.ts |
| BB-242 | 输出目录安全门/写盘失败 | docs-site/build | build.test.ts(2 例） |

**约定**：新错误码 MUST 先登 PRD 相关章节，再实现，再补本表与测试。

---

## 7. 附录 B：已知 flake 与处理规程

| 用例 | 症状 | 现状 | 处置 |
|---|---|---|---|
| DapServer.integration "launch flow against mock QEMU" | 计时敏感，曾单条瞬态失败 | 复测多轮全绿 | TP-013 加固；单发失败先重跑确认，连续失败才算回归 |
| sim-speed.e2e 0.25x 占空比带 (5%–60%) | 高负载机器上余量风险 | shell 单线程串行已缓解 | 失败时先检查宿主负载 |
| gpio-scope.e2e 沿间距 10% 带 | 与其他 e2e 并行时抖动 | 已由串行配置根除 | 禁止改回并行 |
| Windows stdio 丢 `\r`（QEMU char-win-stdio） | UART 回显断言差异 | 测试统一 `\n` 结尾注入 | 已知平台差异，非 bug |

**flake 处理铁律**：禁止删除/放宽断言让它过；先复跑 3 次定界，再定位时序根因，修复经 ≥5 连跑验证。

---

## 8. 附录 C：提交前自检清单（与 dev-plan §9.2 合并使用）

- [ ] `pnpm typecheck` 0 错误
- [ ] `pnpm test` 全绿（门控 skip 数 = 14，变动需解释）
- [ ] 新测试遵守 §2.4（文件头 PRD 注、错误码精确断言、边界未触达下游）
- [ ] 改了 `scripts/lib/xtensa-elf.mjs` → 跑过全部 `make-*-elf.mjs --check`（TP-001 落地前手动）
- [ ] 改了 PRD §6 契约 → 同步改 ipc-contract/registry/schema 对应测试 + 本文件 §6 索引
- [ ] 新 e2e → 复用 helpers/dbus-qemu.ts 门控 + 金样固件带 --check
- [ ] 完成 backlog 项 → 勾销 §5 对应 ID 并记日期
