# PRD — ESP32 虚拟面包板仿真器（项目代号：BreadESP）

> 本文档是项目的**唯一真相源（Source of Truth）**，面向 AI 代码生成 Agent 编写。
> 任何实现与本文冲突时，以本文为准；如需变更需求，先改本文再改代码。
> AI Agent 在每次生成代码前应通读本文对应章节，并遵循其中的命名、接口、边界约定。

---

## 0. 文档阅读指南（给 AI Agent）

- 本文档使用 RFC 2119 风格的关键词：**MUST / SHOULD / MAY**。
- 凡标记 `§编号` 的章节，AI Agent 在实现相关功能时 MUST 引用以避免漂移。
- 所有接口签名、类型、字段名均为**契约**，AI Agent 不得擅自改名；如需扩展，使用后缀字段并向后兼容。
- 任何"待定 / TODO"项表示当前未决，AI Agent MUST NOT 自行假设，应停在最小可运行实现并标注。
- 目录路径、包名、文件名为**硬约束**，AI Agent 生成的代码 MUST 落在这些路径下。

---

## 1. 项目概述

### 1.1 一句话定位
一个本地运行的 ESP32 系列 MCU 功能级仿真器，提供"虚拟面包板"式图形化外设搭建、真实固件烧录与 GDB 调试能力，定位为教学、原型验证与 CI 自动化测试。

### 1.2 目标用户
- 嵌入式学习者（无硬件也能验证代码）。
- 固件开发者（快速回归测试、外设时序逻辑验证）。
- 教学与培训组织。

### 1.3 非目标（Non-Goals，明确排除）
本项目**不**追求：
- 电气级/SPICE 级电路仿真（不模拟电阻、电容、电流、寄生参数）。
- 纳秒级时序精确性（不保证实时性，使用逻辑时钟）。
- WiFi/BLE 无线协议的真实射频仿真（MVP 仅提供 API 占位，返回 mock）。
- 对非 ESP32 芯片的覆盖（MVP 仅 ESP32 经典款，后续扩展 S3/C3）。

### 1.4 成功标准（MVP 验收）
1. 能加载一个 Arduino 编译的 `blink.elf`，启动仿真，LED 外设在 UI 上随 GPIO 电平亮灭。
2. 能通过 GDB 设置断点、单步、查看全局变量与寄存器。
3. 能在虚拟面包板上拖拽 LED、按键、SSD1306 OLED 并连线到 GPIO。
4. OLED 上能正确渲染固件绘制的图形（帧一致）。
5. 提供 UART 串口控制台，可见 `printf`/`Serial.print` 输出。
6. 全流程在本地（桌面应用）完成，不依赖联网。

---

## 2. 名词与术语表

| 术语 | 含义 |
|---|---|
| 仿真核心 / Sim Core | 负责执行 ESP32 指令与外设总线模型的部分（基于 QEMU-ESP32） |
| 桥 / Bridge | Node.js 进程，管理 QEMU 子进程、GDB、外设模型与 UI 的 IPC |
| 外设模型 / Peripheral Model | 外部器件的行为实现（LED/OLED/蜂鸣器等），运行在 Bridge 侧 |
| 网表 / Netlist | 描述 GPIO↔外设引脚连接关系的结构化数据 |
| 逻辑时钟 / Logical Clock | 仿真推进的离散时间步，非真实墙钟 |
| 设备后端通道 / DBus Channel | QEMU 自定义设备把总线事务转发到 Bridge 的 socket 通道 |
| 工程 / Project | 一个 `.breadesp` 工程目录，含固件、网表、外设配置 |
| DAP | Debug Adapter Protocol（VS Code 调试协议，可选后端） |

---

## 3. 功能需求

### 3.1 固件加载与烧录（F-FW）
- F-FW-1 MUST 支持加载 ELF 固件（带符号，调试必需）。
- F-FW-2 SHOULD 支持加载裸 `.bin`（仅运行，不调试变量）。
- F-FW-3 MUST 支持选择目标芯片型号（MVP：`ESP32`）。
- F-FW-4 MUST 在加载后展示内存映射、入口地址、符号表摘要。
- F-FW-5 MAY 在加载时校验 ELF 架构与芯片型号匹配，不匹配警告。

