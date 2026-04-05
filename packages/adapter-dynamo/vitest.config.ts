import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'adapter-dynamo',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
