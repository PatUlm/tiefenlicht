import { defineConfig } from 'vite';

const serverPort = Number(process.env.SERVER_PORT ?? 8080);

export default defineConfig({
  // Models and licenses live in the repository-level assets/ folder (concept §8).
  publicDir: '../../assets',
  server: {
    port: 5173,
    // Loopback only; use `pnpm dev -- --host` for LAN play.
    proxy: {
      '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 8000,
  },
});
