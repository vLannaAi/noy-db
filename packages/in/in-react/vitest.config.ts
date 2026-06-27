import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { name: 'in-react', include: ['__tests__/**/*.test.ts?(x)'], environment: 'happy-dom', testTimeout: 15_000 },
})
