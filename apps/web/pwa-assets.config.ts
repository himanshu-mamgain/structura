import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    // Fill the maskable icon's safe-zone padding with the brand color, not white.
    maskable: {
      ...minimal2023Preset.maskable,
      padding: 0.1,
      resizeOptions: { background: '#1e1b4b' },
    },
    apple: {
      ...minimal2023Preset.apple,
      resizeOptions: { background: '#1e1b4b' },
    },
  },
  images: ['public/favicon.svg'],
})
