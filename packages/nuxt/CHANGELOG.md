# @noy-db/nuxt

## 0.3.0

### Minor Changes

- **Initial release of `@noy-db/nuxt`** — Nuxt 4 module for noy-db (closes #8).

  ```ts
  // nuxt.config.ts
  export default defineNuxtConfig({
    modules: ['@pinia/nuxt', '@noy-db/nuxt'],
    noydb: {
      adapter: 'browser',
      pinia: true,
      devtools: true,
    },
  })
  ```

  **Nuxt 4+ exclusive.** No Nuxt 3 compatibility shim — Nuxt 3 users should consume `@noy-db/vue` and `@noy-db/pinia` directly with a hand-written plugin.

  What ships:

  - `defineNuxtModule` v4 setup with full TypeScript module augmentation of `@nuxt/schema` so the `noydb:` config key is fully typed and autocompleted.
  - Auto-imports for every composable: `useNoydb`, `useCollection`, `useQuery`, `useSync`, `defineNoydbStore`.
  - SSR-safe runtime: the bootstrap plugin is registered with `mode: 'client'`. Server bundle contains zero references to `crypto.subtle`, `decrypt`, or any DEK/KEK symbol — verified in CI by grepping `.output/server/` after `nuxt build`.
  - Optional Pinia plugin installation (`pinia: true`).
  - Devtools tab gated behind `NODE_ENV !== 'production'`.
  - ESM-only output (Node 20+).

  Reference Nuxt 4 demo at `playground/nuxt/` is the integration test for the entire v0.3 adoption story: one config block, two `defineNoydbStore` stores, three pages, no direct `Compartment`/`Collection` calls in any component.
