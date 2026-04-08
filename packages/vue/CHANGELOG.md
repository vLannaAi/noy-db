# @noy-db/vue

## 0.5.0

### Initial release

Vue 3 composables for `@noy-db/core` — reactive `useNoydb`, `useCollection`, `useSync`, plus a biometric plugin for WebAuthn unlock. Intended for Vue 3 and Nuxt 4 applications that want `noy-db` as a drop-in reactive store layer.

- `useNoydb()` — returns the injected `Noydb` instance with reactive `isUnlocked` / `isLocked` state.
- `useCollection<T>(compartment, name)` — returns a reactive list of records that re-renders on every `put` / `delete` via the built-in change emitter.
- `useSync(compartment)` — reactive push/pull wrappers with `isSyncing`, `lastPush`, `lastPull`, and `dirtyCount` refs.
- Biometric plugin — WebAuthn enrollment and unlock, with graceful fallback to passphrase on unsupported browsers.

Peer dependencies: `@noy-db/core ^0.5.0`, `vue ^3.0.0`.
