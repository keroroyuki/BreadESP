# BreadESP 外设 SDK 开发指南

> 配合 PRD §6.2、§F-EXT。第三方外设以独立包形式注册。

## 1. 最小外设示例

```ts
// my-led/index.ts
import { PERIPHERAL_SDK_VERSION } from '@breadesp/peripherals';
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
  sdkVersion: PERIPHERAL_SDK_VERSION, // 声明构建时针对的 SDK 契约版本（§6）
  pins: [{ id: 'A', role: 'gpio-out' }, { id: 'K', role: 'gnd', optional: true }],
  create(ctx, props) { return new MyLed(String(props?.instanceId ?? crypto.randomUUID()), ctx); },
};
```

## 2. 注册

在你的包入口调用：

```ts
import { registerPeripheral } from '@breadesp/peripherals';
import { myLedFactory } from 'my-led';
registerPeripheral(myLedFactory);
```

**两个进程都要注册**（P5.1 起明确）：注册表是进程内的模块级单例——Bridge（Electron 主进程）
侧注册让 `PeripheralManager` 能实例化模型并路由事务；UI（渲染进程）侧注册让 palette 与画布
能看到该器件（palette 条目、引脚圆点、连线交互全部从 factory 元数据驱动）。`registerBuiltins()`
幂等，可在任意入口重复调用。

注册时的强制校验（PRD §6.2， coded errors）：

- `[BB-220]` 工厂形状非法：kind 必须是小写 kebab-case（`/^[a-z0-9]+(-[a-z0-9]+)*$/`），
  `version`/`sdkVersion` 必须是 semver，`displayName` 非空，`pins` 中 id 唯一且 role 属于
  §6.1 的 PinRole 集合，`defaults` 必须是 plain object，`create` 必须是函数。错误信息列出全部
  问题项。可用导出的 `validatePeripheralFactory(factory)` 在自己的测试里预检（返回问题数组，
  空数组 = 通过）。
- `[BB-221]` kind 冲突：后注册者报错，先注册者不被替换。
- `[BB-222]` SDK 版本不兼容：`sdkVersion` 的 major 高于宿主 `PERIPHERAL_SDK_VERSION`
  的 major 时拒绝（宿主无法保证未知的契约面），错误信息提示升级 BreadESP。

Bridge 侧网表引用了未注册的 kind 时，`bb:applyNetlist` 拒绝并报 `[BB-206]`（含 kind 与
instanceId），已有实例与路由保持原样（原子替换语义不变）。

> 包的分发与加载方式见 §8：放进本地外设目录（`~/.breadesp/peripherals/`）即可被
> "Peripheral catalog" 面板发现和加载；该场景下入口改为默认导出接收宿主 API 的函数（§8.2），
> 而不是自行 import 注册。

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
- **I2S**：按控制器号认领（P2.4 起）——QEMU 设备的 I2S 影子寄存器直接监听 TX DMA
  引擎：解码时钟配置（采样率/位宽/声道数），按 PCM 字节速率遍历 DMA 链表描述符，
  每个 10ms tick 发一条 `i2s` 事务——`bus` 为控制器号（0/1），`data` 为 8 字节头
  `[采样率 u32 LE][位宽 u8][声道数 u8][flags u8][保留 u8]` + 原始交错小端 PCM。
  实例用 `props.bus` 认领（缺省回退 `factory.defaults.bus`，如 speaker 默认 `0`），
  只有 factory 引脚表声明了 `i2s-data-in` 角色的实例才参与匹配（同 SPI 的角色过滤）。
  DIN/WS/BCK 连线仅用于 UI 绘制：PCM 在 GPIO 矩阵之前就被转发，事务层没有引脚身份。
- **ADC**：暂不路由（待 P3 对应外设模型落地）。

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

## 6. 版本与兼容（P5.1 稳定化）

- `kind` 全局唯一；冲突时后注册者报错 `[BB-221]`，先注册者不被替换。
- `version` 用语义化版本（注册时强制校验，非法 semver 拒绝 `[BB-220]`）；破坏性改动 MUST 升 major。
- 新增可选 `props` 向后兼容，无需升版本。
- 宿主 SDK 契约版本由 `@breadesp/peripherals` 导出为 `PERIPHERAL_SDK_VERSION`（当前 `1.0.0`）。
  第三方工厂 SHOULD 声明 `sdkVersion`（构建时针对的 SDK 版本）：major ≤ 宿主 major 即兼容；
  major 更高时注册拒绝 `[BB-222]`。不声明 `sdkVersion` 的包按兼容处理（P5.1 之前的行为）。
  宿主对 §6.1–6.4 只做追加式扩展（新 PinRole 成员、新快照类型、新可选方法）；必须破坏性变更时
  升 `PERIPHERAL_SDK_VERSION` 的 major，并在 PRD 顶部记录。

## 7. UI 自动呈现（P5.1）

第三方外设注册后**无需任何 UI 代码**即可获得：

