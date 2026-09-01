import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-enclave-conformance',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