### 3.2 仿真控制（F-SIM）
- F-SIM-1 MUST 提供：启动、暂停、复位、单步（指令级）、退出。
- F-SIM-2 SHOULD 提供仿真速度倍率（0.1x–10x，逻辑时钟节流）。
- F-SIM-3 MUST 在暂停时允许 GDB 交互。
- F-SIM-4 MUST 仿真状态变更实时广播到 UI（running/paused/stopped/error）。

### 3.3 调试（F-DBG）
- F-DBG-1 MUST 支持：断点（函数/地址/行号）、删除断点、清空断点。
- F-DBG-2 MUST 支持：单步进入、单步跨过、继续运行。
- F-DBG-3 MUST 支持：查看/修改寄存器、查看/修改内存、查看全局/局部变量。
- F-DBG-4 SHOULD 支持：条件断点、观察点（watchpoint）。
- F-DBG-5 MUST 通过 GDB/MI 与 `xtensa-esp32-elf-gdb` 通信；UI 侧封装为统一 `Debugger` 接口。
- F-DBG-6 SHOULD 暴露 DAP 适配器，便于接入 VS Code。

### 3.4 虚拟面包板（F-BB）
- F-BB-1 MUST 提供画布，可放置外设器件、面包线、电源/地标记（仅逻辑，无电气）。
- F-BB-2 MUST 支持从器件面板拖拽放置：LED、按键、SSD1306 OLED（MVP 集合）。
- F-BB-3 SHOULD 扩展：ST7789 TFT、蜂鸣器、扬声器（I2S）、麦克风（I2S/ADC）、旋钮、舵机。
- F-BB-4 MUST 连线以"网表"持久化，与 UI 布局分离（布局仅视觉，网表是逻辑）。
- F-BB-5 MUST 支持撤销/重做（至少 20 步）。
- F-BB-6 MUST 支持保存/加载工程（`.breadesp` 目录）。

### 3.5 外设交互（F-PER）
- F-PER-1 LED：根据所连 GPIO 电平实时亮灭，支持 PWM 调亮度（占空比→亮度）。
- F-PER-2 按键：UI 点击切换电平，产生边沿事件注入 GPIO 输入。
- F-PER-3 OLED（SSD1306，I2C 0x3C）：拦截 I2C 命令，维护 128×64 显存，逐帧推送到 UI Canvas。
- F-PER-4 TFT（ST7789，SPI）：拦截 SPI 命令，维护帧缓冲，渲染。
- F-PER-5 蜂鸣器：监听 GPIO/PWM 频率，WebAudio 合成方波发声。
- F-PER-6 扬声器（I2S）：拦截 I2S DMA PCM 流，按采样率播放。
- F-PER-7 麦克风：用户上传/生成波形或本地麦克风采集，按采样率注入 I2S/ADC 输入缓冲。
- F-PER-8 示波器（加分）：抓取 GPIO/PWM/I2S 数据流，画时序图。

### 3.6 串口（F-SER）
- F-SER-1 MUST 显示 UART0 输出，支持 ANSI 颜色。
- F-SER-2 SHOULD 支持向 UART0 注入输入（回车发送）。

### 3.7 工程（F-PROJ）
- F-PROJ-1 MUST 工程结构：`firmware.elf`、`netlist.json`、`layout.json`、`meta.json`。
- F-PROJ-2 MUST 支持新建/打开/另存为。
- F-PROJ-3 MAY 支持与 PlatformIO/IDF 工程目录关联（自动发现 `build/*.elf`）。

### 3.8 可扩展性（F-EXT）
- F-EXT-1 MUST 提供外设 SDK，允许第三方以独立包形式注册外设模型。
- F-EXT-2 MUST 外设模型接口稳定（见 §6.2）。
- F-EXT-3 SHOULD 提供外设市场占位（本地目录扫描，MVP 不做在线市场）。

---

## 4. 系统架构（§4）

