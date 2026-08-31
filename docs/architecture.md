# BreadESP 架构详解

> 配合 [`PRD.md`](../PRD.md) §4 阅读。本文展开实现细节，但不修改 PRD 契约。

## 1. 进程模型

```
┌──────────────┐  contextBridge  ┌──────────────────────┐  stdin/stdout  ┌────────────────┐
│  UI 进程       │ ────────────── │  Bridge (Node)        │ ────────────── │  QEMU-ESP32    │
│ (Electron      │  ipcRenderer   │  (Electron 主进程)     │  + QMP + DBus   │  (子进程)        │
│   renderer)    │                │  - QemuRunner         │  socket         │  - CPU          │
│  React+Konva   │                │  - GdbBridge          │                 │  - Flash/RAM    │
│                │                │  - PeripheralManager  │                 │  - 外设模型      │
│                │                │  - ProjectManager     │                 │  - DBus Forward │
│                │                │  - NetlistResolver    │                 │    Device        │
└──────────────┘                 └──────────────────────┘                 └────────────────┘
```

## 2. DBus Forward Device（关键自定义件）

QEMU-ESP32 默认外设模型不全。我们在 QEMU 源码中新增一个 device `breadesp-dbus`（P1.2 已落地）：
- **I2C**：动态给每个 `esp32-i2c` 控制器挂一个通配从机（`breadesp-dbus.i2c-sniffer`），只 ACK 未被 QEMU 内建外设占用的地址，完整捕获 START/数据/STOP。
- **GPIO**：对 DPORT(0x3ff44000) 与 APB(0x60004000) 双基地址的 GPIO 寄存器组做高优先级影子 MMIO，解码 OUT_W1TS/W1TC 写为引脚级事务并透传原始访问。
- 事务以 bottom-half 批量冲刷成长度前缀 JSON 帧（PRD §6.7），通过 TCP/unix socket 发往 Bridge。
- Bridge 的 `DBusChannel` 反序列化（虚拟 ns → 逻辑 ms）后交给 `PeripheralManager` 路由到对应外设实例。

> 该 device 源码（C）位于 `packages/sim-core/device/breadesp_dbus.c`，以零补丁方式（单 .c + meson 注册）集成进 pinned 的 espressif/qemu tag，由 `scripts/build-qemu-device.mjs` 用 Docker（Linux）或 MSYS2（Windows）独立构建，产物落到 gitignored 的 `packages/sim-core/bin/qemu-breadesp/`，`bin/qemu-breadesp.json` 记录元信息（§10.6 不入库）。

## 3. 外设路由流程

1. 固件执行 `i2c_master_write_to_device(addr=0x3c, ...)`。
2. QEMU I2C 控制器产生写事务 → DBus Forward Device 序列化 → Bridge socket。
3. `DBusChannel` 解析为 `BusTransaction{kind:'i2c',bus:0,target:0x3c,dir:'write',...}`。
4. `NetlistResolver` 根据网表路由：I2C 按 7 位地址（`props.address`，缺省回退
   `factory.defaults.address`）；GPIO 按 `mcu.GPIO<n>` 连线（同一引脚多外设全收）。
   `PeripheralManager.route()` 只投递到解析出的实例，不再广播。
5. `PeripheralManager` 调用 `oled1.onTransaction(tx)`。单个外设模型抛错只记录
   `[BB-201]` 日志（含 instanceId/事务上下文），不阻断同事务投递给其他实例。
6. SSD1306 模型更新显存 → `ctx.emitSnapshot(pixels)` → 30fps 节流门（见 §3.1）
   → `snapshot` 事件 → 推送 UI Canvas 渲染。

### 3.1 快照节流（PRD §9 性能预算）

高频总线事务（如 I2C 每毫秒刷屏）不能逐条直达 UI。`PeripheralManager` 对每个
`(instanceId, snapshot type)` 维护一个节流槽，保证发射间隔 ≥ 1000/30 ms：

- **前沿立即发射**：安静期后的第一帧快照立即发出，保证低延迟。
- **窗口内合并**：距上次发射不足一个间隔的快照进入 pending（last-write-wins，
  只保留最新状态），由定时器在窗口结束点冲刷。
- **重置语义**：重新 `applyNetlist` 会重建所有实例并清空节流槽（含取消未触发的
  trailing 冲刷），已销毁实例的陈旧 pending 永远不会到达 UI。
