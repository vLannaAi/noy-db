import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: 'test-mesh-conformance',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
