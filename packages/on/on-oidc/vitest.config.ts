import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'on-oidc',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
  },
})
