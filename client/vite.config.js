import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output (dist/) is served by the Express server, which gates every page by role + group
// before returning index.html. `npm run dev` proxies API calls to the Express server on :3000.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    modulePreload: { polyfill: false }, // keeps the build free of inline scripts (strict CSP)
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
    },
  },
});
