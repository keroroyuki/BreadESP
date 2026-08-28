import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Electron renderer build. In dev the shell loads from VITE_DEV_SERVER_URL (PRD §4 main.ts).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
