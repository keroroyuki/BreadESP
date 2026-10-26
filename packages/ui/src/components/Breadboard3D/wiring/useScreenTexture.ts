// Live framebuffer texture for 3D screens (step 3).
//
// It reuses the 2D screen renderers, so the glass on the 3D part shows exactly the
// same pixels the dock's ScreenView shows — one renderer, two surfaces. The canvas
// is upscaled with nearest filtering so the pixels stay crisp instead of turning
// into a blur, which is what a real 128×64 OLED looks like.
import { useEffect, useMemo } from 'react';
import { CanvasTexture, NearestFilter, SRGBColorSpace } from 'three';
import type { RenderSnapshot } from '@breadesp/peripherals';
import { useSimulationStore } from '../../../store/simulationStore';
import { OledRenderer } from '../../ScreenView/OledRenderer';
import { TftRenderer } from '../../ScreenView/TftRenderer';

interface PixelsPayload {
  width: number;
  height: number;
  format: 'mono' | 'rgb565' | 'argb8888';
  buffer: number[];
}

function pixelsOf(snap: RenderSnapshot | undefined): PixelsPayload | null {
  if (snap === undefined || snap.type !== 'pixels') return null;
  return snap.payload as PixelsPayload;
}

/**
 * Texture of a screen instance's latest framebuffer, or null when `enabled` is
 * false (non-screen parts) or nothing has been drawn yet. Hooks stay unconditional
 * — the canvas is only allocated for screen kinds.
 */
export function useScreenTexture(instanceId: string, enabled: boolean): CanvasTexture | null {
  const snap = useSimulationStore((s) => s.snapshots[instanceId]);

  const canvas = useMemo(() => {
    if (!enabled || typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 64;
    const ctx = c.getContext('2d');
    if (ctx !== null) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    return c;
  }, [enabled]);

  const texture = useMemo(() => {
    if (canvas === null) return null;
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    return t;
  }, [canvas]);

  useEffect(() => {
    if (texture === null) return;
    return () => texture.dispose();
  }, [texture]);

  useEffect(() => {
    if (canvas === null || texture === null) return;
    const p = pixelsOf(snap);
    if (p === null) return;
    if (p.format === 'argb8888') return; // no model emits it yet (same as ScreenView)
    if (canvas.width !== p.width || canvas.height !== p.height) {
      canvas.width = p.width;
      canvas.height = p.height;
    }
    if (p.format === 'mono') {
      OledRenderer.renderMono(canvas, p.width, p.height, new Uint8Array(p.buffer));
    } else {
      TftRenderer.renderRgb565(canvas, p.width, p.height, p.buffer);
    }
    texture.needsUpdate = true;
  }, [snap, canvas, texture]);

  return texture;
}