- UI 端只需按 `instanceId` 应用最新快照即可收敛到正确状态。

### 3.2 路由健壮性

- **原子换网表**：`applyNetlist` 先在临时 map 中构建全部实例（重复 instanceId 报
  `[BB-200]`、未知 kind 直接抛错），任何实例创建失败都会 dispose 掉半成品并保留
  旧实例与旧路由，网表不会被部分应用。
- **换表即换实例**：新网表提交前先 dispose 全部旧实例，防止旧模型持有失效状态。
- **错误隔离**：`route()` 对每个目标的 `onTransaction` 单独 try/catch（见 §3 第 5 步）。
- **可注入时钟**：节流窗口的时间源可从构造函数注入（默认 `Date.now`），测试用合成时钟
  确定性验证 30fps 上限。

### 3.3 SSD1306 命令解释器（P1.6）

`packages/peripherals/src/ssd1306.ts` 按 datasheet 语义解释 I2C 事务流，覆盖
Adafruit_GFX 常用绘制路径（begin() 初始化 + display() 全帧推送）：

- **I2C 成帧**：每个写事务首字节是控制字节（bit7 Co / bit6 D/C#，即 0x00/0x40/0x80/0xC0），
  其后整段为命令流或数据流；不做流内扫描，数据字节 0x00/0x40 是载荷而非成帧。
  QEMU 可能把一次逻辑写拆成多个事务，首字节非规范控制字节的分片按上一数据流续写。
- **多字节命令**：带参数的命令（0x21/0x22 窗口、0x81 对比度、0xDA COM 引脚、
  滚动命令等）用参数计数表原子消费，参数不会被误解析为操作码；参数可跨事务。
- **寻址模式**：页模式（上电默认，低/高列半字节 + 0xB0-0xB7 页指针，列在 128 处回绕）、
  水平模式（Adafruit display() 默认，0x21/0x22 窗口内列优先推进）、垂直模式（页优先）。
  列/页指针跨事务持久，任意分块的数据流都能正确落显存。
- **渲染期朝向**：显存按 datasheet 页/列布局存储，快照时才应用段重映射（0xA0/0xA1）、
  COM 扫描方向（0xC0/0xC8）、起始行（0x40-0x7F）、反色（0xA7）、全亮（0xA5）与
  上电态（显示关 = 熄灭）。模块走线约定 (0xA1+0xC8)（Adafruit 默认）为恒等变换，
  GFX 坐标直落玻璃坐标。未建模项：硬件自动滚动（0x26-0x2F）、亮度渐变（0xA2/0xA3）。

## 4. 调试链路

- QEMU 启动带 `-gdb tcp::1234`，暴露 GDB stub。
- Bridge 的 `GdbBridge` 用 `xtensa-esp32-elf-gdb --interpreter=mi` 连接 1234。
- UI 通过 `dbg:*` IPC 调用 GdbBridge，GdbBridge 翻译为 GDB/MI 命令。
- `MiParser` 解析 MI 输出为结构化结果（断点列表、变量、寄存器）。

### 4.1 调试面板（P1.9）

- **连接模型**：`QemuRunner.load()` 总是分配 GDB stub 端口（`-S` 冻结启动），调试面板通过 `dbg:connect` 惰性附着——端口与固件路径由 main 进程记忆（`getGdbPort`/`getFirmwareElf`），渲染进程无需自行预留端口。`sim:step` 在 GDB 附着后路由到 `-exec-step-instruction`（PRD §F-SIM-1 指令级单步本就是 stub 能力）。
- **IPC 面**：`dbg:connect/disconnect/status` 管理连接；`dbg:setBreakpoint/removeBreakpoint/clearBreakpoints/listBreakpoints` 维护断点（`-break-insert/-break-delete/-break-list`，注意 `-break-list` 的 `body` 嵌套在 `BreakpointTable` 内部——曾因 mock 与真实 GDB 形状不一致而误解析，e2e 抓出后已对齐 wire 格式）；`dbg:continue/step/stepOver` 控制执行；`dbg:vars/regs/evaluate` 读取被检视状态（`-stack-list-variables --simple-values`、`-data-list-register-names` + `-data-list-register-values x` 按索引配对、`-data-evaluate-expression`）。异步停止通过 `dbg:stopped/running/exit` 推送，UI 无需轮询。
- **UI 状态机**（`debuggerStore`）：`detached → attached ⇄ running`。`onStop` 记录停止帧并自动刷新变量/寄存器/观察值；detach 后迟到的 in-flight 回复被丢弃（避免脏写回）。
- **测试固件**：`blink.elf` 自带手工构建的 DWARF4（`.debug_info`/`.debug_abbrev`）——`app_main` 的局部变量位于寄存器（DW_OP_regx），全局 `led_state` 位于 PT_LOAD 内存（DW_OP_addr），使 vars/regs/evaluate 在 e2e 中有真实数据。

