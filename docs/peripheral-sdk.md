# BreadESP 外设 SDK 开发指南

> 配合 PRD §6.2、§F-EXT。第三方外设以独立包形式注册。

## 1. 最小外设示例

```ts
// my-led/index.ts
import type { PeripheralFactory, Peripheral, PeripheralContext, BusTransaction, RenderSnapshot } from '@breadesp/peripherals';

class MyLed implements Peripheral {
  readonly kind = 'my-led';
  readonly instanceId: string;
  private ctx: PeripheralContext;
  private level = 0;
  constructor(id: string, ctx: PeripheralContext) { this.instanceId = id; this.ctx = ctx; }
  onTransaction(tx: BusTransaction) {
    if (tx.kind !== 'gpio' || tx.dir !== 'write') return;
    this.level = tx.data[0] ? 1 : 0;
    const snap: RenderSnapshot = { instanceId: this.instanceId, type: 'level', payload: { level: this.level } };
    this.ctx.emitSnapshot(snap);
  }
}

export const myLedFactory: PeripheralFactory = {
  kind: 'my-led', version: '1.0.0', displayName: 'My LED',
  pins: [{ id: 'A', role: 'gpio-out' }, { id: 'K', role: 'gnd', optional: true }],
  create(ctx, props) { return new MyLed(String(props?.instanceId ?? crypto.randomUUID()), ctx); },
};
```

## 2. 注册

在你的 Bridge 入口调用：

```ts
import { registerPeripheral } from '@breadesp/peripherals';
import { myLedFactory } from 'my-led';
registerPeripheral(myLedFactory);
```

## 3. 引脚角色与事务路由（PRD §6.1、§4.2）

外设通过 `pins[].role` 声明它需要的引脚类型。`NetlistResolver` 的 MVP 路由规则：

- **I2C**：按 7 位地址路由——实例 `props.address`，缺省回退 `factory.defaults.address`
  （如 ssd1306 默认 `0x3c`）。ESP32 GPIO 矩阵决定 MCU 引脚无法标识 I2C 控制器，故
  `bus` 字段暂不参与匹配。
- **SPI**：按 CS 线路由（P2.1 起）——QEMU 设备把 `tx.target` 帧化为控制器硬件 CS
  线索引（0–2），实例用 `props.cs` 认领（缺省回退 `factory.defaults.cs`，如 st7789
  默认 `0`）。只有 factory 引脚表声明了 `spi-cs` 角色的实例才参与 SPI 匹配（防止
  带 numeric prop 的非 SPI 外设误匹配）。同 I2C，`bus` 字段不参与匹配。
- **GPIO**：按 MCU 引脚路由——网表中一端为 `{ instanceId: 'mcu', pin: 'GPIO<n>' }` 的
  连线，把 `target = n` 的事务投递到另一端外设；同一引脚可挂多个外设（全部收到）。
  SPI 外设的控制线（DC/RST/BL）也走这里：把实例的 `DC` 引脚连到 `mcu.GPIO<n>` 并在
  `props.dc` 声明同一编号，模型据此把 GPIO 电平采样为命令/数据选择。
- **PWM**：与 GPIO 相同的按引脚路由（P2.3 起）。QEMU 设备的 LEDC/GPIO 矩阵
  影子寄存器把定时器/通道配置解码为每引脚的 `pwm` 事务——`target` 为 GPIO 编号，
  `data` 为 6 字节：`[频率 0.01Hz u32 LE][占空比 ‰ u16 LE]`（0Hz/0‰ = 静默），
  由蜂鸣器等模型消费；手工翻转 GPIO 的 bit-bang 固件则由模型侧沿测量兜底。
- **I2S/ADC**：暂不路由（待 P2.4/P3 对应外设模型落地）。

> TODO(PRD §6.1): 基于 `pins[].role` 的连线合法性校验（如 i2c-sda 不能接到 gpio-out）在
> 后续里程碑补齐。

> UI 侧复用：面包板画布（`packages/ui`）直接读取 `factory.pins` 渲染引脚圆点并驱动
> pin→pin 连线交互（渲染进程 import 本包的注册表），因此 `pins` 的 id/role/optional
> 同时决定画布连线交互与 Bridge 侧路由语义。

## 4. 渲染快照（PRD §6.4）

- `pixels`：帧缓冲（mono/rgb565/argb8888），UI 端按 format 解码到 Canvas。
- `level`：0..1 亮度，用于 LED 视觉。
- `tone`： `{freqHz, duty}` 音调描述（P2.3 新增，蜂鸣器），UI 用 WebAudio 合成方波，
  duty 兼作视觉亮度；`freqHz>0 且 duty>0` 表示发声。
- `audio`：PCM 采样 + 采样率，UI 用 WebAudio 播放。
- `waveform`：示波器用。
- `text`：文本面板。

**节流约定**：`ctx.emitSnapshot` 经 `PeripheralManager` 按 `(instanceId, type)`
做 30fps 上限节流（安静期首帧立即发射，窗口内 last-write-wins 合并，trailing 冲刷）。
外设模型只需在每次状态变化时正常 emit，无需自己做去抖；UI 最终总能收敛到最新状态。

## 5. 生命周期与 `dispose()`

`Peripheral.dispose?()` 是可选方法，在以下时机被调用：

- 网表重新应用（`applyNetlist`）——所有旧实例先被 dispose 再替换；
- `PeripheralManager.dispose()` 整体拆除。

实现 `dispose()` 用于释放定时器、解除事件订阅等资源；不实现则无副作用。
注意：`applyNetlist` 是原子操作，新网表中任一实例创建失败时旧的实例与路由保持原样。

## 6. 版本与兼容

- `kind` 全局唯一；冲突时后注册者报错。
- `version` 用语义化版本；破坏性改动 MUST 升 major。
- 新增可选 `props` 向后兼容，无需升版本。

## 7. 测试约定

每个外设 MUST 至少有一个单元测试（见 `packages/peripherals/tests/ssd1306.test.ts`），
覆盖"收到一条典型事务 → 产生预期快照"的路径。
