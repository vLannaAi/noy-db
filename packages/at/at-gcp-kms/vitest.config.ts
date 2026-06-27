import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'at-gcp-kms',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