## 5. 仿真状态机

```
idle --load(fw)--> loaded --start--> running --pause--> paused --start--> running
                                            \--- step (GDB attached) --> paused
running/loaded/paused --reset--> loaded
any --error--> error
```

`step` 自 P1.9 起经 GDB stub（`sim:step` 在 `dbg:connect` 附着后路由到 `-exec-step-instruction`，未附着时报 `[BB-105]` 引导先连接调试器）。

## 6. 时序与音频

- 主体逻辑时钟：QEMU 虚拟时间，事件驱动，不与墙钟对齐。
- 音频类外设：单独用真实采样率时钟，避免抖动（PRD §4.3）。
- 明确声明：非实时、非时序精确（UI 启动时提示一次）。

## 7. 安全沙箱

- QEMU `-nic none` 禁用网络（PRD §9）。
- ELF 加载前校验 e_machine 字段为 Xtensa（防加载非目标固件崩溃）。
- Bridge 子进程以受限权限运行；不自动执行任何外部命令。

## 8. 面包板编辑（UI 侧，P1.7）

画布（`packages/ui` Konva Stage）上的编辑操作遵循"逻辑/视觉分离"（PRD §F-BB-4）：

| 操作 | 改动的数据 | 是否下发 Bridge |
|---|---|---|
| 拖放放置外设 | `netlist.peripherals` + `layout.items` | 是（重建实例） |
| 拖动移动节点 | 仅 `layout.items` | 否 |
| pin → pin 连线 | 仅 `netlist.wires` | 是（重建路由） |
| 删除节点 / 连线 | netlist（连带清理悬空连线） | 是 |

- **两个持久化半区**：`netlist.json`（逻辑）与 `layout.json`（`{version:1, items:[{instanceId,x,y,kind}]}`，
  与 `ProjectManager.newProject` 写出的形状一致）互不包含对方字段；store 提供独立序列化函数
  （`toNetlistFile` / `toLayoutFile`），网表经任意编辑序列后始终通过 `validateNetlist`。
- **变更下发**：`App` 以对象标识订阅 netlist，经 `bb:applyNetlist` 让 `PeripheralManager`
  原子重建实例与路由（PRD §4.2 步骤 1–2）；移动节点不改变 netlist 标识，因此拖动不触发重建。
- **pin 锚点单一来源**：`components/Breadboard/pinLayout.ts` 纯函数把 Wire 端点换算为画布坐标，
  引脚圆点与连线贝塞尔共享同一公式，永不漂移；pin 元数据直接复用 `@breadesp/peripherals`
  的 `factory.pins`（渲染进程 import 纯 TS 注册表）。
- **连线约束（MVP）**：UI 仅允许 外设 pin ↔ MCU GPIO 连线（外设↔外设不可路由，见 §3）；
  自环与重复连线（含端点对调）在 store 层拒绝；删除实例时其连线一并移除，避免悬空端点。
- **id 确定性**：实例与连线 id 用 `prefix-<最小可用序号>` 生成，加载已有工程后不冲突。
- MCU 节点固定在画布左侧，暴露 ESP32 可用 GPIO（6-11/20/24/28-31 为 flash/不存在，不显示）；
  画布内 LED 由 `level` 快照实时点亮，按键按压经 `per:driveInput` 注入。

## 9. 工程持久化（P1.8）

一个工程是一个目录（PRD §F-PROJ-1），Bridge 侧 `ProjectManager` 是它唯一的磁盘读写者：

