import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.PORT ?? '4000';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as any);
