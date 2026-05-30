import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'aws-kms-pdf-attestation',
    environment: 'node',
    include: ['src/**/*.test.ts', 'infra/**/*.test.ts'],
    globals: false,
  },
})
