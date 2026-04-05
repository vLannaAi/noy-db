import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-simulation-offline-online',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
