// PRD: §6.2, §F-EXT — public surface of @breadesp/peripherals.
export * from './types';
export * from './registry';
export { ledFactory } from './led';
export { buttonFactory } from './button';
export { ssd1306Factory } from './ssd1306';
export { st7789Factory } from './st7789';
export { buzzerFactory } from './buzzer';
export { speakerFactory } from './speaker';
export { oscilloscopeFactory, OscilloscopePeripheral } from './oscilloscope';
export { micFactory, drainResampled, micConfigFromProps, waveformSample, MIC_LIMITS } from './mic';
export type { MicConfig, MicWaveform } from './mic';
export { knobFactory, knobConfigFromProps, quadratureLevels, KNOB_LIMITS } from './knob';
export type { KnobConfig } from './knob';
export {
  sht30Factory, sht30ConfigFromProps, sht30Crc8, sht30MeasurementBytes, sht30StatusBytes, sht30FormatReading, SHT30_LIMITS,
} from './sht30';
export type { Sht30Config } from './sht30';
