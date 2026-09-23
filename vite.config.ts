import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverPort = Number(process.env.RADAR_PORT ?? 4747);

export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
