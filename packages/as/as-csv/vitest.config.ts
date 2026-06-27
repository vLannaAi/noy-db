import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'as-csv',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
  },
})
