// PRD: §F-PROJ-2, §6.5 — project template registry (dev-plan task P4.2).
// Acceptance: every template builds a netlist + layout pair that passes
// validateNetlist/validateLayout for every chip it claims to support.
import { describe, expect, it } from 'vitest';
import {
  buildTemplateProject,
  listTemplates,
  PROJECT_TEMPLATES,
  templatesForChip,
  validateLayout,
  validateNetlist,
} from '../src/index';
import type { ChipKind } from '../src/index';

const ALL_CHIPS: ChipKind[] = ['esp32', 'esp32s3', 'esp32c3', 'esp32c6'];

describe('project templates (P4.2)', () => {
  it('registry exposes the empty, blink-led and oled-ssd1306 templates in order', () => {
    expect(PROJECT_TEMPLATES.map((t) => t.id)).toEqual(['empty', 'blink-led', 'oled-ssd1306']);
    for (const t of PROJECT_TEMPLATES) {
      expect(t.displayName.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.chips.length).toBeGreaterThan(0);
    }
  });

  it('every template builds a valid netlist + layout for every supported chip', () => {
    for (const template of PROJECT_TEMPLATES) {
      for (const chip of template.chips) {
        const { netlist, layout } = buildTemplateProject(template.id, chip);
        expect(validateNetlist(netlist).ok, `${template.id}/${chip} netlist`).toBe(true);
        expect(validateLayout(layout).ok, `${template.id}/${chip} layout`).toBe(true);
        expect(netlist.chip).toBe(chip);
        // The two halves reference exactly the same instance set.
        expect(layout.items.map((i) => i.instanceId).sort()).toEqual(
          netlist.peripherals.map((p) => p.instanceId).sort(),
        );
      }
    }
  });

  it('empty template builds a blank board carrying only the chip', () => {
    const { netlist, layout } = buildTemplateProject('empty', 'esp32c6');
    expect(netlist).toEqual({ version: 1, chip: 'esp32c6', peripherals: [], wires: [] });
    expect(layout).toEqual({ version: 1, items: [] });
  });

  it('blink-led wires the LED anode to GPIO2 on every chip', () => {
    for (const chip of ALL_CHIPS) {
      const { netlist } = buildTemplateProject('blink-led', chip);
      expect(netlist.peripherals).toEqual([{ instanceId: 'led-1', kind: 'led' }]);
      expect(netlist.wires).toEqual([
        { id: 'wire-1', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'led-1', pin: 'A' } },
      ]);
    }
  });

  it('oled-ssd1306 wires SDA/SCL to the per-chip default I2C0 pins', () => {
    const expected: Record<ChipKind, [string, string]> = {
      esp32: ['GPIO21', 'GPIO22'],
      esp32s3: ['GPIO8', 'GPIO9'],
      esp32c3: ['GPIO8', 'GPIO9'],
      esp32c6: ['GPIO6', 'GPIO7'],
    };
    for (const chip of ALL_CHIPS) {
      const { netlist } = buildTemplateProject('oled-ssd1306', chip);
      const pins = netlist.wires.map((w) => `${w.from.pin}->${w.to.pin}`).sort();
      expect(pins).toEqual([
        `${expected[chip][0]}->SDA`,
        `${expected[chip][1]}->SCL`,
      ]);
    }
  });

  it('rejects an unknown template id', () => {
    expect(() => buildTemplateProject('nope', 'esp32')).toThrow('unknown project template: nope');
  });

  it('rejects a chip the template does not support', () => {
    // Boundary case: an out-of-contract chip string must fail the template
    // guard even for the all-chips 'empty' template.
    expect(() => buildTemplateProject('empty', 'esp32h2' as ChipKind)).toThrow(
      'project template "empty" does not support chip "esp32h2"',
    );
  });

  it('listTemplates returns defensive copies (registry stays immutable)', () => {
    const list = listTemplates();
    list[0].chips.length = 0;
    expect(PROJECT_TEMPLATES[0].chips.length).toBeGreaterThan(0);
  });

  it('templatesForChip filters by chip support and preserves registry order', () => {
    for (const chip of ALL_CHIPS) {
      const ids = templatesForChip(chip).map((t) => t.id);
      const expected = PROJECT_TEMPLATES.filter((t) => t.chips.includes(chip)).map((t) => t.id);
      expect(ids).toEqual(expected);
    }
    expect(templatesForChip('esp32h2' as ChipKind)).toEqual([]);
  });
});
