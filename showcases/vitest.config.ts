import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // happy-dom so Vue/Pinia reactivity works for #01, #04, #06, #07, #09
    environment: 'happy-dom',
    include: ['src/**/*.showcase.test.ts'],
    testTimeout: 30_000,
    // happy-dom's WebCrypto implementation is occasionally flaky on
    // the on-oidc split-key path (showcase #12) — documented in
    // HANDOVER. Retries handle the transient failure without masking
    // real bugs: vitest re-runs only on thrown errors, not on failed
    // assertions. Two retries matches Node's own recommendation for
    // crypto-intensive CI tests sharing CPU.
    retry: 2,
    globals: false,
    reporters: ['verbose'],
    // Runs once per worker before any test module loads. Reads showcases/.env
    // and promotes NOYDB_SHOWCASE_AWS_PROFILE into AWS_PROFILE so the AWS
    // SDK's default chain picks up creds + region for cloud showcases.
    // Cloud showcases (#10, #11) gate themselves via describe.skipIf() —
    // no global skip here.
    setupFiles: ['src/_setup.ts'],
  },
})
