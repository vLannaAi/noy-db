import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/bin.tsx'],
  format: ['esm'],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  banner: { js: '#!/usr/bin/env node' },
})
