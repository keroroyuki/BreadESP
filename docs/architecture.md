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
- **I2C**：动态给每个 `esp32-i2c` 控制器挂一个通配从机（`breadesp-dbus.i2c-sniffer`），只 ACK 未被 QEMU 内建外设占用的地址，完整捕获 START/数据/STOP。读回复（P3.4）：sniffer 的 `recv` 回调从按 (bus, 地址) 键控的回复邮箱逐字节供应数据（邮箱由 `i2c-out` 反向帧原子替换，模拟传感器读出寄存器"最新值覆盖"语义）；邮箱空/耗尽回复 0xFF（SDA 空闲高），固件应重试至读到真实数据（回复往返无法在同一个同步 TRANS_START 内完成）。
- **SPI**（P2.1）：给每个通用 `esp32.spi` 控制器总线挂一个 SSI 嗅探从机（`breadesp-dbus.spi-sniffer`，`SSI_CS_NONE` 极性故能看见每个字节），控制器硬件 CS 输出线接到嗅探器的 GPIO 输入：CS 拉低开帧（线号成为 `tx.target`，即 CS 索引 0–2），CS 释放时整帧字节作为一条 `spi` 写事务发出。flash/PSRAM 所在的总线不挂嗅探器。SSI 从机类必须实现 `realize` 回调，否则 QEMU 在 realize 阶段解引用空指针直接 SIGSEGV。
- **GPIO**：对 DPORT(0x3ff44000) 与 APB(0x60004000) 双基地址的 GPIO 寄存器组做高优先级影子 MMIO，解码 OUT_W1TS/W1TC 写为引脚级事务并透传原始访问。输入注入（P3.4）：stock `esp32.gpio` 是只有 strap 寄存器的 stub、没有 qdev 输入线，故 `gpio-in` 反向帧驱动的输入电平在影子读路径合并进 GPIO_IN/IN1 寄存器读值（只覆盖 Bridge 驱动过的"已认领"引脚，其余位保留底层模型值）；GPIO 边沿中断未建模（stub 本就没有），固件以轮询读输入。
- **PWM**（P2.3）：对 LEDC 寄存器组（双基地址同法）做只观影子，定时器/通道配置解码为 (频率, 占空比)，GPIO 矩阵 `FUNCn_OUT_SEL` 写把 LEDC 输出信号映射到引脚，每个引脚音调变化发一条 `pwm` 事务（QEMU 自带 LEDC 模型从不驱动引脚，无影子则固件音调不可见）。
- **I2S**（P2.4）：stock 树把 esp32.i2s0/1 建模为 unimplemented-device，故对两个 legacy 寄存器组（0x3ff4f000/0x3ff6d000，各 0x1000，探测基地址存在即附着，兼作 esp32-only 守卫）做高优先级影子，观察 CONF/CLKM_CONF/SAMPLE_RATE_CONF/OUT_LINK。TX_START + OUT_LINK_START 后，虚拟时钟定时器（10ms tick）按解码出的 PCM 字节速率遍历 TX DMA 链表描述符（lldesc_t：dw0 的 length[23:12]、buf、next；`OUTLINK_ADDR` 是 20 位窗口字段，物理地址 = 0x3ff00000|field，而 buf/next 是完整 32 位指针——曾在此踩坑导致首版无声），经 `address_space_read` 读客户内存，描述符环（next 指回链内）自然循环——固件持续放音的标准手法；每 tick 汇成一条 `i2s` 事务（8 字节格式头 + 原始交错小端 PCM）。采样率公式：sck=160M/div、bck=sck/bck_div、ws=bck/(bits×channels)（APLL 为文档化缺口；非 DMA 的 FIFO_WR 直写路径未建模）。
- **I2S RX 注入**（P3.1）：socket 变双向——Bridge 以同样的长度前缀帧回写 `{"v":1,"in":[{"kind":"i2s-in",...}]}`（字段顺序为协议一部分，设备侧为有序扫描器）。影子同时观察 IN_LINK 与 CONF/SAMPLE_RATE_CONF 的 RX 半边；RX_START + IN_LINK_START 后，同一 10ms tick 按固件解码的 RX 字节速率消费每控制器的注入队列（256KB 上限，溢出丢最旧并一次性告警），把样本经 `address_space_write` 写入 DMA owner 的描述符缓冲，再回写 dw0（owner 清零、length 回填、eof 置位——与真实 DMA 引擎一致），轮询式固件由此读到麦克风采样。队列枯竭时保持描述符 armed 而不以静音抢占（曾在此踩坑：零填充清空 owner 会与"收到数据才 re-arm"的固件互相等待死锁）。
- 事务以 bottom-half 批量冲刷成长度前缀 JSON 帧（PRD §6.7），通过 TCP/unix socket 发往 Bridge。
- Bridge 的 `DBusChannel` 反序列化（虚拟 ns → 逻辑 ms）后交给 `PeripheralManager` 路由到对应外设实例。

