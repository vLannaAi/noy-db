# @noy-db/pinia

## 0.5.0

### Initial release

Pinia integration for `@noy-db/core` — `defineNoydbStore()` and the augmentation plugin for existing Pinia stores. Intended for Vue 3 and Nuxt 4 applications that use Pinia as their state-management layer and want `noy-db` to transparently persist that state with encryption.

**`defineNoydbStore<T>(name, options)`** creates a Pinia store whose state is automatically synced with a `@noy-db/core` collection. Accepts the same Standard Schema v1 validator as the underlying `Collection` so every read/write is typed and validated end-to-end. Supports eager and lazy hydration modes, index declarations, and reactive `useCollection`-like subscriptions.

**`createNoydbPiniaPlugin()`** is an augmentation plugin for existing Pinia stores that weren't originally declared with `defineNoydbStore`. The plugin wraps their state with the same `noy-db` persistence without requiring a rewrite — useful for adopting `noy-db` incrementally in an existing Vue app.

Peer dependencies: `@noy-db/core ^0.5.0`, `pinia ^2.1.0 || ^3.0.0`, `vue ^3.4.0`.
