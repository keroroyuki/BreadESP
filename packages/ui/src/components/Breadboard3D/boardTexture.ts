// 3D board surface — a procedural breadboard texture (no image assets, so the
// app stays fully offline). It carries the cues the eye needs to read the slab
// as a breadboard rather than a grey rectangle: a hole lattice on the same
// 10-unit pitch the layout snaps to, a sparse major grid for scale, corner
// brackets and a silkscreen mark.
//
// Only the *major* grid is drawn. A fine 10-unit grid lines up exactly with the
// hole centres, and a dot on every grid intersection reads as graph paper — the
// hole field has to stand alone for the surface to look like plastic.
//
// The texture is decorative only. Wiring is pin-to-pin (PRD §F-BB-2); the holes
// are a placement grid, not electrical nodes, which is why they are drawn as
// recesses rather than as metal contacts.
import { CanvasTexture, SRGBColorSpace } from 'three';
import { GRID, GRID_MAJOR } from '../Breadboard/canvasView';
import { WORLD_H, WORLD_W } from '../Breadboard/worldSize';

/** Texture resolution: ~2.1 px per world unit keeps holes crisp when zoomed. */
const TEX_W = 2048;
const TEX_H = Math.round((TEX_W * WORLD_H) / WORLD_W);
const PX_PER_UNIT = TEX_W / WORLD_W;

/** Draws the board surface and returns a GPU texture; caller owns disposal. */
export function createBoardTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return new CanvasTexture(canvas);

  // Base: a faint top-to-bottom falloff reads as a lit surface even before the
  // key light hits it.
  const base = ctx.createLinearGradient(0, 0, 0, TEX_H);
  base.addColorStop(0, '#fbfdff');
  base.addColorStop(0.55, '#f4f8fc');
  base.addColorStop(1, '#e9f0f8');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  const unit = PX_PER_UNIT;

  // Major grid (50) only — scale reference without turning the surface into
  // graph paper (see the header note).
  ctx.strokeStyle = 'rgba(100, 116, 139, 0.2)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = GRID_MAJOR * unit; x < TEX_W; x += GRID_MAJOR * unit) {
    ctx.moveTo(Math.round(x), 0);
    ctx.lineTo(Math.round(x), TEX_H);
  }
  for (let y = GRID_MAJOR * unit; y < TEX_H; y += GRID_MAJOR * unit) {
    ctx.moveTo(0, Math.round(y));
    ctx.lineTo(TEX_W, Math.round(y));
  }
  ctx.stroke();

  // Hole lattice on the layout pitch: the breadboard cue. Each hole is an
  // opening plus a lit inner wall nudged toward the key light, so the field
  // reads as recesses rather than as printed dots. Radius sits above
  // "physically plausible" because the surface is viewed at ~45° and a real
  // 1 mm hole would disappear after mipmapping.
  const step = GRID * unit;
  const radius = Math.max(3, 2.5 * unit);
  const dark = 'rgba(96, 116, 143, 0.5)';
  const lit = 'rgba(255, 255, 255, 0.36)';
  for (let y = step; y < TEX_H; y += step) {
    for (let x = step; x < TEX_W; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = dark;
      ctx.fill();

      // The key light comes from -z (front-top), which on the texture is up, so
      // the far wall of the recess is what catches it.
      ctx.beginPath();
      ctx.arc(x, y - radius * 0.26, radius * 0.46, 0, Math.PI * 2);
      ctx.fillStyle = lit;
      ctx.fill();
    }
  }

  // Inset frame + corner brackets: an engineering-drawing cue that frames the
  // usable area without competing with the parts.
  const inset = 12;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(inset + 0.5, inset + 0.5, TEX_W - inset * 2 - 1, TEX_H - inset * 2 - 1);
  ctx.strokeStyle = 'rgba(100, 116, 139, 0.45)';
  ctx.lineWidth = 2;
  const arm = 28;
  const corners: [number, number, number, number][] = [
    [inset, inset, 1, 1],
    [TEX_W - inset, inset, -1, 1],
    [inset, TEX_H - inset, 1, -1],
    [TEX_W - inset, TEX_H - inset, -1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    ctx.beginPath();
    ctx.moveTo(x + sx * arm, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * arm);
    ctx.stroke();
  }

  // Silkscreen: product mark bottom-right, quiet enough to disappear at a glance.
  ctx.save();
  ctx.translate(TEX_W - 34, TEX_H - 34);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(100, 116, 139, 0.3)';
  ctx.font = '600 26px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('B R E A D E S P', 0, 0);
  ctx.font = '400 13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
  ctx.fillText('V I R T U A L   B R E A D B O A R D', 0, 20);
  ctx.restore();

  // Column ticks along the top edge, so panning has a reference.
  ctx.fillStyle = 'rgba(148, 163, 184, 0.22)';
  for (let x = step; x < TEX_W - step; x += step * 5) {
    ctx.fillRect(x, inset + 8, 2, 10);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
