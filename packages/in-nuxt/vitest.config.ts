import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: 'nuxt',
    environment: 'node',
    environmentMatchGlobs: [
      ['__tests__/devtools*.test.ts', 'happy-dom'],
      ['__tests__/schema-pane.test.ts', 'happy-dom'],
      ['__tests__/records-mask.test.ts', 'happy-dom'],
    ],
    include: ['__tests__/**/*.test.ts'],
  },
})