### 4.1 分层
```
┌──────────────────────────────────────────────────────────────┐
│ UI 层 (packages/ui, React + Konva)                            │
│  面包板画布 | 器件面板 | 调试面板 | 串口 | 屏幕视图 | 示波器 │
└──────────────────────┬───────────────────────────────────────┘
                       │ IPC (Electron contextBridge / WebSocket)
┌──────────────────────┴───────────────────────────────────────┐
│ Bridge 层 (packages/shell, Node.js / Electron 主进程)          │
│  QemuRunner | GdbBridge | PeripheralManager | NetlistResolver │
│  ProjectManager | IpcHandlers | DBusChannel (socket)         │
└──────────────────────┬───────────────────────────────────────┘
                       │ stdin/stdout + QMP + DBus socket
┌──────────────────────┴───────────────────────────────────────┐
│ Sim Core (packages/sim-core, QEMU-ESP32 + 自定义总线转发设备) │
│  CPU(Xtensa) | Flash/RAM | GPIO/I2C/SPI/UART/I2S/ADC/PWM 模型 │
│  + DBus Forward Device (把总线事务转发到 Bridge socket)       │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 数据流（关键路径）
1. UI 编辑网表 → 持久化 → 通过 IPC 下发给 Bridge。
2. Bridge 解析网表，按需配置 QEMU 启动参数与外设模型实例。
3. 仿真运行时：
   - 固件访问 GPIO/I2C/SPI/I2S → QEMU 内的 DBus Forward Device 把事务序列化发往 Bridge socket。
   - Bridge 的 PeripheralManager 把事务分发给对应外设模型。
   - 外设模型更新内部状态（显存/电平/PCM），把"渲染快照/事件"回推 UI。
4. UI 收到快照后渲染（Canvas/WebAudio）。

### 4.3 时序模型
- 采用**逻辑时钟**：QEMU 以虚拟时间推进，Bridge 不强制对齐墙钟。
- 音频类外设（I2S/蜂鸣器）使用真实采样率时钟（44100Hz 等）以避免音频抖动，其余外设使用事件驱动。
- 文档与 UI MUST 显式声明"非实时、非时序精确"。

---

## 5. 技术选型（硬约束，AI 不得擅自替换）

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Electron 28+ | IPC 直达、生态成熟、AI 熟悉 |
| 渲染框架 | React 18 + TypeScript | 生态、AI 训练充分 |
| 构建工具 | Vite 5 | 快、AI 熟悉 |
| 状态管理 | Zustand | 轻量、易测 |
| 画布 | Konva.js（react-konva） | 2D 图元与命中检测完备 |
| 音频 | WebAudio API | 内置、无依赖 |
| 仿真核心 | QEMU-ESP32（`espressif/qemu`） | 真实指令执行、JTAG/GDB 现成 |
| 调试器 | `xtensa-esp32-elf-gdb` + GDB/MI | 官方工具链 |
| 包管理 | pnpm workspace | monorepo 友好 |
| 测试 | Vitest | 与 Vite 一致 |
| 语言 | TypeScript（strict） | 全栈一致 |

> QEMU 二进制不随源码分发，AI 不得在仓库内放置二进制；通过 `scripts/fetch-qemu.mjs` 按需下载到 `packages/sim-core/bin/`（被 git 忽略）。

---

## 6. 核心接口契约（§6）

### 6.1 Peripheral 引脚定义
```ts
/** 引脚角色，决定事务如何被外设消费 */
export type PinRole =
  | 'gpio-in'      // 数字输入（外设→MCU），如按键
  | 'gpio-out'     // 数字输出（MCU→外设），如 LED
  | 'pwm-in'       // PWM 输入（MCU→外设），如蜂鸣器
  | 'i2c-sda'      // I2C 数据
  | 'i2c-scl'      // I2C 时钟
  | 'spi-mosi'
  | 'spi-miso'
  | 'spi-sck'
  | 'spi-cs'
  | 'i2s-ws'
  | 'i2s-bck'
  | 'i2s-data-in'   // MCU→外设（喇叭）
  | 'i2s-data-out'  // 外设→MCU（麦克风）
  | 'adc-in'        // 模拟输入（外设→MCU）
  | 'power'
  | 'gnd';

