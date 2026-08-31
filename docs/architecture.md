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

## 4. 调试链路

- QEMU 启动带 `-gdb tcp::1234`，暴露 GDB stub。
- Bridge 的 `GdbBridge` 用 `xtensa-esp32-elf-gdb --interpreter=mi` 连接 1234。
- UI 通过 `dbg:*` IPC 调用 GdbBridge，GdbBridge 翻译为 GDB/MI 命令。
- `MiParser` 解析 MI 输出为结构化结果（断点列表、变量、寄存器）。

## 5. 仿真状态机

```
idle --load(fw)--> loaded --start--> running --pause--> paused --start--> running
                                            \--- step --> paused
running/loaded/paused --reset--> loaded
any --error--> error
```

## 6. 时序与音频

- 主体逻辑时钟：QEMU 虚拟时间，事件驱动，不与墙钟对齐。
- 音频类外设：单独用真实采样率时钟，避免抖动（PRD §4.3）。
- 明确声明：非实时、非时序精确（UI 启动时提示一次）。

## 7. 安全沙箱

- QEMU `-nic none` 禁用网络（PRD §9）。
- ELF 加载前校验 e_machine 字段为 Xtensa（防加载非目标固件崩溃）。
- Bridge 子进程以受限权限运行；不自动执行任何外部命令。
