# Store conformance (DRAFT)

> **Status:** v0.25 draft. Source-of-truth conformance tests live in `packages/hub/src/__tests__/store-conformance.test.ts`; this page documents what they enforce.

A `NoydbStore` implementation is correct when it passes `runStoreConformanceTests(store)`. Every `to-*` package's CI runs the suite against its store. This page describes the contract in human terms.

## The 6 mandatory methods

| Method | Contract |
|---|---|
| `get(v, c, id)` | Return the envelope for `(v, c, id)` or `null` if absent. Never throw on missing. |
| `put(v, c, id, env, ev?)` | Persist `env`. If `ev` is supplied AND a record exists with `_v !== ev`, throw `ConflictError(ex._v)`. Otherwise overwrite. |
| `delete(v, c, id)` | Remove the record at `(v, c, id)`. No-op if absent. Never throw on missing. |
| `list(v, c)` | Return the array of record IDs in `(v, c)`. Empty array if collection doesn't exist. |
| `loadAll(v)` | Return `VaultSnapshot` — every non-internal collection's contents. Skip names starting with `_`. |
| `saveAll(v, snapshot)` | Replace `(v)`'s non-internal collections with `snapshot`. Preserve internal `_*` collections that already exist. |

## Optional capabilities

A store advertises capabilities via the `capabilities` accessor:

```ts
get capabilities(): StoreCapabilities {
  return {
    casAtomic: true,
    auth: { kind: 'passphrase' },
  }
}
```

| Capability | What it claims |
|---|---|
| `casAtomic: true` | The `expectedVersion` check in `put()` is atomic — the read-modify-write cycle cannot interleave with a concurrent put. Required by sync engine for safe replication. |
| `casAtomic: false` | The store provides best-effort CAS but does not guarantee atomicity (e.g., S3 with `If-Match`). Sync engine layers an advisory lock on top. |
| `auth.kind: 'passphrase' \| 'cloud-creds' \| 'system' \| 'magic-link' \| 'hardware'` | Metadata for unlock-flow UX. Does not change the store contract. |

## Optional fast-path methods

Implement these to opt into the fast path; the hub falls back to a synthetic implementation otherwise.

### `listPage(v, c, { cursor?, limit? })`
Return `{ ids, cursor }` for paginated streaming. Used by `Collection.scan()` / `listPage()`. Falls back to `list()` + slice (slower; emits a one-shot warn).

### `listSince(v, c, since)`
Return only IDs whose `_ts >= since`. Used by sync's pull-since-modified. Falls back to a filter over `loadAll()`.

### `presencePublish(v, channel, payload)` + `presenceSubscribe(v, channel, cb)`
Real-time presence channel. Falls back to storage-poll (5s default) if absent.

### `tx(v, ops)`
Native multi-record atomic write. Used by `db.transaction(fn)` when the store implements it; falls back to staged-revert via the raw adapter when not.

## What the conformance suite checks

A subset (full list in `__tests__/store-conformance.test.ts`):

1. **Round-trip**: put → get → delete returns the same envelope and then null
2. **CAS**: put with stale `expectedVersion` throws `ConflictError`; put with correct `expectedVersion` succeeds
3. **List**: returns IDs of all records put; empty for unknown collections
4. **loadAll**: includes only non-internal collections; preserves envelope shape
5. **saveAll**: round-trips; preserves internal collections; replaces user collections
6. **Encoding**: arbitrary base64 payloads survive get/put without corruption
7. **Concurrency** (when `casAtomic: true`): two concurrent puts with the same `expectedVersion` — exactly one succeeds, exactly one throws
8. **Capabilities surfaced**: `store.capabilities.casAtomic` matches actual behavior

## See also

- [docs/core/03-stores.md](../core/03-stores.md) — the contract from the consumer side
- `packages/hub/src/__tests__/store-conformance.test.ts` — the executable spec
- [docs/packages-stores.md](../packages-stores.md) — catalog of 20 built-in stores
