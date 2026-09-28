---
title: 04 · 内建外设参考
description: 全部内建外设的引脚、props、路由方式与快照形态一览。
---

# 04 · 内建外设参考

> 内建外设由 `@breadesp/peripherals` 注册（`registerBuiltins()`），Palette 条目、
> 画布引脚与 Bridge 路由全部由工厂的 `pins`/`defaults` 元数据驱动。创作自己的外设见
> [05 · 外设创作](05-authoring-peripherals.md) 与 [外设 SDK 指南](../peripheral-sdk.md)。

## 路由速查

| 总线 | 路由依据 | 说明 |
|---|---|---|
| GPIO / PWM | 连线：外设引脚 ↔ `mcu.GPIO<n>` | 同一引脚可挂多个外设（全部收到事务） |
| I2C | 7 位地址：`props.address`，缺省回退 `factory.defaults.address` | `bus` 字段不参与匹配 |
| SPI | CS 线索引 0–2：`props.cs` 认领 | 工厂引脚表须含 `spi-cs` 角色才参与匹配 |
| I2S | 控制器号：`props.bus`（0/1）认领 | 工厂须含 `i2s-data-in`/`i2s-data-out` 角色 |

## 输出类

### LED（`led`）

- 引脚：`A`（gpio-out 阳极）、`K`（gnd，可选）。
- 行为：收到 GPIO 写事务即更新亮度并发 `level` 快照（0..1），画布节点实时点亮。
- 演示固件：`blink.elf`（GPIO2 翻转）。

### SSD1306 OLED（`ssd1306`）

- 引脚：`SDA`/`SCL`（+`VCC`/`GND` 可选）；props `address`（默认 `0x3C`）。
- 行为：按 datasheet 解释 I2C 命令流（页/水平/垂直寻址、窗口、反色、朝向），
  维护 128×64 mono 显存，`pixels` 快照由 ScreenView 渲染。覆盖 Adafruit_GFX
  `begin()`+`display()` 常用路径。
- 演示固件：`i2c.elf`。

### ST7789 TFT（`st7789`）

- 引脚：`SCK`/`MOSI`/`CS`（SPI），`DC`（gpio-in，命令/数据选择，必须连线并在
  `props.dc` 声明同一 GPIO 号），`MISO`/`RST`/`BL` 可选；props `cs`（默认 `0`）。
- 行为：解释 SPI 命令流（CASET/RASET 窗口、MADCTL 旋转、RGB/BGR、反色、休眠），
  维护 240×240 RGB565 帧缓冲，`pixels` 快照进 ScreenView。
- 演示固件：`spi.elf`。

### 蜂鸣器（`buzzer`）

- 引脚：`+`（pwm-in）、`-`（gnd 可选）。
- 行为：消费 PWM 事务（频率/占空比，LEDC 影子解码）或 bit-bang 沿测频，发
  `tone` 快照；UI 用 WebAudio 合成方波，`freqHz>0 且 duty>0` 即发声。
- 演示固件：`buzzer.elf`（440Hz → 880Hz）。

### 喇叭（`speaker`）

- 引脚：`DIN`（i2s-data-in）、`WS`、`BCK`；props `bus`（默认 `0`）。
- 行为：解码 I2S TX DMA 转发的 PCM（8/16/24/32 位、单/多声道混单声道），发
  `audio` 快照（流式、不参与 30fps 合并）；UI 按采样率无缝播放。
- 演示固件：`speaker.elf`（正弦波）。

## 输入类

### 按键（`button`）

- 引脚：`1`（gpio-in）、`2`（gnd 可选）。
- 行为：画布上按住/松开经 `per:driveInput` 注入 GPIO 电平（`gpio-in` 反向帧合并进
  GPIO_IN 影子读值）；GPIO 边沿中断未建模，固件以轮询读取。

### 麦克风（`mic`）

- 引脚：`DOUT`（i2s-data-out）、`WS`、`BCK`；props：`waveform`
  （`sine`/`square`/`noise`/`silence`）、`freqHz`、`amplitude`、`sampleRate`、
  `bits`、`channels`、`bus`（默认 `0`）、`chunkMs`。
- 行为：按 props 合成 PCM 注入固件的 I2S RX DMA 环形缓冲；底部 **WaveGen 面板**
  可视化编辑波形（编辑即改 netlist props，随工程持久化）；画布节点 **REC 开关**
  切换宿主机真实麦克风采集（运行时覆盖 synth，不落网表）。
- 演示固件：`mic.elf`。

### 旋钮（`knob`）

- 引脚：`A`/`B`（gpio-in，正交）、`SW`（推压开关，可选）、`GND`；props `stepMs`
  （每个 detent 的播放步长）。
- 行为：画布节点 CCW/CW 按钮经 `per:rotateKnob` 排队正交相位序列（1 detent = 4
  相位迁移的 Gray 环），逐针脚驱动注入；SW 复用按键注入通道。
- 演示固件：`knob.elf`（正交计数打印 `KNOB CW`）。

### 温湿度传感器（`sht30`）

- 引脚：`SDA`/`SCL`；props `address`（默认 `0x44`）、`temperatureC`、`humidityRh`。
- 行为：应答六种测量命令字（读回复经 `i2c-out` 邮箱供应，固件需重试收敛）、
  状态寄存器（heater 位）与软复位；`text` 快照显示当前读数，画布节点
  T±1°C / H±5%RH 按钮直接改 props。
- 演示固件：`sht.elf`（读到 25°C/50%RH 打印 `SHT OK`）。

## 观测类

### 示波器（`oscilloscope`）

- 引脚：`CH1`–`CH4`（probe 探针角色，PRD §6.1）、`GND`；props `windowMs`
  （滚动窗口，默认 200ms）、`maxEdges`。
- 行为：把 CHx 连线到任意 `mcu.GPIO<n>` 即抓取该引脚的电平/PWM 时序——真实 GPIO
  翻转按虚拟时钟记录边沿；LEDC 驱动的引脚按 (频率, 占空比) 稳态合成窗口内边沿
  （等效真实示波器的触发视图）。`waveform` 快照由底部示波器面板绘制多通道阶梯轨迹。

## 30fps 快照节流

所有 `emitSnapshot` 经 `(instanceId, type)` 节流门：安静期首帧立即发出，窗口内
last-write-wins 合并，trailing 冲刷——UI 永远收敛到最新状态且不被高频事务拖垮
（PRD §9）。例外：`audio` 快照是流而非可重述状态，绕过合并逐块送达。
