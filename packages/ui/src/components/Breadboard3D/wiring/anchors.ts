// Shared endpoint resolution for 3D wiring (step 4): a netlist endpoint becomes
// the world-space point a wire must touch. Both the wire renderer and the pending
// rubber band use it, so a wire can never start or end somewhere the other one
// would not.
import { MCU_INSTANCE_ID, type LayoutItem, type WireEndpoint } from '@breadesp/netlist';
import { NODE_H, NODE_W } from '../../Breadboard/pinLayout';
import { mcuPinAnchor, partPinAnchors } from './pinRows3d';

export type Vec3 = [number, number, number];

export function endpointAnchor(ep: WireEndpoint, layout: LayoutItem[]): Vec3 | null {
  if (ep.instanceId === MCU_INSTANCE_ID) return mcuPinAnchor(ep.pin);
  const item = layout.find((it) => it.instanceId === ep.instanceId);
  if (item === undefined) return null;
  const anchors = partPinAnchors(item.kind, item.x + NODE_W / 2, item.y + NODE_H / 2);
  return anchors.find((a) => a.pin === ep.pin)?.position ?? null;
}
