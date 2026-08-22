import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'

export default defineConfig({
  test: {
    name: 'as-xlsx',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
    testTimeout: TEST_TIMEOUT_MS,
  },
})
