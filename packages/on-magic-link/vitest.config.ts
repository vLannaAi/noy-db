import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'on-magic-link',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
  },
})