- **Palette 条目**：palette 由注册表驱动（`displayName` + `version` 徽标），新 kind 自动出现、可拖放。
- **画布节点**：引脚圆点与 pin→pin 连线交互从 `factory.pins` 驱动（§3）；无专属渲染的 kind 显示
  通用节点体——中性指示灯 + 一行状态文本，由最新快照推导（`level`→亮度百分比、`tone`→频率、
  `text`→截断文本、`pixels`→几何标注、`audio`→采样率、`waveform`→通道数）。
- **ScreenView**：`pixels` 快照按 instanceId 自动开画布渲染（mono/rgb565）。

已知限制（后续里程碑）：`tone`/`audio` 快照的发声引擎目前按内建 kind（buzzer/speaker）匹配，
第三方音频外设不会自动发声；示波器面板同样只消费内建 oscilloscope 的波形。

## 8. 本地外设目录与离线市场（P5.2，PRD §F-EXT-3）

第三方包可以不经 npm 发布，直接放进本地目录被 BreadESP 发现和加载：

```
~/.breadesp/peripherals/           # 可用 BREADESP_PERIPHERALS_DIR 覆盖
└── acme-matrix/                   # 每个子目录 = 一个外设包
    ├── breadesp-peripheral.json   # 清单（必需）
    └── index.mjs                  # 入口模块
```

### 8.1 清单格式（`breadesp-peripheral.json`，`manifestVersion: 1`）

```json
{
  "manifestVersion": 1,
  "name": "acme-matrix",
  "version": "0.3.1",
  "displayName": "Acme LED Matrix",
  "description": "8x8 LED matrix driver",
  "entry": "index.mjs",
  "sdkVersion": "1.0.0",
  "provides": ["acme-matrix"]
}
```

- `name`：小写 kebab-case，可带 `@scope/` 前缀；`version`：包自身的 semver。
- `entry`：入口模块的**相对路径**，必须解析在包目录内（拒绝绝对路径与 `..` 逃逸）。
  无 `package.json` 的散包用 `.mjs`（ESM）或 `.cjs`（CJS，经默认导出互操作）扩展名，
  裸 `.js` 会被 Node 按 CommonJS 解释。
- `sdkVersion`：扫描期预检 major 门控——高于宿主 `PERIPHERAL_SDK_VERSION` 的包标记为
  `incompatible` 并禁止加载（代码层的 `[BB-222]` 门控在加载时仍然生效）。
- `provides`：宣称提供的 kind 列表，仅作市场展示；真实 kind 以加载时的注册差分为准。

### 8.2 入口模块契约（宿主 API 注入）

目录加载场景下，包**不应**自己 `import '@breadesp/peripherals'`（散包无法解析到宿主
的模块实例，注册会落到另一个注册表）。入口 SHOULD 默认导出一个接收宿主 API 的函数：

```js
// index.mjs
export default function register(host) {
  host.registerPeripheral({
    kind: 'acme-matrix',
    version: '0.3.1',
    displayName: 'Acme LED Matrix',
    sdkVersion: host.PERIPHERAL_SDK_VERSION,
    pins: [{ id: 'DIN', role: 'spi-mosi' }, { id: 'CS', role: 'spi-cs' }, { id: 'CLK', role: 'spi-sck' }],
    create: (ctx, props) => new AcmeMatrix(String(props?.instanceId), ctx),
  });
}
```

`host` 为 `PeripheralHostApi`：宿主自身的 `registerPeripheral` 与 `PERIPHERAL_SDK_VERSION`。
默认导出可以是 async（加载方会 await）。模型代码与 §1 完全相同——区别只在注册入口。
模块顶层副作用注册也会被注册表差分观察到，但仅在模块能解析到宿主同一
`@breadesp/peripherals` 实例时生效（例如 monorepo 内开发），散包请勿依赖。

### 8.3 加载语义与错误码

- 扫描只读：目录缺失 = 空市场；坏包降级为 `invalid` 条目并列出全部问题，不影响其他包。
- 加载由用户在 "Peripheral catalog" 面板显式点击触发；目标必须是当前扫描中 `status='ok'`
  的条目，否则 `[BB-224]`（加载前会重新扫描，该通道无法被用来导入任意路径）。
- 入口执行失败、默认导出不是函数、或跑完未注册任何 kind：`[BB-223]`，并回滚已产生的
  部分注册（不留残留）。注册自身的 `[BB-220]`/`[BB-221]`/`[BB-222]` 原样传播。
- 同一目录重复加载幂等（双击安全）。加载失败后修复文件可直接重试（入口 URL 带尝试
  序号绕开 ESM 模块缓存）；**已成功**的包不支持热更新——改动在应用重启后生效，卸载同理。
- 加载成功后无需任何 UI 代码：Bridge 返回 `PeripheralMeta` 元数据，渲染进程镜像为
  仅元数据存根，palette 与画布立即可见（§7）；模型的 `create()` 只在 Bridge 进程运行。

## 9. 测试约定

每个外设 MUST 至少有一个单元测试（见 `packages/peripherals/tests/ssd1306.test.ts`），
覆盖"收到一条典型事务 → 产生预期快照"的路径。工厂本身 SHOULD 用 `validatePeripheralFactory()`
预检（见 §2）。
