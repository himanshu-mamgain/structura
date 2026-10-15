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
        id: '/',
        name: 'Structura: system design, visualised',
        short_name: 'Structura',
        description:
          'Learn system design by seeing it work: interactive architecture diagrams, step-by-step walkthroughs, a 3D load lab, narrated videos, quizzes and progress tracking. Works offline.',
        categories: ['education', 'developer', 'productivity'],
        theme_color: '#0a0e1a',
        background_color: '#0a0e1a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        shortcuts: [
          { name: 'Quiz', short_name: 'Quiz', url: '/?page=quiz', description: 'Test yourself on the fundamentals' },
          { name: 'Glossary', short_name: 'Glossary', url: '/?page=glossary', description: 'System design terms' },
          { name: 'URL Shortener', short_name: 'URL Shortener', url: '/?topic=url-shortener' },
        ],
        // Shown on Android's install sheet and in app stores (captured from the running app at 390x844 and 1536x960).
        screenshots: [
          { src: '/screenshots/phone-home.png', sizes: '780x1688', type: 'image/png', form_factor: 'narrow', label: 'Home: continue learning and videos' },
          { src: '/screenshots/phone-topic.png', sizes: '780x1688', type: 'image/png', form_factor: 'narrow', label: 'An interactive topic' },
          { src: '/screenshots/wide-topic.png', sizes: '1536x960', type: 'image/png', form_factor: 'wide', label: 'Topic dashboard with diagram and video' },
        ],
      },
      workbox: {
        // Headroom for large chunks (the ELK layout engine is ~1.4 MB, three.js ~0.7 MB),
        // so everything is precached and diagrams work offline.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // wasm: the load simulator, so load tests work offline too.
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,ico,woff2,wasm,txt}'],
        // Store screenshots are for the install sheet, not the app; videos are saved on request.
        globIgnores: ['screenshots/**', 'videos/*.mp4'],
        runtimeCaching: [
          {
            // Videos the learner saved for offline (see OfflineVideo.tsx) play from the
            // cache, seeking included; others stream from the network as usual.
            urlPattern: ({ url }) => url.pathname.startsWith('/videos/') && url.pathname.endsWith('.mp4'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'structura-videos',
              rangeRequests: true,
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
        // Files under /licenses and /videos are real files, not app routes.
        navigateFallbackDenylist: [/^\/licenses\//, /^\/videos\//],
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
