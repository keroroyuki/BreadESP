---
title: 02 · 首个工程：点亮的 LED
description: 新建工程、画布连线、导入固件、启动仿真，看 LED 随 GPIO2 亮灭。
---

# 02 · 首个工程：点亮的 LED

> 目标：从零建一个 `.breadesp` 工程，用金标固件 `blink.elf` 让画布上的 LED
> 随 GPIO2 翻转。约 10 分钟。

## 1. 新建工程

1. 在顶栏的目录输入框填一个**空目录**路径（如 `D:\demo\my-first.breadesp`）。
2. 点 **New**，在工程向导里选择：
   - **芯片**：`esp32`（也可选 `esp32s3` / `esp32c3` / `esp32c6`）；
   - **模板**：`blink-led`（自动生成一个 LED 实例并预连线到 `mcu.GPIO2`）。
3. 点 Create。向导落盘四个文件（PRD §F-PROJ-1）：

```
my-first.breadesp/
├── firmware.elf   # 固件（下一步导入）
├── netlist.json   # 逻辑半区：外设实例 + 连线
├── layout.json    # 视觉半区：画布坐标
└── meta.json      # {version, createdAt, updatedAt, chip, external?}
```

> 网表与布局严格分离（PRD §F-BB-4）：移动节点只改 `layout.json`，连线只改
> `netlist.json`，保存时两半各自校验。

## 2. 认识画布

- 左侧固定的 **MCU 节点**暴露所选芯片的可用 GPIO（ESP32 上 6-11/20/24/28-31
  为 flash 占用或不存在的引脚，不显示）。
- 从 Palette 拖一个器件到画布即创建实例；点器件引脚圆点再点 MCU 引脚圆点即连线
  （Esc 或点空白取消）；点选连线后再次点击或按 Delete 删除。
- 模板已经替你连好 `led-1.A → mcu.GPIO2`；也可以删掉重连练手。

## 3. 导入固件

把编译产物 ELF 拷入工程：顶栏目录框旁的操作把 ELF 导入为工程的 `firmware.elf`
（导入前经架构校验门 `[BB-101]`：esp32/s3 要求 Xtensa ELF，c3/c6 要求 RISC-V ELF）。

没有现成固件时，用仓库自带的金标固件：

```
packages/sim-core/fixtures/blink.elf
```

它由 `scripts/make-blink-elf.mjs` 确定性生成：UART0 打印 `Hello ESP32` 后以
固定节拍翻转 GPIO2（并带 DWARF4 调试符号，可直接用于 [调试教程](03-debugging.md)）。

> 用自己的工程也行——PlatformIO/ESP-IDF 工程可以整体关联，让 BreadESP 自动发现
> `build/*.elf`（PRD §F-PROJ-3，顶栏 External firmware 面板）。

## 4. 启动仿真

点顶栏 **Start**。几秒内你应该看到：

- 画布上的 **LED 节点随 GPIO2 亮灭**（模型收 `gpio` 事务 → 发 `level` 快照 → 画布点亮）；
- 底部 **SerialConsole** 打印 `Hello ESP32`；
- 顶栏状态变为 `sim: running`。

仿真控制条支持 **Pause/Resume/Reset** 与 **0.1x–10x** 倍率：慢放时虚拟时钟被节流，
LED 闪烁在屏幕上按倍率变慢（PRD §F-SIM-2）。

## 5. 串口双向

SerialConsole 下方的输入框可以向固件注入 UART 输入（回车发送，行以 `\n` 结尾）。
配套金标固件 `uart-echo.elf` 会把收到的每一行回显为 `ECHO: <line>`——导入它即可
验证输入链路（PRD §F-SER-2）。

## 6. 保存与重开

**Save** 落盘 `netlist.json` + `layout.json`；关闭应用后用 **Open** 重新打开目录，
画布的器件、连线、坐标与芯片型号原样恢复（往返一致性是仓库测试的验收项）。

## 下一步

- [03 · 调试工作流](03-debugging.md)：断点、单步、变量、条件断点与观察点。
- [04 · 内建外设参考](04-peripherals.md)：OLED、TFT、蜂鸣器、喇叭、麦克风等全部器件。
- 工程文件格式细节见 [架构详解 §9](../architecture.md)（工程持久化）。
