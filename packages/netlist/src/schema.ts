// PRD: §6.5 — zod schema mirroring src/types.ts.
// AI Agent: when editing types.ts, edit schema.ts in the same change to keep them in sync.
import { z } from 'zod';

export const chipKindSchema = z.enum(['esp32', 'esp32s3', 'esp32c3']);

export const peripheralInstanceSchema = z.object({
  instanceId: z.string().min(1),
  kind: z.string().min(1),
  props: z.record(z.unknown()).optional(),
});

export const wireEndpointSchema = z.object({
  instanceId: z.string().min(1),
  pin: z.string().min(1),
});

export const wireSchema = z.object({
  id: z.string().min(1),
  from: wireEndpointSchema,
  to: wireEndpointSchema,
});

export const netlistSchema = z.object({
  version: z.literal(1),
  chip: chipKindSchema,
  peripherals: z.array(peripheralInstanceSchema),
  wires: z.array(wireSchema),
});

// PRD: §F-BB-4, §F-PROJ-1 — layout.json schema (visual half; mirrors types.ts).
export const layoutItemSchema = z.object({
  instanceId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  kind: z.string().min(1),
});

export const layoutSchema = z.object({
  version: z.literal(1),
  items: z.array(layoutItemSchema),
});
