import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-simulation-multiuser',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
