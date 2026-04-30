import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-simulation-filesystem',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
