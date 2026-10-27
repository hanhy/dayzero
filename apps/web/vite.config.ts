import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5188,
    strictPort: true,
    proxy: { '/api': process.env.DAYZERO_API_URL ?? 'http://127.0.0.1:3188' },
  },
  build: { chunkSizeWarningLimit: 1200 },
});
