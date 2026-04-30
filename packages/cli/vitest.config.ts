import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'cli',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
