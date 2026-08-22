import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: 'core',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
