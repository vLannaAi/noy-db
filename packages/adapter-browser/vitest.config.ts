import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'adapter-browser',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
  },
})
