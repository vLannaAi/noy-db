# @noy-db/vue

## 1.0.0

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0

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

## 0.5.0

### Initial release

Vue 3 composables for `@noy-db/core` — reactive `useNoydb`, `useCollection`, `useSync`, plus a biometric plugin for WebAuthn unlock. Intended for Vue 3 and Nuxt 4 applications that want `noy-db` as a drop-in reactive store layer.

- `useNoydb()` — returns the injected `Noydb` instance with reactive `isUnlocked` / `isLocked` state.
- `useCollection<T>(compartment, name)` — returns a reactive list of records that re-renders on every `put` / `delete` via the built-in change emitter.
- `useSync(compartment)` — reactive push/pull wrappers with `isSyncing`, `lastPush`, `lastPull`, and `dirtyCount` refs.
- Biometric plugin — WebAuthn enrollment and unlock, with graceful fallback to passphrase on unsupported browsers.

Peer dependencies: `@noy-db/core ^0.5.0`, `vue ^3.0.0`.
