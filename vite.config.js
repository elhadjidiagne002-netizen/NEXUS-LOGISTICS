import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `--mode api` : version complète (Cloudflare Pages Functions + D1), cf. src/lib/backend.js
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: mode === 'api' ? { 'import.meta.env.VITE_BACKEND': JSON.stringify('api') } : {},
  // PGlite (mode démo) charge son propre WebAssembly : ne pas le pré-empaqueter
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom'], supabase: ['@supabase/supabase-js'], leaflet: ['leaflet'] },
      },
    },
  },
  // version complète en local : `npm run api` (scripts/api-dev.mjs) puis `npm run dev:api`
  server: { port: 5610, strictPort: true, proxy: { '/api': 'http://localhost:8789' } },
  preview: { port: 5610, strictPort: true },
}));
