# @noy-db/nuxt

## 1.0.0

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0
  - @noy-db/pinia@1.0.0
  - @noy-db/vue@1.0.0

## 0.6.0

### Patch Changes

- Updated dependencies [755f151]
- Updated dependencies [92f2000]
- Updated dependencies [36dbdbc]
- Updated dependencies [f968f83]
- Updated dependencies [bd21ad7]
- Updated dependencies [d90098a]
- Updated dependencies [958082b]
- Updated dependencies [f65908a]
  - @noy-db/core@0.6.0
  - @noy-db/pinia@1.0.0
  - @noy-db/vue@1.0.0

## 0.5.0

### Initial release

Nuxt 4 module for `@noy-db/core` — auto-imports, SSR-safe runtime plugin, and the `@noy-db/pinia` bridge. Intended for Nuxt 4 applications that want `noy-db` as a zero-config drop-in encrypted data layer.

Add `@noy-db/nuxt` to the `modules` array in `nuxt.config.ts` and the module wires up:

- **Auto-imports** for `useNoydb`, `useCollection`, `useSync`, `defineNoydbStore` — available in any `app/` file without an import statement.
- **SSR-safe runtime plugin** that creates a shared `Noydb` instance in the Nuxt app context. Encrypted state stays client-side only by default; server-side rendering uses an empty plaintext stub.
- **DevTools integration** — a `noy-db` devtools tab shows compartment state, keyring user list, collection contents, and ledger head info during development.
- **Pinia bridge** — when `@pinia/nuxt` is also installed, the module registers the `createNoydbPiniaPlugin` automatically so every `defineStore` can transparently opt in to `noy-db` persistence.

Config options: `adapter: 'browser' | 'file' | 'memory'`, `pinia: boolean`, `devtools: boolean`.

Peer dependencies: `@noy-db/core ^0.5.0`, `@noy-db/pinia ^0.5.0`, `@noy-db/vue ^0.5.0`, `nuxt ^4.0.0`.
