import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-mesh-conformance',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
