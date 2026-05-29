import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'attestation-verifier',
    environment: 'node',
    include: ['src/**/*.test.ts', 'build.test.ts'],
    globals: false,
  },
})
