import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'create-noy-db',
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})