> 该 device 源码（C）位于 `packages/sim-core/device/breadesp_dbus.c`，以零补丁方式（单 .c + meson 注册）集成进 pinned 的 espressif/qemu tag，由 `scripts/build-qemu-device.mjs` 用 Docker（Linux）或 MSYS2（Windows）独立构建，产物落到 gitignored 的 `packages/sim-core/bin/qemu-breadesp/`，`bin/qemu-breadesp.json` 记录元信息（§10.6 不入库）。

## 3. 外设路由流程

1. 固件执行 `i2c_master_write_to_device(addr=0x3c, ...)`。
2. QEMU I2C 控制器产生写事务 → DBus Forward Device 序列化 → Bridge socket。
3. `DBusChannel` 解析为 `BusTransaction{kind:'i2c',bus:0,target:0x3c,dir:'write',...}`。
4. `NetlistResolver` 根据网表路由：I2C 按 7 位地址（`props.address`，缺省回退
   `factory.defaults.address`）；SPI 按 CS 线（`tx.target` 是 CS 索引 0–2，实例经
   `props.cs` 认领，且 factory 引脚表须含 `spi-cs` 角色才参与匹配）；GPIO 按
   `mcu.GPIO<n>` 连线（同一引脚多外设全收）。
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

### 3.4 ST7789 命令解释器（P2.1）

`packages/peripherals/src/st7789.ts` 按 datasheet 语义解释 SPI 事务流，覆盖
TFT_eSPI / Adafruit_ST7789 常用绘制路径（init 序列 + 窗口推送 RGB565 像素）：

- **命令/数据分流**：DC 线是普通 GPIO，经网表连线（`props.dc`）路由到实例；
  QEMU 的 SPI 控制器把整个 CS 帧原子时钟输出，故帧时刻采样的 DC 电平适用于整帧——
  DC=0 全帧是命令操作码，DC=1 全帧是数据（命令参数或 RAMWR 像素流）。DC 未连线时
  告警一次并丢弃 SPI 帧（无法分流）。
- **多字节命令**：CASET/RASET/MADCTL/COLMOD 及 gamma/电源块用参数计数表原子消费，
  参数可跨事务；任何 DC=0 字节重置解析器，参数缺口由下一条命令清掉，流不会失步。
- **GRAM 寻址**：CASET/RASET 窗口与地址计数器持久；计数器从窗口起点出发 X 优先推进、
  窗口内回绕。MADCTL 是地址→玻璃坐标的逐像素变换：MV 先换轴，MX/MY 再镜像列/行
  （与 datasheet 存储器写扫描图及 setRotation 的旋转局部窗口一致）。
- **RAMWR 语义**：0x2C 重置地址计数器到窗口起点并接受后续 DC=1 字节为像素流；
  任何其它命令终止流（datasheet 原文语义）；像素高字节先发，半像素可跨事务。
- **渲染态**：DISPON/DISPOFF、SLPIN/SLPOUT（二者熄屏）、INVON/INVOFF（RGB565 按位取反）、
  MADCTL 的 RGB/BGR 序（快照期做通道交换）。快照为 240x240 RGB565 数组。
- **未建模项**（文档化缺口）：gamma 曲线、局部/滚动区域、idle 模式、RST 硬线
  （SWRESET 0x01 已覆盖软复位）、MISO 读通道（与 I2C 共享的 PRD §6.3 TODO）。

