# @noy-db/browser

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

Browser storage adapter for `@noy-db/core` — localStorage and IndexedDB with optional key obfuscation. Intended for PWAs, single-page apps, and any browser-side context where the user's data lives in the browser itself.

The adapter auto-detects the available storage backend: IndexedDB for larger data sets and async access, localStorage for small key-value usage and synchronous contexts. Both use the same envelope format produced by the core crypto layer — the adapter never sees plaintext, only ciphertext envelopes. Optional per-key obfuscation adds a SHA-256 hash prefix to every storage key so casual inspection of DevTools doesn't reveal compartment/collection names.

Implements every mandatory method on `NoydbAdapter` (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`) plus the optional `listPage` pagination capability.

Zero runtime dependencies.
