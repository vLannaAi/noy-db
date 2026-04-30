import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { name: 'in-nextjs', include: ['__tests__/**/*.test.ts'], environment: 'node', testTimeout: 15_000 },
})
