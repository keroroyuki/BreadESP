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

QEMU-ESP32 默认外设模型不全。我们在 QEMU 源码中新增一个 device `breadesp-dbus`：
- 挂载到 GPIO/I2C/SPI/I2C/ADC 总线的拦截 hook。
- 把每条总线事务序列化为 `BusTransaction`（PRD §6.3）通过 unix socket 发往 Bridge。
- Bridge 的 `DBusChannel` 接收后交给 `PeripheralManager` 路由到对应外设实例。

> 该 device 源码（C）属于 sim-core 的扩展，不随 TS 仓库分发，独立构建 QEMU。

## 3. 外设路由流程

1. 固件执行 `i2c_master_write_to_device(addr=0x3c, ...)`。
2. QEMU I2C 控制器产生写事务 → DBus Forward Device 序列化 → Bridge socket。
3. `DBusChannel` 解析为 `BusTransaction{kind:'i2c',bus:0,target:0x3c,dir:'write',...}`。
4. `NetlistResolver` 根据网表确认 0x3c 总线上的外设实例 `oled1`。
5. `PeripheralManager` 调用 `oled1.onTransaction(tx)`。
6. SSD1306 模型更新显存 → `ctx.emitSnapshot(pixels)` → 推送 UI Canvas 渲染。

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
