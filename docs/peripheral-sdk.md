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

## 3. 引脚角色（PRD §6.1）

外设通过 `pins[].role` 声明它需要的引脚类型。`NetlistResolver` 据此校验连线合法性
（如 i2c-sda 不能接到 gpio-out 上）。

## 4. 渲染快照（PRD §6.4）

- `pixels`：帧缓冲（mono/rgb565/argb8888），UI 端按 format 解码到 Canvas。
- `level`：0..1 亮度，用于 LED/蜂鸣器视觉。
- `audio`：PCM 采样 + 采样率，UI 用 WebAudio 播放。
- `waveform`：示波器用。
- `text`：文本面板。

## 5. 版本与兼容

- `kind` 全局唯一；冲突时后注册者报错。
- `version` 用语义化版本；破坏性改动 MUST 升 major。
- 新增可选 `props` 向后兼容，无需升版本。

## 6. 测试约定

每个外设 MUST 至少有一个单元测试（见 `packages/peripherals/tests/ssd1306.test.ts`），
覆盖"收到一条典型事务 → 产生预期快照"的路径。