export interface PinDescriptor {
  id: string;            // 外设内唯一引脚 id，如 'SDA'
  role: PinRole;
  optional?: boolean;   // 是否可选连接
}
```

### 6.2 Peripheral Model 接口（外设 SDK 契约）
```ts
import type { BusTransaction, RenderSnapshot } from './types';

export interface PeripheralFactory {
  kind: string;                 // 唯一类型标识，如 'ssd1306'
  version: string;              // 语义化版本
  displayName: string;
  pins: PinDescriptor[];
  /** 实例省略 props 时的默认参数（如默认 I2C 地址）；NetlistResolver 路由时同以此回退 */
  defaults?: Record<string, unknown>;
  create(ctx: PeripheralContext): Peripheral;
}

export interface PeripheralContext {
  /** 向 UI 推送渲染快照（如显存帧） */
  emitSnapshot: (snapshot: RenderSnapshot) => void;
  /** 日志 */
  log: (level: 'info'|'warn'|'error', msg: string) => void;
  /** 逻辑时钟订阅 */
  onTick: (cb: (virtualMs: number) => void) => () => void;
}

export interface Peripheral {
  readonly kind: string;
  readonly instanceId: string;
  /** 收到一条总线事务 */
  onTransaction(tx: BusTransaction): void;
  /** GPIO 输入请求（外设主动驱动 MCU 输入，如按键） */
  driveInput?(pinId: string, level: 0|1): void;
  /** 资源释放 */
  dispose?(): void;
}
```

### 6.3 BusTransaction（Bridge↔外设模型）
```ts
export interface BusTransaction {
  kind: 'i2c' | 'spi' | 'gpio' | 'pwm' | 'i2s' | 'adc';
  /** 总线实例号（如 I2C_NUM_0） */
  bus: number;
  /** I2C: 7 位地址；SPI: cs 片选；GPIO: 引脚号 */
  target?: number;
  dir: 'read' | 'write';
  data: Uint8Array;        // write 有效
  length?: number;         // read 期望长度
  ts: number;              // 逻辑时间戳
}
```

### 6.4 RenderSnapshot（外设→UI）
```ts
export interface RenderSnapshot {
  instanceId: string;
  type: 'pixels' | 'level' | 'audio' | 'waveform' | 'text';
  payload:
    | { width: number; height: number; format: 'mono'|'rgb565'|'argb8888'; buffer: number[] | string }  // pixels
    | { level: number }            // 0..1 亮度（LED）
    | { samples: Float32Array; sampleRate: number }  // audio
    | { samples: number[] }       // waveform
    | { text: string };           // text
}
```

### 6.5 Netlist（持久化网表）
```ts
export interface Netlist {
  version: 1;
  chip: 'esp32' | 'esp32s3' | 'esp32c3';  // MVP: 'esp32'
  peripherals: PeripheralInstance[];
  wires: Wire[];
}

export interface PeripheralInstance {
  instanceId: string;     // 全局唯一
  kind: string;          // 对应 PeripheralFactory.kind
  props?: Record<string, unknown>;  // 外设特定参数（如 I2C 地址、分辨率）
}

