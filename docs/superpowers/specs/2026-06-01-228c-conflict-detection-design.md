# Cross-tab conflict detection (#228 sub-slice c) — design

**Status:** design approved · **Date:** 2026-06-01 · **Issue:** #228 (final slice) · **Epic:** hub coordination · **Builds on:** [#228(b) cross-tab write propagation](2026-06-01-228b-cross-tab-write-propagation-design.md), #230 write hooks

Sub-slice **(c)** completes #228. When two same-origin tabs write the same document concurrently, the loser's write is silently overwritten (`collection.put` is last-write-wins: it bumps `version = cachedVersion + 1` with no compare-and-swap). This slice **detects** that divergence and emits a `WriteConflict` event so the application can reconcile. Resolution is left to the app — the hub never auto-merges. Browser-only, rides the same opt-in (`db.enableTabCoordination`) and the same `noydb:tab-writes` channel as (b).

## Decision (locked)

**Post-hoc divergence detection** (issue's stated model: "the hub detects this on merge and emits a conflict event… resolution is left to the application"). The (b) propagation signal is extended with versions; a receiving tab detects when a remote write diverged from a base older than its own write. The rejected alternative — write-time optimistic CAS (`collection.put` passing `expectedVersion` so the idb adapter throws `ConflictError`) — changes write semantics (puts can throw), is adapter-dependent, and does not notify other tabs, so it does not fit the issue's `onConflict` model.

## Detection mechanism

### Signal + WriteEvent extension

`TabWriteMsg` (b) gains two fields:

```ts
interface TabWriteMsg {
  readonly kind: 'tab-write'
  readonly writerId: string
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly action: 'put' | 'delete'
  readonly baseV: number   // version the writer started from (0 on create)
  readonly v: number       // version the writer wrote
}
```

To source these at broadcast time, `WriteEvent` (#230) gains `readonly baseVersion: number` and `readonly version: number`, computed at the emit site in `collection.ts`: `baseVersion` = the cache's pre-write version for the id (`0` when absent / on create), `version = baseVersion + 1`. (`WriteEvent` already gained `vault` in (b); this is a second backward-compatible addition.) `baseVersion` is the load-bearing value — it accurately reflects the version the writer *saw*; `version` is informational (receivers re-read the store for authoritative state).

### Own-write ledger

Each tab keeps `Map<"vault\0collection\0docId", number>` — the version of each doc *this tab* last wrote (recorded on its own `onAfterWrite`). Bounded by the tab's write working-set. An entry advances or clears when a remote write that incorporated it arrives (see rule). This is a per-document **version-vector-lite**: one integer plus "did I write this."

### Conflict rule (receiver side, per incoming remote `tab-write`)

Let `ownV = ledger.get(key)`.

| Condition | Meaning | Action |
|---|---|---|
| no `ownV` | this tab never wrote this doc | apply (fast-forward); no conflict |
| `baseV >= ownV` | the remote writer built on (or past) our write | apply; set `ledger[key] = v`; no conflict |
| **`baseV < ownV`** | **remote diverged from a base older than our write — they didn't see it** | **conflict** (then converge; keep ledger entry) |

Under LWW both concurrent writers detect the conflict (each sees the other's `baseV` below its own write) and each emits — acceptable: both apps learn of it; reconciliation is idempotent.

**Known limitation (3+ tabs).** With three tabs the single-counter ledger can surface a *false* conflict: if B's write is incorporated by A (B advances its ledger to A's `v`), a third tab C that also diverged from the older base can then trip B's `baseV < ownV` check even though B's own write was already seen. Precise 3-way detection needs per-writer version vectors, which is out of scope here — this slice targets the 2-tab success criteria. The false positive is safe (it only over-notifies; the app reconciles idempotently and the cache still converges), and is documented rather than solved.

## `WriteConflict` payload + surface

A new cross-tab type — distinct from sync's `Conflict` (which carries *encrypted envelopes*); cross-tab app handlers want decrypted records to reconcile:

```ts
interface WriteConflict {
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly local: unknown        // the record THIS tab wrote (clobbered) — captured pre-converge
  readonly remote: unknown       // the record now authoritative in the store (the other tab's)
  readonly base: unknown | null  // common ancestor at baseV (from history); null if unavailable
  readonly localVersion: number  // this tab's own-write version (ownV)
  readonly remoteVersion: number // the incoming write's v
  readonly baseVersion: number   // the incoming write's baseV
}
```

- **Surface:** `db.onWriteConflict(fn: (c: WriteConflict) => void): Unsubscribe`, plus a `write:conflict` entry in `NoydbEventMap` (so `db.on('write:conflict', …)` also works) — mirroring `onAfterWrite` / `onTabRoleChange`.
- **`base`:** from `collection.getVersion(docId, baseV)` — **best-effort**: the default history strategy is `NO_HISTORY` (its `getVersionEnvelope` throws), so `base` is `null` unless the app opted into `withHistory()`; it is also `null` when that version was pruned. `getVersion` failures are caught and degrade to `null`. `local`/`remote` and the versions are always present.

## Convergence + no auto-resolution

On conflict the relay **captures `local` from the current cache, then converges** (the existing (b) re-read — the cache now holds the store's authoritative `remote`), **then emits** `WriteConflict`. The cache never lies about the store; the app is told "your write was overwritten — here is yours, theirs, and the ancestor," and may re-`put` a merged or own value if it wants "keep mine." The hub performs no automatic resolution.

## Architecture / where it lives

- **`collection.ts`** — populate `WriteEvent.baseVersion`/`version` at the two emit sites (reuse the pre-write cache lookup already done for the `before` record).
- **`tab-write-relay.ts` — the coordination brain.** It owns the own-write ledger (records `ledger[key] = e.version` from each local `onAfterWrite`) and runs the conflict rule on each incoming message. On **no conflict** it calls the host's existing `applyRemoteWrite(vault, collection, docId, action)` (converge). On **conflict** it instead calls a new injected `reportConflict(vault, collection, docId, baseV, v, ownV)` and leaves the ledger entry intact. The relay stays storage-agnostic — it never touches records itself.
- **`noydb.ts` — the storage/emit arm.** Implements `reportConflict`: resolve loaded vault→collection, capture `local` (current cached record) and `localVersion`, read `base` via `getVersion(baseV)`, converge (existing `_applyRemoteWrite`) to capture `remote`, then emit `write:conflict`. Adds `onWriteConflict`. Both `applyRemoteWrite` and `reportConflict` are passed to the relay when coordination is enabled.
- **`vault.ts`** — a helper to read a loaded collection's current cached record + `getVersion(baseV)` for the conflict payload (mirrors `_applyRemoteWrite`'s loaded-collection guard; no-op when the collection isn't loaded).

## Error handling / edges

- **History disabled / base pruned** → `base: null`; the event still fires with versions + local/remote.
- **Collection/vault not loaded in the receiving tab** → no conflict possible (the tab has no own-write ledger entry and nothing cached); skip, exactly like (b).
- **Delete vs put** → a remote delete diverging from our write is still a conflict (`remote: null`); a remote delete with no own write fast-forwards (cache delete), no conflict.
- **False-positive guard** → a tab that only ever *applied* remote writes (never wrote the doc itself) has no ledger entry, so a late/reordered message cannot manufacture a phantom conflict.
- **Reentrancy** → conflict emission is a read-side notification; it never writes, so it cannot loop (same guarantee as (b)).

## Testing (deterministic, no real browser)

- **Unit — extend `packages/hub/__tests__/tab-write-relay.test.ts`.** Inject a spy `reportConflict`. Assert: a remote msg with `baseV < ownV` (after a recorded local write) triggers `reportConflict`; `baseV >= ownV` and no-prior-local-write cases do **not**; the ledger advances on incorporation (a later `baseV >= v` clears the conflict condition).
- **Integration — extend `packages/hub/__tests__/tab-write-propagation.test.ts`.** Two tabs sharing one `memory()` store (the (b) seed pattern). Drive a concurrent write: both tabs write the same doc from the same base, pump both buses; assert each tab emits a `WriteConflict` with correct `{local, remote, base, localVersion, remoteVersion, baseVersion}`, and caches converge to the store's LWW winner. Add a **sequential** (non-concurrent) write that fires **no** conflict — the false-positive regression guard.

## Scope

**In (c):** `baseV`/`v` on the signal; `baseVersion`/`version` on `WriteEvent`; the own-write ledger + conflict rule; `WriteConflict` + `onWriteConflict` + `write:conflict`; `base` from history; converge-then-notify; unit + integration tests; `features.yaml` registration.

**Out:** automatic resolution / merge strategies (the app's job); write-time CAS (the rejected Approach B); cross-device conflict (the sync engine already has its own `Conflict`/`ConflictStrategy` model).

## Success criteria

1. Two tabs writing the same doc concurrently each emit a `WriteConflict` carrying decrypted `local` (their clobbered write), `remote` (the store's authoritative value), and `base` (the common ancestor, or `null` if history is unavailable), plus the three versions.
2. A sequential write a tab *did* see (its broadcast `baseV >= ownV`) fast-forwards with **no** conflict.
3. A tab that never wrote the doc never emits a conflict for it (no false positives from reordered/late messages).
4. On conflict, the receiving tab's cache converges to the store's authoritative value before the event fires; the hub performs no automatic resolution.
5. Opt-in via `enableTabCoordination` (rides (b)'s `propagateWrites`); a graceful no-op outside browsers.
