import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
  define: {
    // Release tag from bin/release.sh (Docker build arg), shown in the lobby and menu.
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? 'dev'),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 8000,
  },
  plugins: [
    // Installable app (tablet home screen, fullscreen without browser bars). Playing needs
    // the server anyway, so offline only the shell matters.
    VitePWA({
      registerType: 'autoUpdate',
      // Registered from src/pwa/update.ts, which reloads into new versions only outside a game.
      injectRegister: false,
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Tiefenlicht',
        short_name: 'Tiefenlicht',
        description: 'Rundenbasiertes 3D-Dungeon-Brettspiel für zwei Spieler im Browser.',
        lang: 'de',
        start_url: '/',
        scope: '/',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'any',
        background_color: '#120c22',
        theme_color: '#120c22',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // autoUpdate sets these only with injectRegister 'auto'; without them a new
        // version would wait until every tab is closed.
        skipWaiting: true,
        clientsClaim: true,
        // Precache the shell only (icons come via includeAssets and the manifest);
        // models and textures (27 MB) are cached on first use.
        globPatterns: ['**/*.{js,css,html,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // WebSocket and health check always go to the server.
        navigateFallbackDenylist: [/^\/ws/, /^\/healthz/],
        runtimeCaching: [
          {
            // File names are stable (no hash): a replaced model needs a new name or a new cache name.
            urlPattern: ({ url }) => /^\/(models|textures)\//.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'tiefenlicht-models', cacheableResponse: { statuses: [200] } },
          },
        ],
      },
    }),
  ],
});
