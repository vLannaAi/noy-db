import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'memory',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