### 3.5 Speaker I2S PCM 管道（P2.4）

设备转发的 `i2s` 事务经 `NetlistResolver` 按控制器号认领路由（实例 `props.bus`，
缺省回退 factory 默认 0；factory 引脚表须含 `i2s-data-in` 角色——与 SPI CS 认领同构，
DIN/WS/BCK 连线仅用于 UI 绘制）。`packages/peripherals/src/speaker.ts` 把
`[采样率][位宽][声道]` 头 + 原始 PCM 解码为单声道 Float32（多声道取平均），逐事务发
`audio` 快照（`{samples, sampleRate}`，PRD §6.4 既有类型首次启用）。UI 侧
`audio/SpeakerAudio.ts` 的 `SpeakerPcmEngine` 为每个实例维护一条播放游标，把陆续到达的
chunk 排成首尾相接的 AudioBufferSourceNode（欠载超阈值则对时时钟重同步，避免积压播放
陈旧音频）；`audioFromSnapshot` 纯映射与引擎分离，Node 单测以 stub AudioContext 覆盖。

### 3.6 Oscilloscope 波形捕获（P2.5）

示波器是面包板器件而非全局探针：`oscilloscope` 模型暴露 CH1..CH4（`probe`
角色，§6.1 追加成员），经既有连线级 gpio/pwm 路由收事务——QEMU 设备侧无需
改动（GPIO 影子本就按虚拟时钟上报电平变化）。多通道归属依赖 §6.2 追加的可选
参数 `Peripheral.onTransaction(tx, viaPin?)`：PeripheralManager 把 NetlistResolver
解析出的落线引脚传给模型。模型为每通道维护边沿环形缓冲（虚拟 ms 时间戳），按
滚动窗口（`props.windowMs`，默认 200ms）剪枝——窗前保留一条边沿并重锚定到
t=0，使轨迹以正确电平进入窗口。LEDC 驱动的引脚没有真实翻转，`pwm` 事务的稳态
（频率, 占空比）在快照构建时合成窗口内边沿（等效真实示波器的触发视图）；真实
gpio 写会取代合成态。快照为 'waveform' 类型的新追加载荷变体 `WaveformPayload`
（`{startMs, windowMs, channels:[{label, edges:[{t, level}]}]}`）——全窗重述态，
30fps last-write-wins 合并安全，相同载荷在源侧去重。UI 侧
`components/Oscilloscope/traceBuilder.ts` 为纯几何（阶梯折线：首沿反推前级、
越界钳制、空通道平低轨、网格等分、通道分带、稳定配色），面板组件绘制暗色网格 +
标注时间基准的多通道数字轨迹。I2S 总线抓取为 P3 TODO。

### 3.7 Mic I2S RX 注入管道（P3.1）

`mic` 是输入类外设（PRD §F-PER-7）：模型按 props 配置的波形
（sine/square/noise/silence + freqHz/amplitude/sampleRate/bits/channels/bus，
全部经校验钳制回退）以墙钟 interval 生成 PCM 块（`generatePcmChunk` 纯函数，
相位跨块连续，噪声用确定性 xorshift32），经 §6.2 追加的可选
`PeripheralContext.emitInput(I2sInjection)` 上报；PeripheralManager 转为
`inject` 事件，持有者接线到 `DBusChannel.sendInject()`（反向帧
`{"v":1,"in":[{"kind":"i2s-in",...}]}`，sendInject 自动补 `kind` 字段），设备侧
按 §2 的 RX 注入机制喂给固件 DMA 环形缓冲。宿主/客户时钟漂移只表现为设备队列的
修剪/等待，不会破坏样本流。UI 侧 palette 与画布节点（采集开关见 §3.8；波形面板见 §3.9）。金标固件 `mic.elf`（`scripts/make-mic-elf.mjs` 确定性生成，
`--check` 防漂移）搭建 4×256B in-link 环、配置 I2S0 RX（33.3kHz/16bit/mono），
每轮无条件 re-arm 全部描述符（标准环形消费模式），累计 8 个非零缓冲后打印
`MIC OK`。

### 3.8 本地麦克风采集（P3.2）

P3.2 给 mic 接上宿主机真实麦克风，构成实时输入链：

