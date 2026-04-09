import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'auth-webauthn',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
  },
})
