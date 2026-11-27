import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const api = process.env.SCENORYA_API ?? 'http://localhost:3000';

export default defineConfig({
  resolve: {
    alias: { '@scenorya/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/realtime': { target: api, ws: true },
      '/api': api,
      '/branding': api,
    },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.ico', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Scenorya — Gestion associative, culturelle et événementielle',
        short_name: 'Scenorya',
        description: 'De la gestion aux applaudissements. Une application de TiceConnect.',
        lang: 'fr',
        start_url: '/hub',
        scope: '/',
        display: 'standalone',
        background_color: '#F6F8FC',
        theme_color: '#102540',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // L'API et les fichiers privés ne sont jamais mis en cache par le service worker.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/branding\//],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          { urlPattern: /^\/branding\//, handler: 'CacheFirst', options: { cacheName: 'scenorya-branding', expiration: { maxEntries: 200 } } },
        ],
      },
    }),
  ],
});
