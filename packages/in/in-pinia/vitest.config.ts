import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'pinia',
    environment: 'happy-dom',
    include: ['__tests__/**/*.test.ts'],
  },
})
