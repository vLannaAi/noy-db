import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-simulation-sync',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
