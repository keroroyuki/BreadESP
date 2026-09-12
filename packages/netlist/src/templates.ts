// PRD: §F-PROJ-2, §6.5 — project templates for the new-project wizard
// (dev-plan task P4.2). A template builds the initial netlist.json +
// layout.json halves for a chosen chip; every build MUST pass
// validateNetlist/validateLayout (frozen by tests).
import type { ChipKind, LayoutFile, Netlist } from './types';

/** Static description of one project template (UI lists these). */
export interface ProjectTemplate {
  id: string;
  displayName: string;
  description: string;
  /** Chips this template can build a board for. */
  chips: ChipKind[];
}

/** The two persistence halves a template produces (PRD §F-PROJ-1). */
export interface TemplateProject {
  netlist: Netlist;
  layout: LayoutFile;
}

const ALL_CHIPS: ChipKind[] = ['esp32', 'esp32s3', 'esp32c3', 'esp32c6'];

/** Typical I2C0 default pins per chip (ESP-IDF defaults / common devkits). */
const I2C0_PINS: Record<ChipKind, { sda: string; scl: string }> = {
  esp32: { sda: 'GPIO21', scl: 'GPIO22' },
  esp32s3: { sda: 'GPIO8', scl: 'GPIO9' },
  esp32c3: { sda: 'GPIO8', scl: 'GPIO9' },
  esp32c6: { sda: 'GPIO6', scl: 'GPIO7' },
};

/** GPIO2 exists on every supported chip — the canonical blink pin. */
const BLINK_PIN = 'GPIO2';

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'empty',
    displayName: 'Empty Project',
    description: 'Blank breadboard — add peripherals and wires from scratch.',
    chips: ALL_CHIPS,
  },
  {
    id: 'blink-led',
    displayName: 'Blink LED',
    description: `One LED with its anode wired to ${BLINK_PIN} — the classic first firmware.`,
    chips: ALL_CHIPS,
  },
  {
    id: 'oled-ssd1306',
    displayName: 'SSD1306 OLED (I2C)',
    description: 'One 128x64 OLED wired to the chip\u2019s default I2C0 SDA/SCL pins.',
    chips: ALL_CHIPS,
  },
];

/** List all templates (copies — callers must not mutate the registry). */
export function listTemplates(): ProjectTemplate[] {
  return PROJECT_TEMPLATES.map((t) => ({ ...t, chips: [...t.chips] }));
}

/** Templates usable for a given chip, registry order preserved. */
export function templatesForChip(chip: ChipKind): ProjectTemplate[] {
  return listTemplates().filter((t) => t.chips.includes(chip));
}

/**
 * Build the initial netlist + layout for `templateId` on `chip`.
 * Throws on an unknown template id or a chip the template does not support;
 * the caller (ProjectManager) maps that to a coded error.
 */
export function buildTemplateProject(templateId: string, chip: ChipKind): TemplateProject {
  const template = PROJECT_TEMPLATES.find((t) => t.id === templateId);
  if (template === undefined) {
    throw new Error(`unknown project template: ${templateId}`);
  }
  if (!template.chips.includes(chip)) {
    throw new Error(`project template "${templateId}" does not support chip "${chip}"`);
  }
  switch (templateId) {
    case 'empty':
      return {
        netlist: { version: 1, chip, peripherals: [], wires: [] },
        layout: { version: 1, items: [] },
      };
    case 'blink-led':
      return {
        netlist: {
          version: 1,
          chip,
          peripherals: [{ instanceId: 'led-1', kind: 'led' }],
          wires: [
            { id: 'wire-1', from: { instanceId: 'mcu', pin: BLINK_PIN }, to: { instanceId: 'led-1', pin: 'A' } },
          ],
        },
        layout: { version: 1, items: [{ instanceId: 'led-1', x: 120, y: 60, kind: 'led' }] },
      };
    case 'oled-ssd1306': {
      const pins = I2C0_PINS[chip];
      return {
        netlist: {
          version: 1,
          chip,
          peripherals: [{ instanceId: 'ssd1306-1', kind: 'ssd1306' }],
          wires: [
            { id: 'wire-1', from: { instanceId: 'mcu', pin: pins.sda }, to: { instanceId: 'ssd1306-1', pin: 'SDA' } },
            { id: 'wire-2', from: { instanceId: 'mcu', pin: pins.scl }, to: { instanceId: 'ssd1306-1', pin: 'SCL' } },
          ],
        },
        layout: { version: 1, items: [{ instanceId: 'ssd1306-1', x: 120, y: 60, kind: 'ssd1306' }] },
      };
    }
    default:
      // Unreachable: template lookup above already rejects unknown ids. Guard
      // against a registry entry without a builder branch (internal invariant).
      throw new Error(`project template "${templateId}" has no builder`);
  }
}
