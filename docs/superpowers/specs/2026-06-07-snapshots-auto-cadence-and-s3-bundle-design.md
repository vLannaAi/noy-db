# Snapshots: auto-cadence (`snapshotPolicy`) + S3 bundle-mode adapter — Design

> **Status:** approved (2026-06-07). Follow-up to RFC [#272], closing its two unbuilt open questions (Q6 auto-cadence, Q7 S3 bundle adapter). The core `withSnapshots()` subsystem shipped in 0.2.0-pre.7 ([#279]); this design adds the remaining slice.

[#272]: https://github.com/vLannaAi/noy-db/issues/272
[#279]: https://github.com/vLannaAi/noy-db/pull/279

## Summary

Two independent, separately-testable pieces:

1. **Auto-cadence** — an opt-in `snapshotPolicy` on `withSnapshots()` that fires automatic whole-vault snapshots on a debounce/interval cadence, triggered by vault writes. Automatic snapshots write a **single rolling key** (`<vault>__auto`), decoupled from the immutable on-demand checkpoint pool so the timer can never evict labeled checkpoints.
2. **S3 bundle-mode adapter** — a new `s3Bundle()` export in `@noy-db/to-aws-s3` implementing the `NoydbBundleStore` contract (whole-vault blobs + OCC via S3 conditional writes), giving the driving use case ("persist `.noydb` versions to S3") a real bundle destination.

Both compose existing primitives. No new storage mechanism; no change to the on-demand `snapshot()` / `listSnapshots()` / `restoreSnapshot()` surface beyond additive fields.

## Motivation

RFC #272 shipped on-demand snapshot / list / restore / retention, resolving 5 of its 7 open questions. Two remain:

- **Q6 — automatic cadence.** Today snapshots are on-demand only. A local-first app wants periodic backups without hand-rolling a timer + dirty-tracking + flush-on-unload.
- **Q7 — S3 bundle adapter.** `to-aws-s3` ships `s3()` (per-record). There is no `NoydbBundleStore` for S3, so the RFC's own driving scenario (versioned `.noydb` bundles on S3) has no destination.

## Design decisions (settled)

| Decision | Choice | Why |
|---|---|---|
| Auto-snapshot × retention | **Rolling single key** (`<vault>__auto`), separate from immutable pool | Immutable, counter-keyed auto-snapshots in the shared pool would let the timer churn `keepLast` and silently evict labeled checkpoints. A rolling slot never accumulates and never evicts. Matches RFC Q6 ("decouples frequency from version count"). |
| Default cadence | **Manual-only** (`mode: 'manual'`) | Zero-surprise: no timers/cost unless an app explicitly opts into `mode: 'debounce'`/`'interval'`. Mirrors today's behavior. |
| Scheduler | **Dedicated `SnapshotScheduler`**, borrowing `SyncPolicy` *vocabulary* only | `SyncScheduler`'s push/pull/getDirtyCount shape and pending/pulling states don't map to snapshots. Reuse the field names (`debounceMs`/`intervalMs`/`minIntervalMs`/`onUnload`), not the class. |
| S3 OCC | ETag as version token; `IfMatch` conditional `PutObject`; `null` ⇒ unconditional | `null` (rolling-auto overwrite, first write) must be unconditional. `IfMatch` on an ETag → 412 maps to `BundleVersionConflictError`. Never `IfNoneMatch:*` (create-only would break overwrite). |

## Architecture

### Piece A — Auto-cadence (hub-core, behind `withSnapshots`)

#### New types — `packages/hub/src/snapshots/policy.ts`

```ts
export type SnapshotMode = 'manual' | 'debounce' | 'interval'

export interface SnapshotPolicy {
  /** Trigger mode. Default 'manual' — no timers, on-demand only. */
  readonly mode?: SnapshotMode
  /** Debounce idle delay (ms) after a write. mode:'debounce'. Default 30_000. */
  readonly debounceMs?: number
  /** Fixed interval (ms). mode:'interval'; also a floor for debounce. Default 300_000. */
  readonly intervalMs?: number
  /** Hard floor (ms) between auto-snapshots regardless of mode. Default 0. */
  readonly minIntervalMs?: number
  /** Flush a pending auto-snapshot on tab-hide / process exit. Default true for non-manual. */
  readonly onUnload?: boolean
  /** Label applied to auto-snapshots. Default 'auto'. */
  readonly label?: string
}
```

#### `SnapshotMeta` + `SnapshotIndex` additions — `strategy.ts`

```ts
export interface SnapshotMeta {
  // ...existing fields unchanged...
  /** True for the rolling auto-snapshot; absent for on-demand checkpoints. */
  readonly auto?: true
}

/** @internal */
export interface SnapshotIndex {
  snapshots: SnapshotMeta[]       // immutable on-demand pool (counter-keyed)
  nextCounter: number
  auto?: SnapshotMeta             // single rolling auto slot (NEW), separate from the pool
}
```

`SnapshotStrategy` gains:

```ts
export interface SnapshotStrategy {
  snapshot(vault, by, opts?): Promise<SnapshotMeta>
  listSnapshots(vaultId): Promise<SnapshotMeta[]>
  restoreSnapshot(vault, version): Promise<void>
  /** NEW — rolling auto-snapshot to the fixed `<vault>__auto` key. */
  autoSnapshot(vault, by, opts?): Promise<SnapshotMeta>
  /** NEW — the configured cadence policy (undefined / manual ⇒ no scheduler). */
  readonly policy?: SnapshotPolicy
}
```

The `NO_SNAPSHOTS` stub gains an `autoSnapshot` that throws the same not-enabled error; `policy` is omitted.

#### Engine — `engine.ts`

- `autoKey(vaultName)` → `${vaultName}__auto`.
- `autoSnapshot(vault, by, opts?)`:
  1. `bytes = writeNoydbBundle(vault, {})`.
  2. Read index (with OCC version).
  3. `writeBundle(autoKey, bytes, null)` — unconditional overwrite of the rolling slot.
  4. Build `meta` with `version: autoKey`, `auto: true`, `label: opts?.label ?? 'auto'`.
  5. `index.auto = meta` (no counter increment; **`applyRetention` not called** — auto slot is exempt).
  6. `writeIndex(vaultName, index, indexVersion)` — OCC-guarded.
- `listSnapshots()`:
  ```ts
  const { index } = await this.readIndex(vaultId)
  return [...(index.auto ? [index.auto] : []), ...index.snapshots.slice().reverse()]
  ```
- `restoreSnapshot()` — unchanged; the `<vault>__auto` key passes the existing `startsWith(`${vault.name}__`)` guard and resolves via `readBundle`.
- `applyRetention()` — unchanged; operates only on `index.snapshots`.

#### Scheduler — `packages/hub/src/snapshots/scheduler.ts`

A small class owning timers + unload hooks for the snapshot cadence. Distinct from `SyncScheduler`.

```ts
export interface SnapshotSchedulerCallbacks {
  /** Fire one auto-snapshot cycle (per dirty vault). Errors are swallowed by the caller. */
  fire(): Promise<void>
  /** Number of vaults with pending writes since the last fire. */
  pendingCount(): number
}

export class SnapshotScheduler {
  constructor(policy: SnapshotPolicy, callbacks: SnapshotSchedulerCallbacks)
  start(): void          // registers interval timer (mode:'interval') + unload hooks
  stop(): void           // clears all timers + removes listeners — idempotent
  notifyChange(): void   // mode:'debounce' resets debounce; mode:'interval'/'manual' no-op
}
```

Behavior mirrors `SyncScheduler`'s push half:
- `mode:'debounce'` → `notifyChange()` resets a `debounceMs` timer; `minIntervalMs` floor enforced; on fire, calls `callbacks.fire()`.
- `mode:'interval'` → fixed `setInterval(intervalMs)`; `notifyChange()` is a no-op.
- `mode:'manual'` → scheduler is never constructed (see wiring).
- `onUnload` (default true non-manual) → `visibilitychange→hidden` / `pagehide` / process `beforeExit` fire a best-effort `fire()` if pending.
- Re-entrant `fire()` guarded (skip if one is already running).

#### Wiring — `packages/hub/src/noydb.ts`

When `this.snapshotStrategy.policy` is set and `policy.mode !== 'manual'`:
- Lazily construct **one** `SnapshotScheduler` for the db instance.
- Subscribe via `onAfterWrite((ctx) => { dirtyVaults.add(ctx.vault); scheduler.notifyChange() })`.
- `callbacks.fire()` → for each dirty vault name: resolve the open `Vault`, `await strategy.autoSnapshot(vault, this.options.user)`, then clear it from the dirty set. Wrap each in `try/catch` — a `BundleVersionConflictError` (concurrent manual snapshot / second tab) or any error is logged via the existing warn path and skipped, **never** an unhandled rejection (the fire runs inside the after-write hook contract: "handler error is warned, never rolled back").
- `callbacks.pendingCount()` → `dirtyVaults.size`.
- `scheduler.start()` on first activation; `scheduler.stop()` in `db.close()`.

**Re-entrancy:** `autoSnapshot` writes through the **bundle store** (`store.writeBundle`), not the vault write path (`vault.put`), so `onAfterWrite` does not re-fire from a snapshot. (Verified: write hooks fire on collection writes only.)

**Vault resolution:** `fire()` resolves names against the db's already-open vaults; a name with no live vault (closed since the write) is dropped from the dirty set silently.

### Piece B — `s3Bundle()` adapter (`@noy-db/to-aws-s3`)

#### New file — `packages/to-aws-s3/src/bundle.ts`

```ts
export interface S3BundleOptions {
  bucket: string
  prefix?: string          // default '' ; keys are `{prefix}/{vaultId}.noydb`
  region?: string          // used only when `client` absent; default 'us-east-1'
  client?: S3Client
}

export function s3Bundle(options: S3BundleOptions): NoydbBundleStore
```

Returned object (`kind: 'bundle'`, `name: 's3'`):

- `objectKey(vaultId)` → `{prefix}/{vaultId}.noydb` (prefix optional).
- `readBundle(vaultId)`:
  - `GetObject`; on success `{ bytes: <Uint8Array>, version: <ETag, quotes stripped> }`.
  - `NoSuchKey` / `NotFound` → `null`.
- `writeBundle(vaultId, bytes, expectedVersion)`:
  - `expectedVersion === null` → `PutObject` **unconditional**.
  - else → `PutObject` with `IfMatch: expectedVersion`. On `PreconditionFailed` (HTTP 412) → throw `BundleVersionConflictError`.
  - Return `{ version: <new ETag> }`. (If `PutObject` response omits ETag — rare — a follow-up `HeadObject` fetches it.)
- `deleteBundle(vaultId)` → `DeleteObject` (idempotent; S3 delete of a missing key is a no-op).
- `listBundles()`:
  - `ListObjectsV2` over `{prefix}/`, paginate via `ContinuationToken`.
  - For each key ending `.noydb`: `{ vaultId: <key minus prefix minus '.noydb'>, version: <ETag>, size: <Size> }` — **straight from the list response, no per-object GET**.

ETags are returned by both `ListObjectsV2` (per object) and `PutObject`. Quotes are stripped for a stable token. `IfMatch` on `PutObject` requires **`@aws-sdk/client-s3` ≥ 3.696** (conditional-writes GA, Nov 2024); documented as the minimum and noted in the package README.

#### Export — `packages/to-aws-s3/src/index.ts`

Re-export `s3Bundle` + `S3BundleOptions` alongside the existing `s3` / `S3Options`. Single `.` package export retained.

## Error handling

| Condition | Behavior |
|---|---|
| Auto-snapshot OCC conflict (index write) | Caught in `fire()`, warned, vault stays dirty for the next cycle; never throws to the write hook. |
| `autoSnapshot` on a NO_SNAPSHOTS stub | Throws the not-enabled error (only reachable via direct API misuse; the scheduler is never wired without a real strategy). |
| S3 `IfMatch` 412 | `BundleVersionConflictError`. |
| S3 `GetObject` NoSuchKey | `readBundle` → `null` (first open / deleted). |
| `db.close()` | `scheduler.stop()` clears every timer + listener; no hung process / leaked handle. |

## Testing

- **Engine (`engine.test.ts` additions):** auto overwrites one key across N calls; `index.auto` excluded from `applyRetention` (e.g. `keepLast:1` + 5 manual + auto interleaved → auto survives); `listSnapshots` returns auto first; restore of `<vault>__auto`.
- **Scheduler (`scheduler.test.ts`):** debounce coalesces bursts into one fire; interval fires on tick; `minIntervalMs` floor; `notifyChange` no-op under interval/manual; `stop()` clears timers (no pending callbacks after stop); re-entrant fire guarded; `onUnload` fires pending on simulated hidden/beforeExit. Fake timers.
- **noydb wiring (`noydb` snapshot-cadence test):** `mode:'manual'` (or no policy) wires no scheduler (no timers); `mode:'debounce'` → a vault write schedules an auto-snapshot that appears in `listSnapshots`; conflict in `fire()` is swallowed; `close()` stops the scheduler.
- **s3Bundle (`bundle.test.ts`):** round-trip read/write/delete/list against a fake `S3Client` (records keys + ETags, simulates `IfMatch`→412 and `NoSuchKey`); `null`→unconditional put; ETag→conditional; `listBundles` derives vaultId/version/size with no GET; pagination across a truncated list.
- **Showcase 96** (`96-snapshots-auto-cadence.showcase.test.ts`): enable `withSnapshots({ store, snapshotPolicy: { mode:'debounce', debounceMs: ... } })`, write, advance fake time, assert the rolling auto-snapshot exists and restores, while a labeled on-demand checkpoint is untouched by cadence.

## Registry & docs

- `features.yaml` — snapshots invariants for auto-cadence (rolling key, retention-exempt) + showcase 96; note the `s3Bundle` adapter.
- `docs/subsystems/snapshots.md` — "Automatic cadence" + "S3 bundle store" sections.
- `packages/hub/CHANGELOG.md` + `packages/to-aws-s3/CHANGELOG.md` — next pre-release entry.

## Compatibility

Fully additive and opt-in. `withSnapshots({ store })` with no `snapshotPolicy` behaves exactly as in pre.7/pre.8 (manual-only, no timers). `SnapshotMeta.auto` and `SnapshotIndex.auto` are optional. Existing on-demand consumers and existing `s3()` per-record consumers are unaffected.

## Non-goals

- No per-collection snapshots (whole-vault only, matching the bundle codec).
- No change to the immutable on-demand pool semantics or retention math.
- No new S3 lifecycle/expiry engine (`prune:false` continues to delegate expiry to infra).
- No reuse of the `SyncScheduler` class (vocabulary only).
