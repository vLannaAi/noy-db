import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-benchmarks',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