```
渲染进程 getUserMedia → ScriptProcessor 采集（零增益 mute 防回授）
  → per:captureChunk IPC（48kHz mono Float32，边界校验 [BB-202]）
  → PeripheralManager.feedCapture → mic.acceptCapture（§6.2 追加可选成员）
  → drainResampled 线性重采样到 props.sampleRate → 既有 I2sInjection 反向通道
```

- **采集是纯运行时覆盖态，不落网表**：喂流存活期间（500ms 内有新块）tick 走采集
  路径，超时丢缓冲回退 synth 波形——重开工程不会自动请求麦克风权限。
- **饥饿语义**：采集缓冲空时不发注入（设备保持 DMA 描述符 armed），绝不以静音
  抢占；缓冲上限 1s 源音频，丢最旧保低延迟；源速率变更重置缓冲而非跨速率涂抹。
- **UI 侧**：`audio/MicCapture.ts`（stub 友好的最小 getUserMedia/WebAudio 面，
  不依赖 bridge 模块）+ `store/captureStore`（实例级生命周期、[BB-210] 错误面、
  netlist reconcile 停采已删除实例）+ 画布 mic 节点 REC/LIVE 开关。
- QEMU 设备零改动（复用 P3.1 反向通道）；波形生成器面板为 P3.3。

### 3.9 波形生成器面板（P3.3）

`components/WaveGen/WaveGen.tsx` 为面包板上每个 mic 实例渲染一张编辑器卡片：
波形（sine/square/noise/silence）、频率、幅度滑块、采样率、位深、声道数，
外加一块固定 5ms 墙钟窗口的波形预览画布（归一化周期预览看不到频率变化，
固定窗口可以）。编辑经 `projectStore.updatePeripheralProps` 浅合并进实例的
netlist `props`（纯逻辑编辑：layout 标识不变、未知 instanceId 无操作）——
netlist 标识变化触发 App 既有 `bb:applyNetlist` 效应，Bridge 原子重建 mic
实例即生效，**不引入新 IPC**。与采集（§3.8 纯运行时覆盖）不同，生成器配置随
netlist.json 持久化；采集进行中卡片提示 synth 正被覆盖。纯逻辑抽在
`wavegenDraft.ts`（draftFromProps/draftPatch/previewTrace/renderWavePreview），
归一化与取值范围全部委托 mic 模型导出的 `micConfigFromProps`/`MIC_LIMITS`
单一真相源——面板永远不可能产出模型会拒绝的配置。

### 3.10 旋钮与温湿度传感器输入链（P3.4）

P3.4 把反向通道从"仅 I2S PCM"泛化为三种注入（PRD §6.7），并落地两个输入外设：

```
旋钮 CW/CCW 按钮 → per:rotateKnob IPC（[BB-204] 边界校验）
  → PeripheralManager.driveRotate → knob.rotate(delta) 排队
  → 每 stepMs 播一个正交相位迁移 → ctx.drivePin('A'|'B', level)
  → 管理器经 NetlistResolver.resolveGpioInput（连线反向索引）解析出 MCU GPIO 号
  → gpio-in 反向帧 → 设备影子读路径合并进 GPIO_IN/IN1 → 轮询固件解码计数

SHT30 命令写 → i2c 前向事务 → sht30.onTransaction 解析命令字
  → 计算 6 字节读出（datasheet 反公式 + CRC-8）→ ctx.emitInput(i2c-out)
  → 设备按 (bus,地址) 邮箱原子替换 → sniffer_recv 逐字节供应固件主机读
```

- **knob 模型**（`peripherals/src/knob.ts`）：一 detent = 4 相位迁移的 Gray 环
  （CW 时 A 领先 B）；`rotate(delta)` 按净位移合并队列（正向 8 步排队中转 -4 步
  净剩 +4——旋钮 physically 不会造访被取消的位置），单次调用钳制 ±64 detents、
  队列上限 256 detents（防面板连击洪泛）；未接线引脚丢弃迁移并一次性告警
  （[BB-205]）。SW 推压开关复用既有 `per:driveInput` 通道（该通道自 P3.4 起
  真正接通注入——button 的 P1 TODO 随之闭合）。
