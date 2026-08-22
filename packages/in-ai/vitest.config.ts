import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'
export default defineConfig({
  test: { name: 'in-ai', include: ['__tests__/**/*.test.ts'], environment: 'node', testTimeout: TEST_TIMEOUT_MS },
})