```
<dir>.breadesp/
├── firmware.elf   # importFirmware 拷入（经 BB-101 架构闸门）；open 返回其路径或 null
├── netlist.json   # 逻辑半区（实例 + 连线），save 前必过 validateNetlist
├── layout.json    # 视觉半区 {version:1, items:[{instanceId,x,y,kind}]}，save 前必过 validateLayout
└── meta.json      # {version:1, createdAt, updatedAt}，save 只递增 updatedAt
```

- **生命周期**：`newProject`（写骨架，拒绝覆盖已有工程）/ `openProject`（读 + 校验全部四件，
  返回 `ProjectData`）/ `saveProject(netlist, layout)`（双半区校验后原子性落盘）/ `saveAs`
  （新目录骨架 + 全量保存）/ `close`。`importFirmware(elf)` 按 netlist.chip 校验后拷贝固件进工程。
- **layout 契约下沉**：`LayoutFile`/`LayoutItem` 类型与 `validateLayout` 定义在 `@breadesp/netlist`
  （shell 写盘与 ui 序列化共享同一来源，类型不散落）；layout 校验为结构 + 坐标有限性 + instanceId 唯一。
- **失败语义**：目录不存在/缺 `meta.json` → `[BB-120]`；meta 损坏 → `[BB-121]`；netlist 读/校验失败 →
  `[BB-122]`；layout 读/校验失败 → `[BB-123]`；无工程打开/目录已存在工程 → `[BB-124]`。
  打开失败不改变当前已打开的工程；保存校验失败时磁盘零写入。
- **UI 侧**：`ProjectToolbar`（new/open/save/saveAs/close，目录为 MVP 文本输入，
  原生目录选择器 TODO(PRD §F-PROJ-2)）→ `proj:*` IPC → store `loadProject`（水合两半区，netlist
  对象标识变化自动触发 `bb:applyNetlist` 重建 Bridge 实例）/ `resetProject`。加载后 id 生成器从已占用
  序号续排，不会与工程内 id 冲突。
- **往返保证（验收）**：save → close → reopen 后 `ProjectData.netlist/layout` 与保存值结构相等；
  已由 ProjectManager 单测、真实临时目录往返、preload→handlers→ProjectManager 的 IPC 集成测试
  （含双向 JSON 序列化边界）覆盖。

## 10. 串口控制台（P1.10）

UART0 是固件的标准控制台（PRD §F-SER-1/§F-SER-2），双向链路如下：

```
输出  QEMU UART0 TX → stdout 管道 → QemuRunner 'uart' 事件 → sim:uart 推送 → SerialConsole 滚动区
输入  SerialConsole 输入框 → sim:sendUart IPC → QemuRunner.writeStdin → stdin 管道 → QEMU UART0 RX FIFO
```

- **输出侧**：`QemuRunner` 聚合 stdout chunk 为 uart 日志（`getUartLog()`），经 preload 的
  `sim:uart` 推送渲染进程，`SerialConsole` 追加进 store 的 `uart` 缓冲。
- **输入侧**：`writeStdin(data)` 把字节写进 QEMU 子进程 stdin；未 load 时抛 `[BB-102]`。
  UI 仅在 `loaded/running/paused` 状态放行输入框（此时子进程存在）。
- **行终结符约定**：注入统一以 `\n` 结尾、不带 `\r`——QEMU 的 Windows stdio 后端
  （`char-win-stdio.c` 的 `win_stdio_thread`）逐字节转发但**丢弃 `\r`**，CRLF 会让按 `\r` 判行的
  固件饿死。Linux 无此问题，但统一 LF 保持两侧行为一致。
- **金标固件**：`packages/sim-core/fixtures/uart-echo.elf` 由 `scripts/make-uart-echo-elf.mjs`
  确定性汇编生成（`xtensa-elf.mjs` 的 l32r/movi/l8ui/s8i/addi/bnez/j + 新增 l32i 编码）：打印
  banner 后轮询 `UART_STATUS.RXFIFO_CNT`（0x3ff4001c 低 8 位）出队组行，遇 `\n` 回显
  `ECHO: <line>\r\n` 并复位 127 字节行缓冲。`--check` 模式校验入库 fixture 无漂移。
- **验收**（键入回车被固件读到）：真实 QEMU e2e 注入两行，均在 UART 输出中回显——证明
  stdin → RX FIFO → 固件读取 → TX 的完整闭环；第二行回显同时证明行缓冲复位。
