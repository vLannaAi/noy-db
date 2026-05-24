import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'at-aws-kms',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
