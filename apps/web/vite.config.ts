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
        description: 'Learn system design in 3D: voice assistant, live load testing and guided walkthroughs.',
        theme_color: '#1e1b4b',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
      },
      workbox: {
        // Headroom for large chunks (the ELK layout engine is ~1.4 MB, three.js ~0.7 MB),
        // so everything is precached and diagrams work offline.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // wasm: the load simulator, so load tests work offline too.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,wasm}'],
        // API calls always go to the network; never answer them with the app shell.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  // host: true also listens on the local network, so phones and laptops on the same
  // Wi-Fi can open http://<this-PC's-IP>:5173.
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
  },
})
