import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'on-shamir',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
