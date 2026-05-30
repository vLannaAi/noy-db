import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'aws-kms-pdf-attestation',
    environment: 'node',
    include: ['src/**/*.test.ts', 'infra/**/*.test.ts'],
    globals: false,
    // CDK Template.fromStack bundles the S3-autodelete custom resource via
    // esbuild on first synth (~15s cold), well past vitest's 5s default.
    testTimeout: 60_000,
  },
})
