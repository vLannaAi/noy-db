import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'in-devtools-tui', environment: 'node', include: ['__tests__/**/*.test.{ts,tsx}'] },
})
