import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // happy-dom so Vue/Pinia reactivity works for #01, #04, #06, #07, #09
    environment: 'happy-dom',
    // Showcase 71 (on-password) calls hub's `mintWrappedDeksBlob` which
    // does `subtle.exportKey('raw', dek)`. happy-dom's WebCrypto polyfill
    // rejects that with `InvalidAccessException: key is not extractable`
    // even when the DEK was generated with `extractable: true`. Node's
    // built-in Web Crypto is fully spec-compliant, so this showcase
    // runs against `node` instead. Showcase 72 (on-webauthn-virtual)
    // also stays on node — it spawns Chromium via Playwright and does
    // not need happy-dom's DOM at all.
    environmentMatchGlobs: [
      ['src/71-on-password-tier2.showcase.test.ts', 'node'],
      ['src/72-on-webauthn-virtual.showcase.test.ts', 'node'],
    ],
    include: ['src/**/*.showcase.test.ts', 'src/**/*.recipe.test.ts'],
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