- **sht30 模型**（`peripherals/src/sht30.ts`）：默认地址 0x44（props 可改 0x45 等），
  props `temperatureC`/`humidityRh` 钳制在 datasheet 量程；支持六种测量命令字
  （时钟拉伸与否 × 三档重复度）、状态寄存器读（0xF32D，含 heater 位跟踪）、
  软复位/加热器开关；周期测量模式未建模（一次性告警）。回复总在命令到达的
  那条总线上；构造与每次测量命令都发 text 快照供画布节点显示。
- **DBusChannel.sendInject 泛化**：按判别字段 `kind` 逐字段序列化三种帧——
  字段顺序是协议契约（设备为有序扫描器），绝不由模型对象 spread 生成
  （P3.1 丢 kind 事故的同类防线），单测以精确字符串冻结线格式。
- **applyNetlist 时序修正**：实例构造期就可能 drivePin（knob 的静止态同步），
  而旧实现先建实例后换路由——构造期驱动会丢进旧路由。现先在临时 resolver 上
  建路由、实例创建引用临时 resolver，全部成功才原子提交（原子性语义不变）。
- **UI**：palette 新增两项；画布 knob 节点 CCW/CW 按钮直连 `per:rotateKnob`；
  sht30 节点显示 text 快照（Bridge 未应答时回退到 props 推导读数），
  T±1°C / H±5%RH 四个小按钮经 `sensorDraft.adjustSht30`（归一化委托模型
  `sht30ConfigFromProps`/`SHT30_LIMITS` 单一真相源）走既有
  `updatePeripheralProps` → `bb:applyNetlist` 重建链生效，不引入新 IPC。
- **金标固件**：`knob.elf`（`make-knob-elf.mjs`）轮询 GPIO_IN 用 16 项迁移表
  解码正交计数（+8 打印 `KNOB CW`，归零打印 `KNOB ZERO`）；`sht.elf`
  （`make-sht-elf.mjs`）发测量命令后以最多 250 次重试读 6 字节并逐字节比对
  期望读出（重试是必要的：回复往返跨不过同步 TRANS_START）——匹配打印
  `SHT OK`，耗尽打印 `SHT FAIL`。汇编器新增 add/sub 编码（对照 pinned
  解码器表核对）。


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

### 4.2 DAP 适配器（P4.5，PRD §F-DBG-6）

`packages/shell/src/debugger/dap/` 提供标准 Debug Adapter Protocol 入口，VS Code 等
DAP 客户端因此可以替代内置面板调试同一 QEMU 实例（用法见 [dap.md](dap.md)）：

- **分层**：`DapServer`（会话/命令分发，stdio 或 TCP 传输，Content-Length 帧由
  `DapProtocol` 零依赖手写）→ `DapBackend`（接口）→ `QemuGdbBackend`（组合
  `QemuRunner` + `GdbBridge`）。launch 模式由后端拉起 `-S` 冻结 VM 再附 GDB；attach
  模式连到既有 stub（如 Electron 应用里正在跑的仿真）。执行控制在 GDB：continue 是
  `-exec-continue` 而非 QMP `cont`，launch 模式下 QemuRunner 保持 `loaded`，避免双重
  恢复把 VM 与 GDB 的停走状态撕裂。
- **GDB 面**：复用 P1.9/P4.4 的 GdbBridge 全部能力，P4.5 追加 `stackFrames()`
  （`-stack-list-frames`，MI 元素同样经 `frame={...}` 单键包装——mock 驱动的首版漏了解包，
  单测抓出）、`stepOut()`（`-exec-finish`）、`interrupt()`（`-exec-interrupt`）、
  `removeBreakpoints(ids)`（批量 `-break-delete`）与 `env` 透传。
- **esp-gdb 17.x dynconfig**（`XtensaDynconfig.ts`，真实 e2e 抓出的兼容性修复）：esp-gdb
  17.x 内建 Xtensa 寄存器布局与 espressif QEMU stub 不匹配（`-target-select` 报
  `Remote 'g' packet reply is too long`），GdbBridge 按 `chip` 自动设置
  `XTENSA_GNU_CONFIG=<gdb>/lib/xtensa_<chip>.so`（`dbg:connect` 与 DAP 共同受益；
  用户显式设置优先，RISC-V 芯片无需）。`QemuRunner.getChip()` 为此新增。
