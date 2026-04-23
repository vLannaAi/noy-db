import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'store-browser-idb',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['__tests__/setup.ts'],
  },
})
