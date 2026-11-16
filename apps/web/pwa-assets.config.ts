import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    // Pad the maskable and Apple icons with the tile's own colour (favicon.svg), so they are
    // one full-bleed green square: Android and iOS cut their own shape out of it.
    maskable: {
      ...minimal2023Preset.maskable,
      padding: 0.1,
      resizeOptions: { background: '#4e7268' },
    },
    apple: {
      ...minimal2023Preset.apple,
      padding: 0.1,
      resizeOptions: { background: '#4e7268' },
    },
  },
  images: ['public/favicon.svg'],
})
