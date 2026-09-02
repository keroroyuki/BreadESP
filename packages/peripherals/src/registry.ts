// PRD: §6.2, §F-EXT — Peripheral registry. Maps factory.kind -> factory.
import type { PeripheralFactory } from './types';
import { ledFactory } from './led';
import { buttonFactory } from './button';
import { ssd1306Factory } from './ssd1306';
import { st7789Factory } from './st7789';
import { buzzerFactory } from './buzzer';
import { speakerFactory } from './speaker';

const factories = new Map<string, PeripheralFactory>();

export function registerPeripheral(factory: PeripheralFactory): void {
  if (factories.has(factory.kind)) {
    throw new Error(`Peripheral kind already registered: ${factory.kind}`);
  }
  factories.set(factory.kind, factory);
}

export function getFactory(kind: string): PeripheralFactory | undefined {
  return factories.get(kind);
}

export function listPeripherals(): PeripheralFactory[] {
  return [...factories.values()];
}

/** Register all built-in peripherals. Called once at Bridge startup. */
export function registerBuiltins(): void {
  // PRD §8 MVP set: led, button, ssd1306; st7789 lands with P2.1, buzzer with P2.3, speaker with P2.4.
  for (const f of [ledFactory, buttonFactory, ssd1306Factory, st7789Factory, buzzerFactory, speakerFactory]) registerPeripheral(f);
}
