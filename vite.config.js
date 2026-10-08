import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom'], leaflet: ['leaflet'] },
      },
    },
  },
  // en local : `npm run api` (scripts/api-dev.mjs, API sur SQLite) puis `npm run dev`
  server: { port: 5610, strictPort: true, proxy: { '/api': 'http://localhost:8789' } },
  preview: { port: 5610, strictPort: true },
});
