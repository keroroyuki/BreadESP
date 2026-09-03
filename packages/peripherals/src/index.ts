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
export { micFactory } from './mic';
