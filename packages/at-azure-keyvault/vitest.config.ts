import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'at-azure-keyvault',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