export interface Wire {
  id: string;
  from: { instanceId: string; pin: string };   // 外设引脚
  to:   { instanceId: string; pin: string };   // 另一端（外设或 MCU GPIO）
  // MCU GPIO 用 instanceId='mcu' 表示，pin 为 'GPIO0'..'GPIO39'
}
```

### 6.6 IPC 通道（UI ↔ Bridge）
AI 生成 IPC 处理时 MUST 遵循命名前缀：
- `sim:*` 仿真控制（start/pause/step/reset/status）
- `fw:*` 固件加载（load/listSymbols）
- `dbg:*` 调试（setBreakpoint/continue/step/vars/regs）
- `proj:*` 工程（new/open/save/saveAs/close）
- `bb:*` 面包板（applyNetlist/getNetlist）
- `per:*` 外设运行时（snapshot 事件由 Bridge→UI 单向推）

所有 IPC 参数与返回 MUST 为 JSON 可序列化（Uint8Array 用 number[]）。

### 6.7 DBus 帧协议（QEMU 自定义设备 → Bridge）
`breadesp-dbus` 设备在 realize 时主动连接 Bridge 监听的 socket（TCP `host`/`port`，或 POSIX `socket` 路径），随后把拦截到的总线事务以长度前缀 JSON 帧推送：

```
frame   := <uint32 LE payload-length> <payload UTF-8>
payload := {"v":1,"tx":[<tx>,...]};    // v=协议版本，tx=本帧批量事务
tx      := {"kind":"i2c"|"gpio","bus":0,"target":<7bit addr|pin>,
           "dir":"write","ts":<QEMU 虚拟时钟 ns>,"data":[byte,...]}
```

- `ts` 为 QEMU 虚拟时钟纳秒；DBusChannel 反序列化时换算为逻辑毫秒（§6.3 契约）。
- 帧 MUST 以 bottom-half 批量冲刷（同一条指令触发的多笔事务进同一帧）。
- 接收端 MUST 容错：畸形帧/版本不匹配直接丢弃，流继续；超长（>64MB）前缀断开连接。
- 设备侧拦截策略：I2C 用通配从机（只 ACK 未被 QEMU 内建外设占用的地址）；GPIO 用 DPORT(0x3ff44000)/APB(0x60004000) 双基地址影子 MMIO，透传原始读写。

---

## 7. 目录结构（硬约束，§7）

```
my-idea/
├── PRD.md                      # 本文件，唯一真相源
├── README.md
├── package.json                # 根 workspace
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .gitignore
├── scripts/
│   ├── fetch-qemu.mjs          # 按需下载 QEMU-ESP32 二进制
│   ├── build-qemu-device.mjs   # 构建 breadesp-dbus 设备版 QEMU（Docker Linux / MSYS2）
│   ├── make-blink-elf.mjs      # 生成 blink.elf 金样固件
│   ├── make-i2c-elf.mjs        # 生成 i2c.elf 固件（GPIO+I2C 事务）
│   └── lib/
│       └── xtensa-elf.mjs      # 共享 Xtensa 汇编器 + ELF32 写入器
├── docs/
│   ├── architecture.md
│   └── peripheral-sdk.md
└── packages/
    ├── shell/                  # Electron 主进程 / Bridge
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── main.ts
    │       ├── preload.ts
    │       ├── qemu/QemuRunner.ts
    │       ├── qemu/QmpClient.ts
    │       ├── qemu/DBusChannel.ts
    │       ├── debugger/GdbBridge.ts
    │       ├── debugger/MiParser.ts
    │       ├── peripherals/PeripheralManager.ts
    │       ├── project/ProjectManager.ts
    │       ├── netlist/NetlistResolver.ts
    │       └── ipc/handlers.ts
    ├── ui/                     # React 渲染进程
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── vite.config.ts
    │   ├── index.html
    │   └── src/
    │       ├── main.tsx
    │       ├── App.tsx
    │       ├── store/simulationStore.ts
    │       ├── store/projectStore.ts
    │       ├── ipc/bridge.ts
    │       ├── components/
    │       │   ├── Breadboard/BreadboardCanvas.tsx
    │       │   ├── Breadboard/Wire.tsx
    │       │   ├── Palette/Palette.tsx
    │       │   ├── Inspector/Inspector.tsx
    │       │   ├── SerialConsole/SerialConsole.tsx
    │       │   ├── ScreenView/ScreenView.tsx
    │       │   ├── ScreenView/OledRenderer.ts
    │       │   └── Oscilloscope/Oscilloscope.tsx
    │       └── peripherals/
    │           ├── Led.tsx
    │           ├── Button.tsx
    │           ├── Oled.tsx
    │           ├── Buzzer.tsx
    │           └── Speaker.tsx
    ├── peripherals/            # 外设设备模型（共享，运行于 Bridge）
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── src/
    │   │   ├── types.ts        # §6.1-6.4 全部类型
    │   │   ├── registry.ts    # 外设注册中心
    │   │   ├── led.ts
    │   │   ├── button.ts
    │   │   ├── ssd1306.ts
    │   │   ├── st7789.ts
    │   │   ├── buzzer.ts
    │   │   ├── speaker.ts
    │   │   ├── mic.ts
    │   │   └── index.ts
    │   └── tests/
    │       └── ssd1306.test.ts
    ├── netlist/               # 网表 schema 与校验
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── types.ts       # §6.5
    │       ├── schema.ts      # zod schema
    │       ├── validate.ts
    │       └── index.ts
    └── sim-core/             # QEMU 二进制占位 + 启动参数构造
        ├── package.json
        ├── tsconfig.json
        ├── bin/               # gitignored，QEMU 二进制（含 qemu-breadesp/ 设备版）
        ├── build/             # gitignored，QEMU 设备构建工作区（源码 checkout）
        ├── device/
        │   └── breadesp_dbus.c  # breadesp-dbus QEMU 自定义设备（§4.2, §6.7）
        ├── fixtures/
        │   ├── blink.elf        # 金样固件（make-blink-elf.mjs 生成）
        │   └── i2c.elf          # GPIO+I2C 事务固件（make-i2c-elf.mjs 生成）
        ├── src/
        │   ├── args.ts        # 构造 QEMU 命令行（含 dbus 通道参数）
        │   ├── elf.ts         # ELF 解析（入口/符号）
        │   └── index.ts
        └── tests/
