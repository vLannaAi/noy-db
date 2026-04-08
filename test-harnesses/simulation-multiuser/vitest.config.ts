import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-simulation-multiuser',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
