import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  // Bundle workspace packages, since they ship TypeScript source.
  noExternal: [/^@structura\//],
})
