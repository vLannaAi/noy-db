# Issue #141 — feat(core): StoreCapabilities.casAtomic + NoydbOptions.acknowledgeRisks

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.10.0
- **Labels:** type: feature, priority: medium, area: core, area: adapters

---

## Summary

Two companion properties that together implement the write-write safety guidance layer.

---

## 1. `StoreCapabilities.casAtomic`

A static capability flag every store declares. Tells core whether the store's `put()` with `expectedVersion` is atomically safe for concurrent multi-user writes.

```ts
interface StoreCapabilities {
  /**
   * true  — the store's expectedVersion check and write are atomic at the
   *         storage layer. Two concurrent puts with the same expectedVersion
   *         will produce exactly one success and one ConflictError.
   *         (DynamoDB ConditionExpression, Postgres UPDATE WHERE, etc.)
   *
   * false — the check and write are separate operations with a race window
   *         between them. Two concurrent puts may both succeed, silently
   *         clobbering one writer's changes (lost update).
   *         (file, S3, R2, WebDAV, Git, bundle stores)
   */
  casAtomic: boolean
}
```

### Known values for shipped stores

| Store | `casAtomic` | Reason |
|---|---|---|
| `store-memory` | `true` | JS single-threaded; check and set are synchronous |
| `store-dynamo` | `true` | `ConditionExpression` — atomic at DynamoDB layer |
| `store-browser` (localStorage) | `true` | Synchronous ops; atomic within a single tab |
| `store-browser` (IndexedDB) | `true` | After fix in #139: single readwrite tx |
| `store-file` | `false` | `await readFile` → check → `await writeFile`: TOCTOU race |
| `store-s3` | `false` | Two separate HTTP calls |

### Core warning

When `casAtomic: false` and `expectedUsers > 1` (or multiple `SyncTarget` entries with write roles), core emits a startup warning:

```
[noy-db] Warning: store-file has casAtomic: false. Concurrent writes from
multiple users may silently overwrite each other (lost update). Use a
hub-class store (store-dynamo, store-postgres, …) or pass
acknowledgeRisks: ['no-atomic-cas'] if your application layer prevents
concurrent writes.
```

---

## 2. `NoydbOptions.acknowledgeRisks`

Explicit developer opt-in for knowingly using a `casAtomic: false` store in a multi-user context. Suppresses the warning and records the acknowledgement in the first audit log entry.

```ts
interface NoydbOptions {
  store: NoydbStore
  acknowledgeRisks?: AcknowledgedRisk[]
  // ...
}

type AcknowledgedRisk =
  | 'no-atomic-cas'   // casAtomic: false store used with multiple writers;
                      // developer is providing application-layer prevention
                      // (presence, record locking, workflow assignment, etc.)
```

### Usage

```ts
const db = await createNoydb({
  store: jsonFile({ dir: '//server/share' }),
  acknowledgeRisks: ['no-atomic-cas'],
  // Developer's responsibility:
  // presence layer prevents two users editing the same record simultaneously
})
```

### Audit log entry

The first audit log entry records the acknowledged risks so the decision is traceable:

```json
{
  "event": "session:open",
  "user": "alice",
  "acknowledgedRisks": ["no-atomic-cas"],
  "timestamp": "2026-04-09T10:00:00.000Z"
}
```

---

## Context

- Write-write conflict analysis — see discussion #138 (adapter probe) and #137 (multi-backend topology)
- Companion rename issue #140 changes `AdapterCapabilities` → `StoreCapabilities`
- The `no-atomic-cas` risk type is the first entry in what may grow into a broader `AcknowledgedRisk` union as more capability flags are added
