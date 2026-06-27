import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'at-env',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
