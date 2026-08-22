import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-ceremony-conformance',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
