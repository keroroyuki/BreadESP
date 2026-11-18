# BreadESP Architecture

> Read alongside [`PRD.md`](PRD.md) §4. This document expands on implementation details but does not modify the PRD contract.

## 1. Process Model

```
┌──────────────┐  contextBridge  ┌──────────────────────┐  stdin/stdout  ┌────────────────┐
│  UI 进程       │ ────────────── │  Bridge (Node)        │ ────────────── │  QEMU-ESP32    │
│ (Electron      │  ipcRenderer   │  (Electron 主进程)     │  + QMP + DBus   │  (子进程)        │
│   renderer)    │                │  - QemuRunner         │  socket         │  - CPU          │
│ React+Konva+3D │                │  - GdbBridge          │                 │  - Flash/RAM    │
│                │                │  - PeripheralManager  │                 │  - 外设模型      │
│                │                │  - ProjectManager     │                 │  - DBus Forward │
│                │                │  - NetlistResolver    │                 │    Device        │
└──────────────┘                 └──────────────────────┘                 └────────────────┘
```

## 2. DBus Forward Device (Key Custom Device)

The stock peripheral models in QEMU-ESP32 are incomplete. We add a device `breadesp-dbus` to the QEMU source tree (landed in P1.2):
- **I2C**: dynamically attach a wildcard slave to each `esp32-i2c` controller (`breadesp-dbus.i2c-sniffer`) that only ACKs addresses not claimed by QEMU's built-in peripherals and fully captures START/data/STOP. Read replies (P3.4): the sniffer's `recv` callback supplies data byte by byte from a reply mailbox keyed by (bus, address) (the mailbox is atomically replaced by `i2c-out` reverse frames, emulating the "latest value wins" semantics of a sensor's read registers); an empty/drained mailbox replies 0xFF (SDA idle high), and firmware should retry until it reads real data (a reply round trip cannot complete within the same synchronous TRANS_START).
- **SPI** (P2.1): attach an SSI sniffer slave to each generic `esp32.spi` controller bus (`breadesp-dbus.spi-sniffer`, `SSI_CS_NONE` polarity so every byte is visible); the controller's hardware CS output line is wired to the sniffer's GPIO input: CS going low opens a frame (the line number becomes `tx.target`, i.e. CS index 0–2), and when CS is released the whole frame's bytes are emitted as one `spi` write transaction. The bus hosting flash/PSRAM gets no sniffer. The SSI slave class must implement the `realize` callback, otherwise QEMU dereferences a null pointer during the realize stage and SIGSEGVs outright.
- **GPIO**: high-priority shadow MMIO over the GPIO register banks at both base addresses, DPORT(0x3ff44000) and APB(0x60004000), decoding OUT_W1TS/W1TC writes into pin-level transactions while passing the original access through. Input injection (P3.4): stock `esp32.gpio` is a stub with only strap registers and no qdev input lines, so input levels driven by `gpio-in` reverse frames are merged into GPIO_IN/IN1 register reads on the shadow read path (only pins "claimed" by the Bridge are overridden; the remaining bits keep the underlying model values); GPIO edge interrupts are not modeled (the stub never had them), so firmware reads inputs by polling.
- **PWM** (P2.3): an observe-only shadow over the LEDC register bank (same dual-base-address approach), decoding timer/channel configuration into (frequency, duty cycle); GPIO matrix `FUNCn_OUT_SEL` writes map the LEDC output signal to a pin, and every pin tone change emits one `pwm` transaction (QEMU's built-in LEDC model never drives pins, so without the shadow firmware tones are invisible).
- **I2S** (P2.4): the stock tree models esp32.i2s0/1 as unimplemented-device, so we add a high-priority shadow for both legacy register banks (0x3ff4f000/0x3ff6d000, 0x1000 each; attached when the probe base address exists, which also serves as an esp32-only guard), observing CONF/CLKM_CONF/SAMPLE_RATE_CONF/OUT_LINK. After TX_START + OUT_LINK_START, a virtual clock timer (10ms tick) walks the TX DMA linked-list descriptors at the decoded PCM byte rate (lldesc_t: dw0's length[23:12], buf, next; `OUTLINK_ADDR` is a 20-bit window field whose physical address is 0x3ff00000|field, whereas buf/next are full 32-bit pointers—we tripped over this and the first version was silent), reading guest memory via `address_space_read`; a descriptor ring (next pointing back inside the chain) loops naturally—the standard way firmware plays audio continuously; each tick is aggregated into one `i2s` transaction (8-byte format header + raw interleaved little-endian PCM). Sample-rate formulas: sck=160M/div, bck=sck/bck_div, ws=bck/(bits×channels) (APLL is a documented gap; the non-DMA FIFO_WR direct-write path is not modeled).
- **I2S RX injection** (P3.1): the socket becomes bidirectional—the Bridge writes back `{"v":1,"in":[{"kind":"i2s-in",...}]}` with the same length-prefixed framing (field order is part of the protocol; the device side is an ordered scanner). The shadow also observes IN_LINK and the RX half of CONF/SAMPLE_RATE_CONF; after RX_START + IN_LINK_START, the same 10ms tick consumes each controller's injection queue at the firmware-decoded RX byte rate (256KB cap; on overflow the oldest is dropped with a one-time warning), writes the samples into the DMA owner's descriptor buffer via `address_space_write`, then writes back dw0 (owner cleared, length filled in, eof set—consistent with the real DMA engine), so polling firmware reads microphone samples. When the queue runs dry, descriptors stay armed rather than being preempted with silence (we tripped over this too: zero-filling to clear owner deadlocks against firmware that re-arms only after receiving data).
- Transactions are batch-flushed in a bottom half into length-prefixed JSON frames (PRD §6.7) and sent to the Bridge over a TCP/unix socket.
- The Bridge's `DBusChannel` deserializes them (virtual ns → logical ms) and hands them to `PeripheralManager`, which routes them to the matching peripheral instance.

> The device source (C) lives in `packages/sim-core/device/breadesp_dbus.c` and is integrated into the pinned espressif/qemu tag in a zero-patch way (a single .c plus a meson registration). `scripts/build-qemu-device.mjs` builds it standalone with Docker (Linux) or MSYS2 (Windows); the artifact lands in the gitignored `packages/sim-core/bin/qemu-breadesp/`, and `bin/qemu-breadesp.json` records metadata (§10.6, not committed).

## 3. Peripheral Routing Flow

1. Firmware executes `i2c_master_write_to_device(addr=0x3c, ...)`.
2. The QEMU I2C controller produces a write transaction → DBus Forward Device serializes it → Bridge socket.
3. `DBusChannel` parses it into `BusTransaction{kind:'i2c',bus:0,target:0x3c,dir:'write',...}`.
4. `NetlistResolver` routes according to the netlist: I2C by 7-bit address (`props.address`, falling back to `factory.defaults.address`); SPI by CS line (`tx.target` is the CS index 0–2, an instance claims it via `props.cs`, and the factory pin table must contain the `spi-cs` role to participate in matching); GPIO by `mcu.GPIO<n>` wiring (all peripherals on the same pin receive it).
   `PeripheralManager.route()` delivers only to the resolved instance and no longer broadcasts.
5. `PeripheralManager` calls `oled1.onTransaction(tx)`. An error thrown by a single peripheral model only logs `[BB-201]` (including instanceId/transaction context) and does not block delivery of the same transaction to other instances.
6. The SSD1306 model updates video memory → `ctx.emitSnapshot(pixels)` → 30fps throttle gate (see §3.1) → `snapshot` event → pushed to UI Canvas rendering.

### 3.1 Snapshot throttling (PRD §9 performance budget)

High-frequency bus transactions (e.g. an I2C screen refresh every millisecond) cannot go straight to the UI one by one. `PeripheralManager` maintains one throttle slot per `(instanceId, snapshot type)`, guaranteeing an emission interval ≥ 1000/30 ms:

- **Leading edge fires immediately**: the first snapshot after a quiet period is emitted at once, guaranteeing low latency.
- **Coalescing within the window**: snapshots arriving less than one interval after the last emission go to pending (last-write-wins, keeping only the newest state), flushed by a timer at the end of the window.
- **Reset semantics**: re-running `applyNetlist` rebuilds all instances and clears the throttle slots (including cancelling a trailing flush that has not fired), so stale pending snapshots from destroyed instances never reach the UI.
- The UI only needs to apply the latest snapshot per `instanceId` to converge to the correct state.

### 3.2 Routing robustness

- **Atomic netlist swap**: `applyNetlist` first builds all instances in a temporary map (a duplicate instanceId reports `[BB-200]`, an unknown kind throws outright); any instance creation failure disposes the partial result and keeps the old instances and old routing, so the netlist is never partially applied.
- **Swapping the netlist swaps instances**: before a new netlist is committed all old instances are disposed, preventing old models from holding stale state.
- **Error isolation**: `route()` wraps each target's `onTransaction` in its own try/catch (see §3 step 5).
- **Injectable clock**: the time source of the throttling window can be injected through the constructor (default `Date.now`), so tests use a synthetic clock to deterministically verify the 30fps cap.

### 3.3 SSD1306 command interpreter (P1.6)

`packages/peripherals/src/ssd1306.ts` interprets the I2C transaction stream with datasheet semantics, covering the drawing paths commonly used by Adafruit_GFX (begin() initialization + display() full-frame push):

- **I2C framing**: the first byte of each write transaction is a control byte (bit7 Co / bit6 D/C#, i.e. 0x00/0x40/0x80/0xC0), and the rest of the segment is a command stream or a data stream; no in-stream scanning is done, so data bytes 0x00/0x40 are payload rather than framing. QEMU may split one logical write into multiple transactions; a fragment whose first byte is not a canonical control byte continues the previous data stream.
- **Multi-byte commands**: commands that take parameters (0x21/0x22 window, 0x81 contrast, 0xDA COM pins, scroll commands, etc.) are consumed atomically using a parameter count table, so parameters are never misparsed as opcodes; parameters may span transactions.
- **Addressing modes**: page mode (power-on default, lower/upper column nibbles + 0xB0-0xB7 page pointer, column wraps at 128), horizontal mode (Adafruit display() default, column-major advance within the 0x21/0x22 window), vertical mode (page-major). Column/page pointers persist across transactions, so arbitrarily chunked data streams land in video memory correctly.
- **Render-time orientation**: video memory is stored in the datasheet page/column layout; segment remap (0xA0/0xA1), COM scan direction (0xC0/0xC8), start line (0x40-0x7F), inverse (0xA7), entire display on (0xA5) and the power-on state (display off = blank) are applied only at snapshot time. The module wiring convention (0xA1+0xC8) (Adafruit default) is the identity transform, so GFX coordinates map directly to glass coordinates. Not modeled: hardware scrolling (0x26-0x2F), brightness fade (0xA2/0xA3).

### 3.4 ST7789 command interpreter (P2.1)

`packages/peripherals/src/st7789.ts` interprets the SPI transaction stream with datasheet semantics, covering the drawing paths commonly used by TFT_eSPI / Adafruit_ST7789 (init sequence + window push of RGB565 pixels):

- **Command/data demultiplexing**: the DC line is an ordinary GPIO, routed to the instance through a netlist wire (`props.dc`); QEMU's SPI controller clocks out the entire CS frame atomically, so the DC level sampled at frame time applies to the whole frame—DC=0 means the whole frame is command opcodes, DC=1 means the whole frame is data (command parameters or the RAMWR pixel stream). When DC is unwired, warn once and discard SPI frames (demultiplexing is impossible).
- **Multi-byte commands**: CASET/RASET/MADCTL/COLMOD plus the gamma/power blocks are consumed atomically with a parameter count table; parameters may span transactions; any DC=0 byte resets the parser, and a parameter gap is cleared by the next command, so the stream cannot desync.
- **GRAM addressing**: the CASET/RASET window and address counters persist; the counter starts at the window origin, advances X-major and wraps within the window. MADCTL is the per-pixel address→glass coordinate transform: MV swaps axes first, then MX/MY mirror columns/rows (consistent with the datasheet memory write scan figure and with the rotated partial windows of setRotation).
- **RAMWR semantics**: 0x2C resets the address counter to the window origin and accepts subsequent DC=1 bytes as a pixel stream; any other command terminates the stream (datasheet wording); pixels are sent high byte first, and a half pixel may span transactions.
- **Render state**: DISPON/DISPOFF, SLPIN/SLPOUT (both blank), INVON/INVOFF (bitwise inversion of RGB565), MADCTL RGB/BGR order (channel swap at snapshot time). The snapshot is a 240x240 RGB565 array.
- **Not modeled** (documented gaps): gamma curves, partial/scroll areas, idle mode, the RST hard line (SWRESET 0x01 already covers soft reset), the MISO read channel (the same PRD §6.3 TODO shared with I2C).

### 3.5 Speaker I2S PCM pipeline (P2.4)

`i2s` transactions forwarded by the device are claimed and routed by `NetlistResolver` according to controller number (instance `props.bus`, falling back to the factory default 0; the factory pin table must contain the `i2s-data-in` role—isomorphic to SPI CS claiming, the DIN/WS/BCK wires are used only for UI drawing). `packages/peripherals/src/speaker.ts` decodes the `[sample rate][bit depth][channels]` header + raw PCM into mono Float32 (multi-channel is averaged) and emits an `audio` snapshot per transaction (`{samples, sampleRate}`, the existing type from PRD §6.4 enabled for the first time). On the UI side, `SpeakerPcmEngine` in `audio/SpeakerAudio.ts` maintains one playback cursor per instance, arranging successively arriving chunks into back-to-back AudioBufferSourceNode (when underrun exceeds a threshold it resyncs against the wall clock to avoid playing backlogged stale audio); `audioFromSnapshot` is a pure mapping kept separate from the engine and covered by Node unit tests with a stub AudioContext.

### 3.6 Oscilloscope waveform capture (P2.5)

The oscilloscope is a breadboard part rather than a global probe: the `oscilloscope` model exposes CH1..CH4 (`probe` role, a member added in §6.1) and receives transactions through the existing wire-level gpio/pwm routing—no changes are needed on the QEMU device side (the GPIO shadow already reports level changes on the virtual clock). Multi-channel attribution relies on the optional `Peripheral.onTransaction(tx, viaPin?)` parameter added in §6.2: PeripheralManager passes the landed pin resolved by NetlistResolver to the model. The model keeps a per-channel edge ring buffer (virtual ms timestamps), pruned to a rolling window (`props.windowMs`, default 200ms)—one edge before the window is retained and re-anchored to t=0 so the trace enters the window at the correct level. Pins driven by LEDC have no real toggling, so the steady state (frequency, duty cycle) of `pwm` transactions synthesizes in-window edges when the snapshot is built (equivalent to a real oscilloscope's trigger view); real gpio writes supersede the synthesized state. The snapshot is `WaveformPayload`, a new add-on payload variant of the 'waveform' type (`{startMs, windowMs, channels:[{label, edges:[{t, level}]}]}`)—a whole-window restatement, safe for 30fps last-write-wins coalescing, with identical payloads deduplicated at the source. On the UI side, `components/Oscilloscope/traceBuilder.ts` is pure geometry (step polyline: the first edge back-extrapolates the preceding level, out-of-range clamping, empty channels on the low rail, evenly divided grid, channel bands, stable colors), and the panel component draws a dark grid plus multi-channel digital traces labeled with the time base. I2S bus capture is a P3 TODO.

### 3.7 Mic I2S RX injection pipeline (P3.1)

`mic` is an input-class peripheral (PRD §F-PER-7): the model generates PCM chunks at a wall-clock interval from the waveform configured in props (sine/square/noise/silence + freqHz/amplitude/sampleRate/bits/channels/bus, all validated, clamped and defaulted) (`generatePcmChunk` is a pure function, phase-continuous across chunks, noise using deterministic xorshift32), reported through the optional `PeripheralContext.emitInput(I2sInjection)` added in §6.2; PeripheralManager turns it into an `inject` event, the holder wires it to `DBusChannel.sendInject()` (reverse frame `{"v":1,"in":[{"kind":"i2s-in",...}]}`, with sendInject filling in the `kind` field automatically), and the device side feeds it into the firmware DMA ring buffer per the RX injection mechanism in §2. Host/guest clock drift only manifests as trimming/waiting of the device queue and never corrupts the sample stream. UI side: palette and canvas node (capture toggle see §3.8; waveform panel see §3.9). The golden firmware `mic.elf` (deterministically generated by `scripts/make-mic-elf.mjs`, `--check` prevents drift) sets up a 4×256B in-link ring, configures I2S0 RX (33.3kHz/16bit/mono), unconditionally re-arms all descriptors every round (the standard ring consumption pattern), and prints `MIC OK` after 8 non-zero buffers have accumulated.

### 3.8 Local microphone capture (P3.2)

P3.2 connects mic to the host machine's real microphone, forming a real-time input chain:

```
渲染进程 getUserMedia → ScriptProcessor 采集（零增益 mute 防回授）
  → per:captureChunk IPC（48kHz mono Float32，边界校验 [BB-202]）
  → PeripheralManager.feedCapture → mic.acceptCapture（§6.2 追加可选成员）
  → drainResampled 线性重采样到 props.sampleRate → 既有 I2sInjection 反向通道
```

- **Capture is a pure runtime override state and never lands in the netlist**: while the feed stream is alive (a new chunk within 500ms) ticks take the capture path; on timeout the buffer is dropped and it falls back to the synth waveform—reopening a project never automatically requests microphone permission.
- **Starvation semantics**: no injection is sent while the capture buffer is empty (the device keeps DMA descriptors armed), and it is never preempted with silence; the buffer holds at most 1s of source audio, dropping the oldest to keep latency low; a source rate change resets the buffer rather than smearing across rates.
- **UI side**: `audio/MicCapture.ts` (a stub-friendly minimal getUserMedia/WebAudio surface that does not depend on the bridge module) + `store/captureStore` (instance-level lifecycle, [BB-210] error surface, netlist reconcile stopping capture for deleted instances) + the canvas mic node's REC/LIVE toggle.
- QEMU device unchanged (reusing the P3.1 reverse channel); the waveform generator panel is P3.3.

### 3.9 Waveform generator panel (P3.3)

`components/WaveGen/WaveGen.tsx` renders one editor card per mic instance on the breadboard: waveform (sine/square/noise/silence), frequency, amplitude slider, sample rate, bit depth, channel count, plus a waveform preview canvas with a fixed 5ms wall-clock window (a normalized period preview cannot show frequency changes, a fixed window can). Edits are shallow-merged into the instance's netlist `props` via `projectStore.updatePeripheralProps` (pure logical edit: layout identity unchanged, unknown instanceId is a no-op)—a netlist identity change triggers App's existing `bb:applyNetlist` effect, and the Bridge atomically rebuilds the mic instance, taking effect immediately, **with no new IPC**. Unlike capture (§3.8, a pure runtime override), generator configuration persists with netlist.json; while capture is running the card indicates that synth is being overridden. Pure logic is factored out into `wavegenDraft.ts` (draftFromProps/draftPatch/previewTrace/renderWavePreview), with normalization and value ranges entirely delegated to the single source of truth `micConfigFromProps`/`MIC_LIMITS` exported by the mic model—the panel can never produce a configuration the model would reject.

### 3.10 Rotary knob and temperature and humidity sensor input chain (P3.4)

P3.4 generalizes the reverse channel from "I2S PCM only" to three kinds of injection (PRD §6.7) and lands two input peripherals:

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

- **knob model** (`peripherals/src/knob.ts`): one detent = a Gray ring of 4 phase transitions (A leads B when CW); `rotate(delta)` merges the queue by net displacement (8 steps forward queued, then -4 steps, leaves a net +4—a knob physically never visits cancelled positions), a single call is clamped to ±64 detents and the queue is capped at 256 detents (preventing panel click flooding); unwired pins drop transitions with a one-time warning ([BB-205]). The SW push switch reuses the existing `per:driveInput` channel (that channel has actually been wired to injection since P3.4—closing button's P1 TODO along with it).
- **sht30 model** (`peripherals/src/sht30.ts`): default address 0x44 (props may change it to 0x45 etc.), props `temperatureC`/`humidityRh` clamped to the datasheet range; supports six measurement command words (clock stretching or not × three repeatability levels), status register read (0xF32D, including heater bit tracking), soft reset/heater on-off; periodic measurement mode is not modeled (one-time warning). Replies always appear on the bus on which the command arrived; both construction and every measurement command emit a text snapshot for the canvas node to display.
- **DBusChannel.sendInject generalization**: serializes the three frame kinds field by field according to the discriminant field `kind`—field order is a protocol contract (the device is an ordered scanner) and must never be produced by spreading model objects (the same defense line as the P3.1 lost-kind incident); unit tests freeze the wire format with exact strings.
- **applyNetlist ordering fix**: instances may drivePin during construction (the knob's static-state sync), whereas the old implementation built instances before swapping routing—construction-time drives would go into the old routing. Now routing is built on a temporary resolver first, instances are created referencing the temporary resolver, and only when everything succeeds is it committed atomically (atomicity semantics unchanged).
- **UI**: two new palette entries; the canvas knob node's CCW/CW buttons are wired directly to `per:rotateKnob`; the sht30 node displays a text snapshot (falling back to readings derived from props when the Bridge has not answered), and the four small T±1°C / H±5%RH buttons go through `sensorDraft.adjustSht30` (normalization delegated to the single source of truth `sht30ConfigFromProps`/`SHT30_LIMITS`) and take effect via the existing `updatePeripheralProps` → `bb:applyNetlist` rebuild chain, with no new IPC.
- **Golden firmware**: `knob.elf` (`make-knob-elf.mjs`) polls GPIO_IN and decodes the quadrature count with a 16-entry transition table (prints `KNOB CW` at +8, `KNOB ZERO` on returning to zero); `sht.elf` (`make-sht-elf.mjs`) issues a measurement command and then reads 6 bytes with up to 250 retries, comparing each byte against the expected reading (retries are necessary: a reply round trip cannot span the synchronous TRANS_START)—a match prints `SHT OK`, exhaustion prints `SHT FAIL`. The assembler gained add/sub encodings (cross-checked against the pinned decoder table).


## 4. Debug Chain

- QEMU starts with `-gdb tcp::1234`, exposing the GDB stub.
- The Bridge's `GdbBridge` connects to 1234 using `xtensa-esp32-elf-gdb --interpreter=mi`.
- The UI calls GdbBridge through `dbg:*` IPC, and GdbBridge translates them into GDB/MI commands.
- `MiParser` parses MI output into structured results (breakpoint list, variables, registers).

### 4.1 Debug panel (P1.9)

- **Connection model**: `QemuRunner.load()` always allocates a GDB stub port (`-S` frozen start), and the debug panel attaches lazily via `dbg:connect`—the port and firmware path are remembered by the main process (`getGdbPort`/`getFirmwareElf`), so the renderer process never has to reserve a port itself. `sim:step` routes to `-exec-step-instruction` once GDB is attached (instruction-level stepping was always a stub capability per PRD §F-SIM-1).
- **IPC surface**: `dbg:connect/disconnect/status` manage the connection; `dbg:setBreakpoint/removeBreakpoint/clearBreakpoints/listBreakpoints` maintain breakpoints (`-break-insert/-break-delete/-break-list`; note that `-break-list`'s `body` is nested inside `BreakpointTable`—we once misparsed it because the mock and real GDB shapes differed, and an e2e run caught it, after which the wire format was aligned); `dbg:continue/step/stepOver` control execution; `dbg:vars/regs/evaluate` read the inspected state (`-stack-list-variables --simple-values`, `-data-list-register-names` + `-data-list-register-values x` paired by index, `-data-evaluate-expression`). Asynchronous stops are pushed via `dbg:stopped/running/exit`, so the UI does not need to poll.
- **UI state machine** (`debuggerStore`): `detached → attached ⇄ running`. `onStop` records the stop frame and automatically refreshes variables/registers/watches; late in-flight replies after detach are discarded (avoiding dirty write-backs).
- **Test firmware**: `blink.elf` ships a hand-built DWARF4 (`.debug_info`/`.debug_abbrev`)—`app_main`'s locals live in registers (DW_OP_regx), while the global `led_state` lives in PT_LOAD memory (DW_OP_addr), giving vars/regs/evaluate real data in e2e.

### 4.2 DAP adapter (P4.5, PRD §F-DBG-6)

`packages/shell/src/debugger/dap/` provides a standard Debug Adapter Protocol entry point, so DAP clients such as VS Code can debug the same QEMU instance instead of the built-in panel (usage see [dap.md](dap.md)):

- **Layering**: `DapServer` (session/command dispatch, stdio or TCP transport, Content-Length framing hand-written by `DapProtocol` with zero dependencies) → `DapBackend` (interface) → `QemuGdbBackend` (composes `QemuRunner` + `GdbBridge`). In launch mode the backend brings up a `-S` frozen VM and then attaches GDB; attach mode connects to an existing stub (e.g. a simulation already running in the Electron app). Execution control lives in GDB: continue is `-exec-continue` rather than QMP `cont`, and in launch mode QemuRunner stays `loaded`, avoiding a double resume that would tear apart the VM's and GDB's stopped/running state.
- **GDB surface**: reuses all GdbBridge capabilities from P1.9/P4.4; P4.5 adds `stackFrames()` (`-stack-list-frames`, whose MI elements are likewise wrapped in a single `frame={...}` key—the mock-driven first version missed the unwrapping and unit tests caught it), `stepOut()` (`-exec-finish`), `interrupt()` (`-exec-interrupt`), `removeBreakpoints(ids)` (batched `-break-delete`) and `env` passthrough.
- **esp-gdb 17.x dynconfig** (`XtensaDynconfig.ts`, a compatibility fix captured by a real e2e run): esp-gdb 17.x's built-in Xtensa register layout does not match the espressif QEMU stub (`-target-select` reports `Remote 'g' packet reply is too long`), so GdbBridge automatically sets `XTENSA_GNU_CONFIG=<gdb>/lib/xtensa_<chip>.so` based on `chip` (benefiting both `dbg:connect` and DAP; an explicit user setting takes precedence, and RISC-V chips do not need it). `QemuRunner.getChip()` was added for this.
- **Stop reason mapping**: GDB reason → DAP reason (breakpoint/step/data breakpoint/entry/pause); a reason-less first stop when attaching to a frozen VM maps to `pause`.
- **Breakpoint set semantics**: replaced as a whole group per source file (delete the old set with `-break-delete` first, then insert); positions GDB rejects degrade to lines with `verified=false`; function and conditional breakpoints reuse `-break-insert [-c]` from P4.4.

## 5. Simulation State Machine

```
idle --load(fw)--> loaded --start--> running --pause--> paused --start--> running
                                            \--- step (GDB attached) --> paused
running/loaded/paused --reset--> loaded
any --error--> error
```

Since P1.9, `step` goes through the GDB stub (`sim:step` routes to `-exec-step-instruction` after `dbg:connect` attaches; when not attached it reports `[BB-105]` and prompts to connect the debugger first).

## 6. Timing and Audio

- Main logical clock: QEMU virtual time, event-driven, not aligned to the wall clock.
- Audio peripherals: use a separate real sample-rate clock to avoid jitter (PRD §4.3).
- Explicitly declared: not real-time and not timing-accurate (noted once at UI startup).

## 7. Security Sandbox

- QEMU `-nic none` disables networking (PRD §9).
- Before loading an ELF, validate that the e_machine field is Xtensa (preventing crashes from loading non-target firmware).
- Bridge child processes run with restricted privileges; no external commands are ever executed automatically.

## 8. Breadboard Editing (UI side, P1.7)

Editing operations on the canvas (`packages/ui` Konva Stage) follow "logic/visual separation" (PRD §F-BB-4):

| Operation | Data changed | Sent to Bridge |
|---|---|---|
| Drag-and-drop to place a peripheral | `netlist.peripherals` + `layout.items` | Yes (rebuild instances) |
| Drag to move a node | `layout.items` only | No |
| pin → pin wiring | `netlist.wires` only | Yes (rebuild routing) |
| Delete node / wire | netlist (cleaning up dangling wires along with it) | Yes |

- **Two persistence halves**: `netlist.json` (logic) and `layout.json` (`{version:1, items:[{instanceId,x,y,kind}]}`, matching the shape written by `ProjectManager.newProject`) never contain each other's fields; the store provides separate serialization functions (`toNetlistFile` / `toLayoutFile`), and the netlist always passes `validateNetlist` after any edit sequence.
- **Change propagation**: `App` subscribes to the netlist by object identity and, via `bb:applyNetlist`, has `PeripheralManager` atomically rebuild instances and routing (PRD §4.2 steps 1–2); moving a node does not change netlist identity, so dragging does not trigger a rebuild.
- **Single source for pin anchors**: the pure functions in `components/Breadboard/pinLayout.ts` convert Wire endpoints into canvas coordinates; pin dots and wire Béziers share the same formula and never drift; pin metadata reuses `factory.pins` from `@breadesp/peripherals` directly (the renderer process imports the pure TS registry).
- **Wiring constraints (MVP)**: the UI allows only peripheral pin ↔ MCU GPIO wiring (peripheral ↔ peripheral is not routable, see §3); self-loops and duplicate wires (including endpoint swaps) are rejected at the store layer; deleting an instance removes its wires along with it, avoiding dangling endpoints.
- **Deterministic ids**: instance and wire ids are generated as `prefix-<smallest free ordinal>`, so they do not conflict after loading an existing project.
- The MCU node is fixed on the left of the canvas and exposes the usable ESP32 GPIOs (6-11/20/24/28-31 are flash/nonexistent and are not shown); canvas LEDs light up in real time from the `level` snapshot, and button presses are injected via `per:driveInput`.
- **UX interaction layer (2026-09-30)**: the Stage adapts to its container via ResizeObserver; the wheel zooms around the pointer and dragging the background pans (`canvasViewStore` transform, the grid is drawn in world coordinates); placement/movement snap to the grid, drag-and-drop shows a ghost preview, pin/wire hover highlights; selection goes through `selectionStore` (instances/wires mutually exclusive, Delete removes, Esc clears); feedback goes through the global ToastHost (info/error levels), and an empty canvas shows an onboarding guide. Property/debug entries are in the right-hand `RightPanel` (Radix Tabs, the debug page uses forceMount to preserve input state).

**UI layout (UX, 2026-09-30)**: a single-row TopBar (brand + simulation status light | project group | firmware badge→Radix Popover | simulation controls including undo/redo | language switch + `?` shortcut help) replaces the old header + three stacked toolbars; the left column is the Palette (with search filter) + peripheral catalog; the center is the canvas; the bottom is the BottomDock (four instrument panels: serial/scope/screen/wavegen, collapsible, individually toggleable, localStorage persistence); a global ToastHost overlays feedback. Copy is bilingual Chinese/English (i18n dictionary, `document.documentElement.lang` follows the locale).

### 8.1 3D view (2026-10-23, `components/Breadboard3D/`)

A switchable view alongside the 2D canvas (`viewModeStore`, default 3D; `BreadboardHost` mounts `BreadboardCanvas` or the lazily loaded `Canvas3D` depending on the mode), sharing the same netlist, layout, selection state and snapshots:

| Concern | Implementation | Invariant |
|---|---|---|
| Project format | `boardSpace.ts`: world `(x,y)` → board `(x, 0, y)`, +Y up | `layout.json` keeps 2D coordinates, both views can open each other |
| Part modeling | `models/*`: procedural geometry, bottom face sitting at y=0; `modelCatalog`/`modelRegistry` use `Record<ModelKey, …>` to guarantee exhaustiveness | Unmodeled kinds fall back to `generic` and do not block third-party peripherals |
| Pins | `wiring/pinRows3d.ts` takes identity from `factory.pins` and places it on the model's own header pins; MCU pads come from `mcuPinLayout` | Pin identity has a single source; 3D placement does not pollute 2D anchors |
| Wiring | `WiresLayer` (arc height scales with span); the `Breadboard/wiringFlow.ts` decision function is shared by 2D/3D | Wiring rules cannot fork between the two views |
| Live state | Snapshot → LED brightness / buzzer duty cycle / speaker activity / microphone LIVE; screens reuse `OledRenderer`/`TftRenderer` via `CanvasTexture` | 3D glass and sidebar screen pixels match |
| Interaction | Drag part = move (orbit rotation disabled while dragging), drag empty = rotate, wheel = zoom, right-click = pan; panel drag-in via ray bridge + dashed ghost; pins picked by "3D distance from the click ray to the anchor" (avoiding occlusion by the model itself) | Snapping/clamping/undo coalescing are exactly the same as 2D |
| Robustness | WebGL detection cached (mode switching remounts), error boundary (can return to 2D), `WebGL2 · GPU · FPS` badge; dev-only probes `__bb_scene/__bb_project/__bb_pick` are stripped from production builds | No blank column is left when WebGL is unavailable |

- **Dependencies**: `three@0.170`, `@react-three/fiber@8`, `@react-three/drei@9` (r3f v9/drei v10 require React 19, so the React 18 branch is locked); 3D is a separate chunk that 2D sessions never parse (the Vite `chunkSizeWarningLimit` comment explains why).
- **Validation**: `boardSpace` / `modelCatalog` / `pinRows3d` / `wiringFlow` / `wiring3dStore` are all pure logic and covered by unit tests; visuals and interaction are accepted in Electron with synthetic input (panel drag-in, drag snapping, pin wiring, wire deletion, Delete, 2D regression).

## 9. Project Persistence (P1.8)

A project is a directory (PRD §F-PROJ-1), and on the Bridge side `ProjectManager` is its only disk reader/writer:

```
<dir>.breadesp/
├── firmware.elf   # importFirmware 拷入（经 BB-101 架构闸门）；open 返回其路径或 null
├── netlist.json   # 逻辑半区（实例 + 连线），save 前必过 validateNetlist
├── layout.json    # 视觉半区 {version:1, items:[{instanceId,x,y,kind}]}，save 前必过 validateLayout
└── meta.json      # {version:1, createdAt, updatedAt}，save 只递增 updatedAt
```

- **Lifecycle**: `newProject` (write the skeleton, refusing to overwrite an existing project) / `openProject` (read + validate all four files, returning `ProjectData`) / `saveProject(netlist, layout)` (validate both halves, then write atomically) / `saveAs` (new directory skeleton + full save) / `close`. `importFirmware(elf)` validates against netlist.chip and then copies the firmware into the project.
- **Layout contract moved down**: the `LayoutFile`/`LayoutItem` types and `validateLayout` are defined in `@breadesp/netlist` (shell disk writes and ui serialization share one source, so types are not scattered); layout validation is structure + coordinate finiteness + unique instanceId.
- **Failure semantics**: directory missing / `meta.json` missing → `[BB-120]`; corrupt meta → `[BB-121]`; netlist read/validation failure → `[BB-122]`; layout read/validation failure → `[BB-123]`; no project open / the directory already holds a project → `[BB-124]`. A failed open does not change the currently open project; when save validation fails, nothing is written to disk.
- **UI side**: `TopBar/ProjectGroup` (new/open/save/saveAs/close + new-project wizard entry, directory as an MVP text input, native directory picker TODO(PRD §F-PROJ-2)) → `proj:*` IPC → store `loadProject` (hydrates both halves; a change in netlist object identity automatically triggers `bb:applyNetlist` to rebuild Bridge instances) / `resetProject`. After loading, the id generator continues from the occupied ordinals and will not conflict with ids in the project.
- **Round-trip guarantee (acceptance)**: after save → close → reopen, `ProjectData.netlist/layout` are structurally equal to the saved values; already covered by ProjectManager unit tests, a real temporary-directory round trip, and preload→handlers→ProjectManager IPC integration tests (including the two-way JSON serialization boundary).

## 10. Serial Console (P1.10)

UART0 is the firmware's standard console (PRD §F-SER-1/§F-SER-2), with the following bidirectional chain:

```
输出  QEMU UART0 TX → stdout 管道 → QemuRunner 'uart' 事件 → sim:uart 推送 → SerialConsole 滚动区
输入  SerialConsole 输入框 → sim:sendUart IPC → QemuRunner.writeStdin → stdin 管道 → QEMU UART0 RX FIFO
```

- **Output side**: `QemuRunner` aggregates stdout chunks into uart logs (`getUartLog()`), pushes them to the renderer process via preload's `sim:uart`, and `SerialConsole` appends them to the store's `uart` buffer.
- **Input side**: `writeStdin(data)` writes bytes into the QEMU child process's stdin; before load it throws `[BB-102]`. The UI only enables the input box in the `loaded/running/paused` states (when the child process exists).
- **Line terminator convention**: injection always ends with `\n` and never carries `\r`—QEMU's Windows stdio backend (`win_stdio_thread` in `char-win-stdio.c`) forwards byte by byte but **drops `\r`**, so CRLF would starve firmware that splits lines on `\r`. Linux has no such problem, but uniform LF keeps behavior consistent on both sides.
- **Golden firmware**: `packages/sim-core/fixtures/uart-echo.elf` is deterministically assembled by `scripts/make-uart-echo-elf.mjs` (l32r/movi/l8ui/s8i/addi/bnez/j from `xtensa-elf.mjs` + the newly added l32i encoding): it prints a banner, then polls `UART_STATUS.RXFIFO_CNT` (0x3ff4001c low 8 bits) dequeuing bytes to assemble lines, echoes `ECHO: <line>\r\n` on `\n`, and resets the 127-byte line buffer. `--check` mode verifies the committed fixture has not drifted.
- **Acceptance** (a typed Enter is read by the firmware): a real QEMU e2e injects two lines and both are echoed in the UART output—proving the full stdin → RX FIFO → firmware read → TX loop; the second line's echo also proves the line buffer reset.

## 11. Local Peripheral Catalog (Offline Marketplace, P5.2, PRD §F-EXT-3)

The offline entry point to the peripheral ecosystem: scan a local directory to discover third-party packages, explicitly load them into the Bridge registry, and present them in the UI with zero code.

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

- **Two-process registry**: models only run in the Bridge; the renderer process mirrors metadata stubs (misusing `create()` reports `[BB-207]`); palette/pin anchors/generic node bodies are all driven by metadata, so no UI code needs to be shipped with the package.
- **Avoiding dual instances**: a loose package cannot resolve the host's own `@breadesp/peripherals` instance, so the entry contract is a default-exported function to which the host injects `registerPeripheral` (`PeripheralHostApi`), rather than the package importing it itself.
- **Idempotency and retry**: repeatedly loading the same directory is idempotent (session-level loaded table + inflight deduplication); after fixing a failure you can retry directly—the entry URL carries a process-level attempt ordinal to bypass the ESM module cache. Hot reload/unload is not in the contract (restart to take effect).
- **Security boundary**: scanning is read-only and never fails as a whole error; the load gate requires the target to be an `ok` entry from the current scan, so IPC cannot lure the Bridge into importing arbitrary paths; the manifest entry must resolve inside the package directory (segment-level `..` detection + cross-platform absolute path forms). Executing third-party code is itself the intended extension mechanism, triggered by an explicit user click.

### 11.1 Packaging scaffold (P5.3, PRD §F-EXT-4)

`pnpm create-peripheral <name>` is the starting point for peripheral packages: `PeripheralScaffold` (a shell package, pure-function core + fs write layer) generates a four-file publishable package—a manifest (`sdkVersion` stamped with the host's current `PERIPHERAL_SDK_VERSION`), a host-API injection entry (containing a runnable GPIO level example model), README, and a zero-dependency `self-check.mjs`. Design points:

- **Self-validation**: after producing the manifest it feeds it back through `validatePeripheralManifest` (invariant assertions), and name rules reuse the catalog's `PERIPHERAL_PACKAGE_NAME_RE` directly—the generator and the consumer share one truth, so it cannot generate a package the catalog would reject.
- **Fail early**: a kind conflicting with an already registered kind is rejected at generation time with [BB-230] (otherwise it is bound to hit [BB-221] at load time); a non-empty target directory is rejected with [BB-231] (the scaffold never overwrites existing files), and a mid-write failure cleans up the files it has already created.
- **CLI shape**: a tsx entry inside the shell package (the same pattern as the DAP `debugger/dap/cli.ts`), with `parseScaffoldArgs`/`runScaffoldCli` exported for tests to inject IO; zero changes to the renderer process and the IPC surface, no new runtime dependencies.
