import { defineConfig } from 'tsup'
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/adapters/hono.ts',
    'src/adapters/express.ts',
    'src/adapters/fastify.ts',
    'src/adapters/nitro.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  external: ['@noy-db/hub', 'hono', 'express', 'fastify', 'h3'],
})
