import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'as-json',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
    testTimeout: 15_000,
  },
})
