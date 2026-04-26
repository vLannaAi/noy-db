import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'as-zip',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
    // 15s — the integration tests instantiate Noydb + AES-GCM
    // encryption + BlobSet writes; under parallel CI runs the
    // 5s default trips on first-encrypt warm-up.
    testTimeout: 15_000,
  },
})
