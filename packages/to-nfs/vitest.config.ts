import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { name: 'to-nfs', include: ['__tests__/**/*.test.ts'], environment: 'node', testTimeout: 15_000 },
})
