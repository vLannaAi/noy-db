import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 's3',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
