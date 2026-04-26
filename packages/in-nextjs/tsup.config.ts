import { defineConfig } from 'tsup'
export default defineConfig({
  entry: { index: 'src/index.ts', client: 'src/client.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  external: ['react', 'next/headers', 'next/server'],
})
