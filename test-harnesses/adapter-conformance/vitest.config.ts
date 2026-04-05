import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-adapter-conformance',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
