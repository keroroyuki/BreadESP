---
title: 04 · Built-in Peripherals Reference
description: An overview of the pins, props, routing, and snapshot shapes of all built-in peripherals.
---

# 04 · Built-in Peripherals Reference

> Built-in peripherals are registered by `@breadesp/peripherals` (`registerBuiltins()`); Palette entries,
> canvas pins, and Bridge routing are all driven by the factory's `pins`/`defaults` metadata. To author your own peripheral, see
> [05 · Authoring Peripherals](05-authoring-peripherals.md) and the [Peripheral SDK Guide](../peripheral-sdk.md).

## Routing quick reference

| Bus | Routing basis | Notes |
|---|---|---|
| GPIO / PWM | Wiring: peripheral pin ↔ `mcu.GPIO<n>` | Multiple peripherals can be attached to the same pin (all of them receive the transaction) |
| I2C | 7-bit address: `props.address`, falling back to `factory.defaults.address` by default | The `bus` field does not participate in matching |
| SPI | CS line index 0–2: claimed by `props.cs` | The factory pin table must contain the `spi-cs` role to participate in matching |
| I2S | Controller number: claimed by `props.bus` (0/1) | The factory must contain the `i2s-data-in`/`i2s-data-out` roles |

## Output peripherals

### LED (`led`)

- Pins: `A` (gpio-out anode), `K` (gnd, optional).
- Behavior: on receiving a GPIO write transaction it updates the brightness and emits a `level` snapshot (0..1); the canvas node lights up in real time.
- Demo firmware: `blink.elf` (GPIO2 toggling).

### SSD1306 OLED (`ssd1306`)

- Pins: `SDA`/`SCL` (+ optional `VCC`/`GND`); prop `address` (default `0x3C`).
- Behavior: interprets the I2C command stream per the datasheet (page/horizontal/vertical addressing, window, inversion, orientation),
  maintains a 128×64 mono VRAM, and the `pixels` snapshot is rendered by ScreenView. Covers the common Adafruit_GFX
  `begin()`+`display()` path.
- Demo firmware: `i2c.elf`.

### ST7789 TFT (`st7789`)

- Pins: `SCK`/`MOSI`/`CS` (SPI), `DC` (gpio-in, command/data select; it must be wired and the same GPIO number
  declared in `props.dc`), `MISO`/`RST`/`BL` optional; prop `cs` (default `0`).
- Behavior: interprets the SPI command stream (CASET/RASET window, MADCTL rotation, RGB/BGR, inversion, sleep),
  maintains a 240×240 RGB565 framebuffer, and the `pixels` snapshot goes into ScreenView.
- Demo firmware: `spi.elf`.

### Buzzer (`buzzer`)

- Pins: `+` (pwm-in), `-` (gnd optional).
- Behavior: consumes PWM transactions (frequency/duty cycle, LEDC shadow decoding) or measures frequency from bit-bang edges, and emits a
  `tone` snapshot; the UI synthesizes a square wave with WebAudio, and it makes sound when `freqHz>0 且 duty>0`.
- Demo firmware: `buzzer.elf` (440Hz → 880Hz).

### Speaker (`speaker`)

- Pins: `DIN` (i2s-data-in), `WS`, `BCK`; prop `bus` (default `0`).
- Behavior: decodes the PCM forwarded by I2S TX DMA (8/16/24/32-bit, mono/multi-channel downmixed to mono), and emits an
  `audio` snapshot (streamed, not subject to 30fps merging); the UI plays it seamlessly at the sampling rate.
- Demo firmware: `speaker.elf` (sine wave).

## Input peripherals

### Push button (`button`)

- Pins: `1` (gpio-in), `2` (gnd optional).
- Behavior: pressing/releasing on the canvas injects a GPIO level through `per:driveInput` (the `gpio-in` reverse frames are merged into
  the GPIO_IN shadow read value); GPIO edge interrupts are not modeled, so firmware reads it by polling.

### Microphone (`mic`)

- Pins: `DOUT` (i2s-data-out), `WS`, `BCK`; props: `waveform`
  (`sine`/`square`/`noise`/`silence`), `freqHz`, `amplitude`, `sampleRate`,
  `bits`, `channels`, `bus` (default `0`), `chunkMs`.
- Behavior: synthesizes PCM from the props and injects it into the firmware's I2S RX DMA ring buffer; the **WaveGen panel** at the bottom
  lets you edit the waveform visually (editing changes the netlist props, which are persisted with the project); the **REC switch** on the canvas node
  toggles real host microphone capture (overriding the synth at runtime, not written to the netlist).
- Demo firmware: `mic.elf`.

### Rotary knob (`knob`)

- Pins: `A`/`B` (gpio-in, quadrature), `SW` (push switch, optional), `GND`; prop `stepMs`
  (the playback step length of each detent).
- Behavior: the CCW/CW buttons on the canvas node queue the quadrature phase sequence through `per:rotateKnob` (1 detent = 4
  phase transitions of a Gray ring), injecting pin by pin; SW reuses the push-button injection channel.
- Demo firmware: `knob.elf` (quadrature counting prints `KNOB CW`).

### Temperature and humidity sensor (`sht30`)

- Pins: `SDA`/`SCL`; props `address` (default `0x44`), `temperatureC`, `humidityRh`.
- Behavior: answers six measurement command words (read responses are supplied via the `i2c-out` mailbox, so firmware needs to retry to converge),
  the status register (heater bit), and soft reset; the `text` snapshot shows the current reading, and the
  T±1°C / H±5%RH buttons on the canvas node change the props directly.
- Demo firmware: `sht.elf` (prints `SHT OK` after reading 25°C/50%RH).

## Observation peripherals

### Oscilloscope (`oscilloscope`)

- Pins: `CH1`–`CH4` (probe role, PRD §6.1), `GND`; props `windowMs`
  (rolling window, default 200ms), `maxEdges`.
- Behavior: wiring CHx to any `mcu.GPIO<n>` captures that pin's level/PWM timing — real GPIO
  toggles are recorded as edges on the virtual clock; LEDC-driven pins synthesize the in-window edges from the steady state of (frequency, duty cycle)
  (equivalent to a real oscilloscope's triggered view). The `waveform` snapshot is drawn as multi-channel step traces by the oscilloscope panel at the bottom.

## 30fps snapshot throttling

All `emitSnapshot` calls go through a `(instanceId, type)` throttle gate: the first frame in a quiet period is emitted immediately, updates within the window are
merged last-write-wins, and a trailing flush follows — the UI always converges to the latest state and is not dragged down by high-frequency transactions
(PRD §9). Exception: the `audio` snapshot is a stream rather than a restatable state, so it bypasses merging and is delivered chunk by chunk.
