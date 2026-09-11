// PRD: §6.2, §F-BB-3 — SHT30 temperature/humidity sensor model (dev-plan task P3.4).
//
// The SHT30 is an I2C input peripheral (default address 0x44). Firmware writes
// a measurement command; the model computes the 6-byte readout
// [Tmsb, Tlsb, Tcrc, Hmsb, Hlsb, Hcrc] from its props and pushes it upstream via
// ctx.emitInput as an I2cReply frame ({"kind":"i2c-out",...}, P3.4). The
// breadesp-dbus device keeps the reply in a per-(bus, address) mailbox that its
// I2C sniffer serves byte-by-byte to the firmware's master reads, mirroring the
// real sensor's readout register (latest measurement wins).
//
// Timing honesty: the real sensor needs ~4-15ms per measurement and NACKs
// premature reads; this model ACKs always and serves 0xFF while the mailbox is
// empty, so polling firmware should retry until non-0xFF (the golden fixture
// does exactly that). Periodic-measurement mode is not modeled (TODO below).
import type { Peripheral, PeripheralContext, PeripheralFactory, BusTransaction } from './types';

/** Validated SHT30 configuration (props are user-controlled netlist data). */
export interface Sht30Config {
  /** 7-bit I2C address (0x44 with ADDR pin low, 0x45 high). */
  address: number;
  temperatureC: number;
  humidityRh: number;
}

const DEFAULTS = { address: 0x44, temperatureC: 25, humidityRh: 50 };

/** Parameter bounds, exported so UI/tests share one source of truth. */
export const SHT30_LIMITS = {
  address: { min: 0x08, max: 0x77 },
  temperatureC: { min: -40, max: 125 },
  humidityRh: { min: 0, max: 100 },
} as const;

// SHT30 command words (Sensirion datasheet): measurement with/without clock
// stretching at three repeatability levels, plus the housekeeping subset.
const MEASURE_CMDS = new Set([0x2c06, 0x2c0d, 0x2c10, 0x2400, 0x240b, 0x2416]);
const CMD_SOFT_RESET = 0x30a2;
const CMD_HEATER_ON = 0x306d;
const CMD_HEATER_OFF = 0x3066;
const CMD_READ_STATUS = 0xf32d;
const CMD_CLEAR_STATUS = 0x3041;
const CMD_BREAK = 0x3093; // stop periodic acquisition

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Parse netlist props into a validated config (unknown/invalid values fall back). */
export function sht30ConfigFromProps(props?: Record<string, unknown>): Sht30Config {
  const addrRaw = Number(props?.address ?? DEFAULTS.address);
  const address = Number.isInteger(addrRaw) && addrRaw >= SHT30_LIMITS.address.min && addrRaw <= SHT30_LIMITS.address.max
    ? addrRaw
    : DEFAULTS.address;
  return {
    address,
    temperatureC: clampNumber(props?.temperatureC, DEFAULTS.temperatureC, SHT30_LIMITS.temperatureC.min, SHT30_LIMITS.temperatureC.max),
    humidityRh: clampNumber(props?.humidityRh, DEFAULTS.humidityRh, SHT30_LIMITS.humidityRh.min, SHT30_LIMITS.humidityRh.max),
  };
}

/**
 * SHT30 CRC-8 (datasheet §4.12): polynomial 0x31, init 0xFF, no reflection,
 * no final xor. Exported for tests and the golden-fixture builder.
 */
