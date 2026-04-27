/**
 * Reference Nuxt 4 demo for noy-db.
 *
 * This config is the integration test for the entire adoption story:
 * if this file type-checks and the demo builds successfully, then
 * `@noy-db/in-nuxt`, `@noy-db/in-pinia`, `@noy-db/in-vue`, `@noy-db/hub`
 * (and the by-* transports it composes with) all wire up correctly
 * against a real Nuxt 4 application.
 *
 * Scope intentionally small: one module, two stores, two collections,
 * five pages including a multi-tab sync demo. The goal is to exercise
 * the integration contract, not to be a full accounting platform.
 */

export default defineNuxtConfig({
  compatibilityDate: '2026-04-06',

  modules: [
    '@pinia/nuxt',
    '@noy-db/in-nuxt',
  ],

  // Configure @noy-db/in-nuxt via the typed `noydb:` key. This is the
  // load-bearing test of the TypeScript module augmentation we added
  // in the module — if it doesn't compile, the augmentation is broken.
  noydb: {
    store: 'to-browser-idb',
    pinia: true,
    devtools: true,
  },

  // Nuxt 4 devtools — useful for dev UX but disabled by default in CI
  // builds via the NODE_ENV guard below.
  devtools: {
    enabled: process.env['NODE_ENV'] !== 'production',
  },

  // Disable telemetry so the CI build doesn't phone home.
  telemetry: false,

  // Strict typing — if the demo passes typecheck against the published
  // @noy-db types, the types are shippable.
  typescript: {
    strict: true,
    typeCheck: false, // Don't block build on type errors — we check separately
  },

  // Quiet the ESM interop warnings from the AWS SDK transitive deps
  // (we only use @noy-db/to-browser-idb here but the workspace pulls them in).
  nitro: {
    preset: 'node-server',
  },

  // Public runtime config — any value here is reachable from the client
  // via `useRuntimeConfig().public`. The OIDC demo page reads these to
  // decide which "Login with X" buttons to render; any provider whose
  // client ID is blank is hidden entirely.
  //
  // Populate via `playground/nuxt/.env` (gitignored). The default empty
  // strings below make the demo work out-of-the-box without requiring
  // any OIDC setup — the page simply shows "no providers configured"
  // until the developer opts in.
  runtimeConfig: {
    public: {
      oidc: {
        googleClientId: '',
        appleClientId: '',
        lineChannelId: '',
        metaClientId: '',
        auth0Domain: '',
        auth0ClientId: '',
        keycloakIssuer: '',
        keycloakClientId: '',
      },
    },
  },
})
