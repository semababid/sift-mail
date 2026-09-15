import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The API allows requests from this origin only, so the port is fixed.
    port: 5173,
    strictPort: true,
    // In development the client and the API share one origin through this
    // proxy, so the session cookies are first-party and no CORS preflight is
    // involved.
    proxy: {
      '/api': 'http://localhost:4000',
      '/health': 'http://localhost:4000',
    },
  },
  test: {
    environment: 'node',
  },
});
