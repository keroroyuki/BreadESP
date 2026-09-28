---
title: 05 · 外设创作
description: 用脚手架生成外设包，实现模型接口，经本地目录加载进 BreadESP。
---

# 05 · 外设创作

> 目标：用脚手架生成一个可发布的外设包，理解模型接口，并把它加载进面包板。
> 完整契约参考 [外设 SDK 指南](../peripheral-sdk.md)（本文是其循序渐入口径）。

## 1. 脚手架生成

```bash
pnpm create-peripheral acme-lamp --description "Demo level indicator"
# 选项：--display-name <文本>  --description <文本>  --into <父目录>
```

`--into` 指向本地外设目录根（`~/.breadesp/peripherals/`，或环境变量
`BREADESP_PERIPHERALS_DIR`）可跳过手动拷贝。生成的目录恰好四个文件：

| 文件 | 作用 |
|---|---|
| `breadesp-peripheral.json` | 清单（`manifestVersion: 1`，`sdkVersion` 自动盖宿主当前契约版本） |
| `index.mjs` | 入口：默认导出接收宿主 API 的注册函数 + 可运行的 GPIO 电平示例模型 |
| `self-check.mjs` | 零依赖冒烟：`node self-check.mjs` 独立验证包形状与模型行为 |
| `README.md` | 安装/加载/开发指引 |

生成即合规：清单会回灌目录校验器，名称规则与目录扫描共用同一正则——
脚手架不可能生成市场拒收的包。

## 2. 模型接口十分钟版

模型实现 `Peripheral`（PRD §6.2）：

```js
class AcmeLamp {
  // kind / instanceId 是只读标识
  constructor(id, ctx) { this.instanceId = id; this.ctx = ctx; this.level = 0; }
  onTransaction(tx) {
    if (tx.kind !== 'gpio' || tx.dir !== 'write') return;
    this.level = tx.data[0] ? 1 : 0;
    this.ctx.emitSnapshot({ instanceId: this.instanceId, type: 'level', payload: { level: this.level } });
  }
  dispose() {} // 可选：释放定时器/订阅
}
```

要点：

- **工厂即元数据**：`kind`（小写 kebab）、`version`（semver）、`displayName`、
  `pins`（id + role，同时驱动画布引脚与 Bridge 路由）、`defaults`（props 回退值）、
  `sdkVersion`（SHOULD 声明，major 高于宿主则拒绝注册 `[BB-222]`）。
- **路由跟着 role 走**：GPIO/PWM 按连线，I2C 按 `props.address`，SPI 按 `props.cs`，
  I2S 按 `props.bus`（详见 [内建外设参考 · 路由速查](04-peripherals.md)）。
- **快照即渲染**：`pixels`/`level`/`tone`/`audio`/`waveform`/`text` 六种快照
  （PRD §6.4）；30fps 节流由宿主负责，模型每次状态变化正常 emit 即可。
- **主动输入**（可选）：`ctx.emitInput`（I2S PCM / GPIO 电平 / I2C 读回复）、
  `driveInput`、`rotate`、`acceptCapture`——按键、旋钮、传感器、麦克风走这条路。

## 3. 本地目录加载（离线市场）

1. 把包目录放进 `~/.breadesp/peripherals/`（或用 `--into` 直接生成到那里）。
2. 打开应用，左侧 **Peripheral catalog** 面板点 Rescan——包以 `ready` 状态出现
   （坏清单/坏入口降级为 `invalid` 并列出全部问题；SDK major 过新标 `incompatible`）。
3. 点 **Load**：Bridge 动态 import 入口模块，注册成功后元数据镜像回渲染进程——
   **palette 与画布立即出现新器件，无需任何 UI 代码**。
4. 拖上画布、连线、跑固件——事务经与内建外设完全相同的通用路径路由到模型。

加载语义：显式触发（扫描外的目录报 `[BB-224]`）；入口未注册任何 kind 或执行失败
报 `[BB-223]` 并回滚部分注册；同目录重复加载幂等；修复文件后可直接重试；
热更新/卸载需重启应用。

## 4. 注册门控与错误码

| 错误码 | 含义 |
|---|---|
| `[BB-220]` | 工厂形状非法（kind/version/displayName/pins/defaults/create），错误信息一次列全 |
| `[BB-221]` | kind 已被注册（先注册者不被替换） |
| `[BB-222]` | `sdkVersion` major 高于宿主 `PERIPHERAL_SDK_VERSION` |
| `[BB-223]` | 加载失败（入口异常/默认导出非函数/零注册），已回滚 |
| `[BB-224]` | 目标不是当前扫描中的 `ok` 条目 |
| `[BB-230]` / `[BB-231]` | 脚手架请求非法 / 目标目录非空（永不覆盖） |

## 5. 测试约定

每个外设至少一个单测覆盖"典型事务 → 预期快照"路径；工厂用
`validatePeripheralFactory()` 预检。脚手架生成的 `self-check.mjs` 就是这一约定的
零依赖形态——改模型时同步扩展它。

## 下一步

- 完整 SDK 契约（双进程注册、版本化、UI 自动呈现）：[外设 SDK 指南](../peripheral-sdk.md)。
- 接口定义真相源：[PRD §6.1–6.4](../../PRD.md)。