```

---

## 8. MVP 范围（§8，第一里程碑）

MVP MUST 完成且仅完成以下，AI 不应过度实现：
1. 加载 `blink.elf`，启动 QEMU-ESP32，UART0 打印可见。
2. GDB 断点/单步/寄存器/全局变量查看。
3. 面包板：LED + 按键 + SSD1306 OLED，可连线、可保存工程。
4. LED 随 GPIO 亮灭；OLED 渲染帧正确；按键注入 GPIO 输入。
5. 仿真控制：启动/暂停/复位/退出。

MVP 显式不做（标记 TODO，后续里程碑）：
- PWM 调光、I2S 喇叭/麦克风、TFT、示波器、蜂鸣器发声。
- 多芯片型号（仅 ESP32）。
- DAP 适配器（仅 GDB/MI）。
- 外设在线市场。

---

## 9. 非功能需求

- **平台**：Windows / macOS / Linux 桌面。
- **性能**：MVP 单芯片仿真，事件吞吐 < 50k 事务/秒可接受；OLED 帧率上限 30fps。
- **安全**：QEMU 子进程沙箱（不开放网络，`-net none`）；ELF 来自用户本地，加载前校验架构字段。
- **日志**：Bridge 写 `~/.breadesp/logs/bridge.log`，UI 控制台可见。
- **可测**：外设模型与网表校验 MUST 有单元测试；QEMU 集成测试用 `blink.elf` 作为黄金固件。

---

## 10. AI Agent 工作约定（§10，硬约束）

1. 任何代码改动 MUST 先确认对应 PRD 章节，并在文件头注释 `// PRD: §X.Y`。
2. 不得引入未列在 §5 选型表中的运行时依赖；新增依赖 MUST 更新 §5 并说明理由。
3. 接口（§6）改动 MUST 保持向后兼容；破坏性改动 MUST 升级 `version` 字段并在 PRD 顶部记录。
4. 生成文件 MUST 落在 §7 路径下；不得创建未声明的顶层目录。
5. TODO 标注格式统一：`// TODO(PRD §X.Y): <一句话>`，便于后续检索。
6. 不得放置任何二进制文件；QEMU 通过 `scripts/fetch-qemu.mjs` 拉取。
7. 所有对外文本（UI 文案、日志、错误）使用英文；中文仅限文档与注释。

---

## 11. 变更记录

| 日期 | 版本 | 摘要 | 作者 |
|---|---|---|---|
| v0.1 | 初始 PRD，定义 MVP 与目录骨架 | AI-assisted draft |
