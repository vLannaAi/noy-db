# Write lifecycle hooks (#230) — design

**Status:** approved design · **Date:** 2026-06-01 · **Issue:** #230 · **Milestone:** #12 (independent follow-up)

**Goal:** Let an app intercept document writes at the hub layer — `onBeforeWrite` (may abort) and `onAfterWrite` (observe) — so versioning, audit logs, and snapshot capture can hook every write path without a parallel userland write path.

## Why

Today an app that wants document versioning / an audit log / change-derived state must either wrap each collection's `put` in userland (fragile, doesn't cover writes from auth flows, MV rebuilds, etc.) or re-derive by diffing against a stored baseline (expensive, racy). A hub-layer hook is the only approach that covers all write paths uniformly.

## API

Registered on the hub instance (covers every collection / every write path):

```ts
db.onBeforeWrite(handler: WriteHook): Unsubscribe
db.onAfterWrite(handler:  WriteHook): Unsubscribe

type WriteHook = (event: WriteEvent) => void | Promise<void>

type WriteEvent = {
  op:         'create' | 'update' | 'delete'
  collection: string
  docId:      string
  before:     unknown | null   // decrypted prior record; null on 'create'
  after:      unknown | null   // the record written; null on 'delete'
  userId:     string           // the authenticated actor (this.keyring.userId)
  timestamp:  number           // epoch ms
  txId:       string           // shared across all writes in one db.transaction(); a fresh ULID per standalone write
}
```

`Unsubscribe = () => void`.

## Semantics (locked)

- **`onBeforeWrite`** fires after guards + the prior-record read, **before** the adapter write. Handlers are **awaited**. If a handler **throws, the write is aborted** and the error propagates to the caller (no adapter write, no ledger entry).
- **`onAfterWrite`** fires after the adapter commit, alongside the existing `emit('change')`. Handlers are **awaited** (so `put()`/`delete()` resolves only once they finish — predictable ordering, observable errors, durable snapshots). A handler **error is caught and emitted as a warning** (via `console.warn`, matching the persisted-schema/fence convention); it never rolls back the committed write.
- **`op`**: `create` when no prior record existed, `update` when one did, `delete` on delete.
- **`before`/`after`**: `before` is the decrypted prior record (already computed for history/ledger — no extra read), `after` is the decrypted record written. Hooks run inside the authenticated context; they see plaintext and must not be exposed pre-unlock.
- **Re-entrancy guard:** writes a handler itself performs (e.g. the versioning example writing to `_history`) do **NOT** re-fire the hooks — a per-instance re-entrancy flag suppresses nested firing. This prevents infinite loops; consequence: hook-internal writes are not themselves audited (acceptable, documented).
- **Multiple handlers** fire in registration order; for `onBeforeWrite`, the first throw aborts and short-circuits the rest.
- **`txId`**: read from the active `TxContext` when inside `db.transaction()` (so grouped writes share it); a fresh `ULID` otherwise. Requires adding a `txId` field to `TxContext` (minted at construction).

## Architecture

- A small hub-level **`WriteHookRegistry`** (mirrors `NoydbEventEmitter`'s structure): holds `before`/`after` handler sets + `onBeforeWrite`/`onAfterWrite`/`runBefore(event)`/`runAfter(event)` + the re-entrancy flag. Lives on `Noydb`, exposed via `db.onBeforeWrite`/`db.onAfterWrite`, threaded into every `Collection` (like the emitter / write-queue tracker).
- `Collection.putInternal` / `deleteInternal` call `runBefore` (before adapter write) and `runAfter` (after commit). `before`/`after`/`op` are derived from the existing prior-record resolution already in the write path. The re-entrancy flag wraps the handler invocations so nested writes skip hook firing.
- `TxContext` gains a `txId` (ULID); `Collection` reads `this.noydb._activeTxContextOrNull?.txId` and falls back to a fresh ULID.

## Error handling

- `onBeforeWrite` throw → propagate (abort). `onAfterWrite` throw → `console.warn`, continue. Re-entrancy flag is always cleared in a `finally`.

## Testing

- Unit: `WriteHookRegistry` (registration/unsubscribe, before-throw short-circuits + propagates, after-error → warning not throw, re-entrancy flag suppresses nested runs).
- Integration (memory adapter, real `createNoydb`): `onBeforeWrite` sees `{op:'create', before:null, after}` on first put and `{op:'update', before, after}` on second; throwing in `onBeforeWrite` aborts the write (record unchanged); `onAfterWrite` fires post-commit and an afterWrite that writes to another collection does **not** recurse; `delete` fires `{op:'delete', after:null}`; `txId` is identical across writes inside one `db.transaction()` and differs across standalone writes.

## Scope

**In:** hub-level `onBeforeWrite`/`onAfterWrite` + `WriteEvent`, covering `Collection.put`/`delete` (and `putMany`→`put`). `TxContext.txId`.

**Out (documented, consistent with #227):** `putManyAtomic` / `transaction` execute-phase raw writes / CRDT merge / blob writes are not hooked in v1 — a `TODO(#230-followup)` marks the boundary. No per-collection hook registration (hub-level only). No hook ordering/priority controls beyond registration order.

## Success criteria

1. `db.onBeforeWrite`/`onAfterWrite` fire for `put` and `delete` with a correct `WriteEvent` (`op`/`before`/`after`/`userId`/`txId`).
2. A throwing `onBeforeWrite` aborts the write (no record written, no ledger entry); the error reaches the caller.
3. `onAfterWrite` is awaited; its error becomes a warning, never a rollback.
4. A handler that writes does not re-fire the hooks (no infinite loop).
5. `txId` is shared within one `db.transaction()` and distinct across standalone writes.
6. Apps that register no hooks pay only a cheap "any handlers?" check per write (zero behaviour change for the existing suite).
