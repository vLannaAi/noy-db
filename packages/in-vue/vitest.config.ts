import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'vue',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
