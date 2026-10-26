import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Electron renderer build. In dev the shell loads from VITE_DEV_SERVER_URL (PRD §4 main.ts).
// Aliases pin @breadesp/* imports to workspace source: the package "main"
// fields point at compiled dist/ for the Node/Electron runtime, while the
// renderer bundles src directly (PRD §10 source-first rule; no stale dist).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    alias: {
      '@breadesp/netlist': fileURLToPath(new URL('../netlist/src/index.ts', import.meta.url)),
      '@breadesp/peripherals': fileURLToPath(new URL('../peripherals/src/index.ts', import.meta.url)),
    },
  },
  // The 3D view is a lazy chunk (three.js + drei, ~1 MB minified) that only a 3D
  // session downloads; the 2D editor's initial bundle stays small. The default
  // 500 kB warning would fire on that chunk on every build, so the limit is raised
  // to just above it instead of splitting the renderer library itself.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1400 },
  server: { port: 5173, strictPort: true },
});
