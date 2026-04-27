import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'by-tabs',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
    testTimeout: 15_000,
  },
})
