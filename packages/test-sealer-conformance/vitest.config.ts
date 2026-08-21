import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-sealer-conformance',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
