import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'nuxt',
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})