- **停止原因映射**：GDB reason → DAP reason（breakpoint/step/data breakpoint/
  entry/pause）；附着冻结 VM 的无 reason 首停映射为 `pause`。
- **断点集合语义**：按源文件整组替换（先 `-break-delete` 旧集合再插入），GDB 拒绝的
  位置降级 `verified=false` 行；函数断点与条件断点复用 P4.4 的 `-break-insert [-c]`。

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

## 11. 本地外设目录（离线市场，P5.2，PRD §F-EXT-3）

外设生态的离线入口：扫描本地目录发现第三方包，显式加载进 Bridge 注册表，UI 零代码呈现。

```
~/.breadesp/peripherals/<pkg>/breadesp-peripheral.json + 入口模块
        │  scan（只读，坏包降级为 invalid 条目）
        ▼
PluginCatalog (shell) ──per:catalogScan──▶ Marketplace 面板（状态徽标/问题清单）
        │  per:catalogLoad（目标必须是当前扫描的 'ok' 条目 → [BB-224] 门）
        ▼
动态 import 入口模块 → 默认导出函数接收宿主 API（PeripheralHostApi）→ registerPeripheral
        │  注册表差分得到新 kind 集；失败 [BB-223] 并回滚（unregisterPeripheral）
        ▼
响应携带 PeripheralMeta[] ──▶ 渲染进程 registerRemotePeripheral（仅元数据存根）
        │  registryTick 驱动 palette 重渲染；画布引脚/通用节点体自动可用
        ▼
PeripheralManager.applyNetlist 按 kind 在 Bridge 侧实例化真实模型（与内建同路径）
```

- **双进程注册表**：模型只运行在 Bridge；渲染进程镜像元数据存根（`create()` 误用报
  `[BB-207]`），palette/pin 锚点/通用节点体全部从元数据驱动，因此无需随包分发 UI 代码。
- **双实例规避**：散包无法解析宿主自己的 `@breadesp/peripherals` 实例，故入口契约是
  宿主注入 `registerPeripheral` 的默认导出函数（`PeripheralHostApi`），而非包自行 import。
- **幂等与重试**：同目录重复加载幂等（session 级 loaded 表 + inflight 去重）；失败修复后可
  直接重试——入口 URL 带进程级尝试序号绕开 ESM 模块缓存。热更新/卸载不在契约内（重启生效）。
- **安全边界**：扫描只读且永不失败为整体错误；加载门要求目标是当前扫描的 `ok` 条目，
  IPC 无法诱使 Bridge 导入任意路径；清单 entry 必须解析在包目录内（段级 `..` 检测 +
  跨平台绝对路径形态）。执行第三方代码本身是有意的扩展机制，由用户显式点击触发。

### 11.1 打包脚手架（P5.3，PRD §F-EXT-4）

`pnpm create-peripheral <name>` 是外设包的起步入口：`PeripheralScaffold`（shell 包，
纯函数核心 + fs 写入层）生成四文件可发布包——清单（`sdkVersion` 盖宿主当前
`PERIPHERAL_SDK_VERSION`）、宿主 API 注入入口（含可运行的 GPIO 电平示例模型）、README、
零依赖 `self-check.mjs`。设计要点：

- **自校验**：清单产出后回灌 `validatePeripheralManifest`（不变式断言），名称规则直接复用
  目录的 `PERIPHERAL_PACKAGE_NAME_RE`——生成器与消费方共用一处真相，不可能生成目录拒收的包。
- **提前失败**：kind 与已注册 kind 冲突在生成期以 [BB-230] 拒绝（否则加载时必撞
  [BB-221]）；目标目录非空以 [BB-231] 拒绝（脚手架永不覆盖既有文件），写入中途失败
  清理已创建的部分文件。
- **CLI 形态**：shell 包内 tsx 入口（同 DAP `debugger/dap/cli.ts` 模式），`parseScaffoldArgs`/
  `runScaffoldCli` 导出供测试注入 IO；渲染进程与 IPC 面零改动，无新运行时依赖。
