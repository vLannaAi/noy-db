import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-format-conformance',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
