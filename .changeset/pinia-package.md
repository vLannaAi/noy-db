---
"@noy-db/pinia": minor
---

Initial release of `@noy-db/pinia` — Pinia integration for noy-db.

Exports `defineNoydbStore<T>(id, options)`, a drop-in replacement for `defineStore` that wires a Pinia store to a NOYDB compartment + collection. The store exposes `items`, `count`, `byId`, `add`, `update`, `remove`, `refresh`, `query`, and `$ready` — fully compatible with `storeToRefs`, Vue Devtools, SSR, and `pinia-plugin-persistedstate`.

Resolves the active Noydb instance from either an explicit `noydb:` option or a globally bound instance via `setActiveNoydb()`. The Nuxt module (#8) will install the global binding automatically.

The augmentation plugin (`createNoydbPiniaPlugin`) for existing stores is shipped in a follow-up (#11).

Closes #10.
