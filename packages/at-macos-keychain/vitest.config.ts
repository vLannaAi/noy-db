import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'at-macos-keychain',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
