import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'to-probe',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
    testTimeout: 30_000,
  },
})
