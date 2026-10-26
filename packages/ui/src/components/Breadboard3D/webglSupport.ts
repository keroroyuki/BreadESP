// 3D view (step 1): capability probe. A desktop app must never leave the user
// with a blank centre column, so the host checks for a WebGL context before it
// mounts the 3D canvas and falls back to an explanatory card when the renderer
// cannot run here (blocked GPU, hardened driver, no GPU process).

export type WebGLVersion = 'webgl2' | 'webgl';

/**
 * Cached capability result. Probing allocates a throwaway context, and the mode
 * toggle can remount the 3D canvas many times in one session — browsers cap the
 * number of live contexts, so the probe must run at most once per page.
 */
let cached: WebGLVersion | null | undefined;

/** The strongest WebGL flavour available here, or null when 3D cannot render. */
export function detectWebGL(): WebGLVersion | null {
  if (cached !== undefined) return cached;
  try {
    const canvas = document.createElement('canvas');
    if (canvas.getContext('webgl2') !== null) {
      cached = 'webgl2';
      return cached;
    }
    if (canvas.getContext('webgl') !== null) {
      cached = 'webgl';
      return cached;
    }
  } catch {
    // A throwing getContext means no usable context — treat as unsupported.
  }
  cached = null;
  return cached;
}

/**
 * Unmasked GPU description for the performance badge — this is what tells a
 * hardware renderer apart from a software fallback (SwiftShader), which is the
 * difference between smooth orbiting and a slideshow. Engines hide the string
 * unless the debug extension is present, hence the 'unknown' fallback.
 */
export function describeRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg === null) return 'unknown';
  const name: unknown = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  return typeof name === 'string' && name.length > 0 ? name : 'unknown';
}
