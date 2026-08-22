import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: 'in-devtools',
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})
