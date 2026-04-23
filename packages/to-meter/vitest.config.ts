import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'to-meter',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
  },
})