export function sht30Crc8(msb: number, lsb: number): number {
  let crc = 0xff;
  for (const byte of [msb, lsb]) {
    crc ^= byte & 0xff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/**
 * The 6-byte measurement readout for the given config (datasheet §4.13
 * conversion formulas inverted): T[°C] = -45 + 175·raw/65535,
 * RH[%] = 100·raw/65535. Exported for tests and the golden-fixture builder.
 */
export function sht30MeasurementBytes(cfg: Sht30Config): number[] {
  const rawT = Math.round(((cfg.temperatureC + 45) / 175) * 65535);
  const rawH = Math.round((cfg.humidityRh / 100) * 65535);
  const tMsb = (rawT >> 8) & 0xff;
  const tLsb = rawT & 0xff;
  const hMsb = (rawH >> 8) & 0xff;
  const hLsb = rawH & 0xff;
  return [tMsb, tLsb, sht30Crc8(tMsb, tLsb), hMsb, hLsb, sht30Crc8(hMsb, hLsb)];
}

/**
 * The 3-byte status-register readout (datasheet §4.10). Only the heater bit
 * (bit 2) is modeled; the reset value 0x8010 has bit 4 set. Exported for tests.
 */
export function sht30StatusBytes(heaterOn: boolean): number[] {
  const status = 0x8010 | (heaterOn ? 0x0004 : 0);
  const msb = (status >> 8) & 0xff;
  const lsb = status & 0xff;
  return [msb, lsb, sht30Crc8(msb, lsb)];
}

/** One-line human reading for the UI (text snapshot + canvas node). */
export function sht30FormatReading(cfg: Sht30Config): string {
  return `${cfg.temperatureC.toFixed(1)} °C · ${cfg.humidityRh.toFixed(0)} %RH`;
}

class Sht30Peripheral implements Peripheral {
  readonly kind = 'sht30';
  readonly instanceId: string;
  private readonly ctx: PeripheralContext;
  private readonly cfg: Sht30Config;
  private heaterOn = false;
  private warnedNoChannel = false;
  private warnedUnknownCmd = false;

  constructor(instanceId: string, ctx: PeripheralContext, cfg: Sht30Config) {
    this.instanceId = instanceId;
    this.ctx = ctx;
    this.cfg = cfg;
    this.emitReading();
  }

  /** I2C writes addressed at us carry command words; reads are served by the device mailbox. */
  onTransaction(tx: BusTransaction): void {
    if (tx.kind !== 'i2c' || tx.dir !== 'write' || tx.target !== this.cfg.address) return;
    if (tx.data.length < 2) return; // sub-word writes carry no command
    const cmd = (tx.data[0] << 8) | tx.data[1];

    if (MEASURE_CMDS.has(cmd)) {
      this.reply(tx.bus, sht30MeasurementBytes(this.cfg));
      this.emitReading();
      return;
    }
    switch (cmd) {
      case CMD_READ_STATUS:
        this.reply(tx.bus, sht30StatusBytes(this.heaterOn));
        break;
      case CMD_SOFT_RESET:
        this.heaterOn = false;
        break;
      case CMD_HEATER_ON:
        this.heaterOn = true;
        break;
      case CMD_HEATER_OFF:
        this.heaterOn = false;
        break;
      case CMD_CLEAR_STATUS:
      case CMD_BREAK:
        break; // meaningful only in periodic mode, which is not modeled
      default:
        if (!this.warnedUnknownCmd) {
          this.warnedUnknownCmd = true;
          this.ctx.log('warn', `sht30 '${this.instanceId}': unsupported command 0x${cmd.toString(16)} (periodic mode is not modeled)`);
        }
        break;
    }
  }

  /** Push one readout into the device mailbox (atomic replace, latest wins). */
  private reply(bus: number, data: number[]): void {
    if (!this.ctx.emitInput) {
      if (!this.warnedNoChannel) {
        this.warnedNoChannel = true;
        this.ctx.log('warn', `sht30 '${this.instanceId}': no injection channel; read replies dropped`);
      }
      return;
    }
    this.ctx.emitInput({ kind: 'i2c-out', bus, target: this.cfg.address, data });
  }

  /** The canvas node shows the current reading; refresh it on create + measure. */
  private emitReading(): void {
    this.ctx.emitSnapshot({
      instanceId: this.instanceId,
      type: 'text',
      payload: { text: sht30FormatReading(this.cfg) },
    });
  }
}

export const sht30Factory: PeripheralFactory = {
  kind: 'sht30', version: '1.0.0', displayName: 'SHT30 Temp/Humidity',
  pins: [
    { id: 'SDA', role: 'i2c-sda' },
    { id: 'SCL', role: 'i2c-scl' },
    { id: 'VCC', role: 'power', optional: true },
    { id: 'GND', role: 'gnd', optional: true },
  ],
  // Routing matches on the 7-bit address (NetlistResolver i2c rule); the reply
  // returns on the bus the command arrived on (tx.bus).
  defaults: { address: DEFAULTS.address },
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    return new Sht30Peripheral(instanceId, ctx, sht30ConfigFromProps(props));
  },
};
