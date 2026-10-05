import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Icons are generated from public/favicon.svg by pwa-assets.config.ts.
      pwaAssets: { config: true, overrideManifestIcons: true },
      manifest: {
        name: 'Structura',
        short_name: 'Structura',
        description: 'Design canvas with a voice assistant that helps fix your designs.',
        theme_color: '#1e1b4b',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
      },
      workbox: {
        // tldraw makes the main bundle ~2 MB, above Workbox's default 2 MiB precache limit.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // API calls always go to the network; never answer them with the app shell.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // tldraw loads its fonts, icons and translations from this CDN.
            urlPattern: ({ url }) => url.origin === 'https://cdn.tldraw.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'tldraw-assets',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
  },
  preview: {
    proxy: { '/api': 'http://localhost:3001' },
  },
})
