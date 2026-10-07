import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
  server: { port: 5610, strictPort: true },
  preview: { port: 5610, strictPort: true },
});
