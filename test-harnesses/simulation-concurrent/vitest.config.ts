import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-simulation-concurrent',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
