import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'in-devtools',
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})
