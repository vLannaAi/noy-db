# Issue #140 — refactor(core): rename adapter → store across packages and public API

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.10.0
- **Labels:** type: chore, priority: medium, area: core, area: adapters

---

## Summary

Rename the storage adapter concept from `adapter` to `store` uniformly across all packages and the public API. Pre-1.0 breaking change.

## Package renames

| Current | Renamed |
|---|---|
| `@noy-db/memory` | `@noy-db/store-memory` |
| `@noy-db/file` | `@noy-db/store-file` |
| `@noy-db/browser` | `@noy-db/store-browser` |
| `@noy-db/dynamo` | `@noy-db/store-dynamo` |
| `@noy-db/s3` | `@noy-db/store-s3` |

Non-storage packages unchanged: `core`, `vue`, `nuxt`, `pinia`, `auth-oidc`, `auth-webauthn`, `create`.

## API surface changes in `@noy-db/core`

| Current | Renamed |
|---|---|
| `NoydbAdapter` | `NoydbStore` |
| `NoydbOptions.adapter` | `NoydbOptions.store` |
| `defineAdapter()` | `createStore()` — avoids collision with Pinia's `defineStore()` |
| `AdapterCapabilities` | `StoreCapabilities` |
| `AdapterCapabilityError` | `StoreCapabilityError` |
| `runAdapterConformanceTests()` | `runStoreConformanceTests()` |

`NoydbOptions.sync` is unchanged — it describes a role, not a type.

## Consumer migration

```ts
// before
import { jsonFile } from '@noy-db/file'
const db = await createNoydb({ adapter: jsonFile({ dir: './data' }) })

// after
import { jsonFile } from '@noy-db/store-file'
const db = await createNoydb({ store: jsonFile({ dir: './data' }) })
```

## Notes

- `createStore()` not `defineStore()` — avoids import collision with Pinia's `defineStore()` in Vue apps
- All planned v0.11 stores (`@noy-db/store-postgres`, `@noy-db/store-firestore`, etc.) ship under the new naming from the start
- Publish old package names as deprecated stubs on npm pointing to new names for one minor version cycle
- CLAUDE.md, SPEC.md, ROADMAP.md, and all `docs/` references need updating

## Context

Emerged from store classification work — see discussions #137 and #138. Companion issue: `casAtomic` + `acknowledgeRisks` properties.
