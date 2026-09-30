import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Electron renderer build. In dev the shell loads from VITE_DEV_SERVER_URL (PRD §4 main.ts).
// Aliases pin @breadesp/* imports to workspace source: the package "main"
// fields point at compiled dist/ for the Node/Electron runtime, while the
// renderer bundles src directly (PRD §10 source-first rule; no stale dist).
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@breadesp/netlist': fileURLToPath(new URL('../netlist/src/index.ts', import.meta.url)),
      '@breadesp/peripherals': fileURLToPath(new URL('../peripherals/src/index.ts', import.meta.url)),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
