# Role-gate the sync primary — design (#616)

**Date:** 2026-07-10
**Issue:** [#616](https://github.com/vLannaAi/noy-db/issues/616) — surfaced by the #615 target-purge whole-branch review (Important I2).
**Surface:** `internal` — sync-engine orchestration behavior; no public type/API change.
**Builds on:** `kernel/noydb.ts` sync orchestration (`sync`/`pull`/`push`, `getSyncEngine`, the `syncEngines` fan-out) and `with-party/team/sync.ts` (`SyncEngine.role`, `push`/`pull`/`sync`).

## Problem

`backup`/`archive` sync targets are meant to be **push-only sinks** — you push to them, never pull from them into convergence. `Noydb.sync()` already honors this for **secondary** engines (the fan-out calls `engine.push()` for backup/archive, `engine.sync()` for sync-peer). But the **primary** engine is called `primary.sync()` **unconditionally**, and the primary is elected as `targets.find(t => t.role === 'sync-peer') ?? targets[0]` (`noydb.ts:564`). So a config with **no `sync-peer`** — e.g. `sync: [{ store, role: 'backup' }]` — elects the backup as primary and **pulls from it** on every `db.sync()` / `db.pull()`.

**Why it matters** (from #615's I2): target-purge itself is safe through this path (purging a marker leaves absence; pulling absence is a no-op). But it (1) undercuts the "push-only ⇒ never pulled from" premise the **deferred #611 sync-peer purge** would rest on, and (2) leaves a residual freeze-alone hazard: a swallowed push failure to a backup-as-primary leaves a **stale live record** on the backup; local `freezePeriod` purges the local delete marker; a later pull from that backup **resurrects** the record. Role-gating the pull closes the "later pull resurrects" step.

## Reframing

The role→direction policy **already exists** in the fan-out; the primary simply isn't subject to it. So this is not new policy — it's applying the existing rule uniformly. `SyncEngine.role` is a public `readonly` field, so the orchestrator reads it directly.

## Decision summary

1. **Gate at the orchestration layer** (`Noydb.sync`/`pull`), applied to the primary — not inside `SyncEngine`. `SyncEngine` stays a pure mechanism (an explicit `engine.pull()` still pulls); the direction policy lives in one place (the orchestrator that already fans out by role).
2. **`Noydb.sync()`:** the primary call becomes role-aware — `sync-peer` → `primary.sync()` (unchanged); otherwise → `primary.push(options?.push)` (push-only). Identical to the secondary branch, now covering the primary.
3. **`Noydb.pull()`:** when the primary's role is not `sync-peer`, return an **empty `PullResult`** (`{ pulled: 0, conflicts: [], errors: [] }`) without touching the store — a silent no-op, consistent with `sync()`'s silent degradation to push-only. (No new event — see §"Deliberate YAGNI".)
4. **Election unchanged.** The backup stays elected under the bare-`vault` engine key; we gate its *direction*, not re-architect election.
5. **Doc tightening.** Update the target-purge spec §3 and the periods docs from "backup/archive are never pulled from" (aspirational) to reflect that the engine orchestration now enforces push-only for non-`sync-peer` targets.

## Design

### 1. `Noydb.sync()` — role-gate the primary

In `Noydb.sync(vault, options)` (`noydb.ts:~1294`), replace the unconditional primary call:

```ts
const primary = this.getSyncEngine(vault)
const result = await primary.sync(options)
```

with a role-aware call that mirrors the fan-out's branch:

```ts
const primary = this.getSyncEngine(vault)
const result: { pull: PullResult; push: PushResult } =
  primary.role === 'sync-peer'
    ? await primary.sync(options)
    : { pull: emptyPullResult(), push: await primary.push(options?.push) }
```

where `emptyPullResult()` is the factory defined in §3. The existing secondary fan-out below is unchanged.

### 2. `Noydb.pull()` — no-op for a non-`sync-peer` primary

In `Noydb.pull(vault, options)` (`noydb.ts:~1285`):

```ts
async pull(vault: string, options?: PullOptions): Promise<PullResult> {
  const engine = this.getSyncEngine(vault)
  if (engine.role !== 'sync-peer') return emptyPullResult()   // #616: push-only sinks are never pulled from
  return engine.pull(options)
}
```

`Noydb.push()` is unchanged — pushing to a backup/archive is the intended direction.

### 3. The empty-result factory

Add a module-level factory in `noydb.ts` that returns a fresh object each call (no shared-mutable-state question):

```ts
const emptyPullResult = (): PullResult => ({ pulled: 0, conflicts: [], errors: [] })
```

### 4. Deliberate YAGNI — no new event

`sync()`'s degradation to push-only for a sink emits nothing today; for consistency, `pull()`'s no-op emits nothing either. There is no existing event channel that fits "pull skipped because the target is a sink" (`sync:backup-error` is for errors), and adding one is a surface addition not clearly needed. A diagnostic event is a clean **additive** future option if misconfiguration observability is wanted; not now.

### 5. Interaction / backward-compat

- **Normal config (sync-peer primary, optional backup secondaries):** unchanged — the primary is `sync-peer` so `sync()`/`pull()` behave exactly as before; backups already push-only via the fan-out.
- **Multiple sync-peers:** the first is primary (pull+push), the rest are secondaries the fan-out already `sync()`s (pull+push). Unchanged.
- **Backup/archive-only:** now `sync()` is push-only and `pull()` is a no-op — the fix.
- **No existing test pulls from a backup-as-primary:** the #615 target-purge tests use backup-only configs but seed markers white-box (never call `db.sync`/`db.pull`); custody/consent tests use a backup *secondary* alongside a `sync-peer` primary. The plan re-confirms by running the sync/party suites.

### 6. Testing

1. **Backup-only `pull()` is a no-op:** `sync: [{ store: backup, role: 'backup' }]`; seed a live record present ONLY on the backup; `db.pull(V)` returns `{ pulled: 0, ... }` and the record is **not** imported into local.
2. **Backup-only `sync()` is push-only:** a local record IS pushed to the backup; a record present only on the backup is **not** pulled into local; the returned `pull` is empty and `push` reflects the upload.
3. **Resurrection hazard closed (the point of the fix):** backup-only config; `put` then `delete` locally (local `_del` marker) but do NOT push (simulate a swallowed push failure, so the backup still holds the stale live record); `freezePeriod` after close (purges the local marker); `db.pull(V)` → the stale live record is **not** resurrected locally (stays deleted). Without the fix this pull would re-import the live record.
4. **Sync-peer primary unchanged (regression):** `sync: remote` (bare store ⇒ `sync-peer`); `db.pull`/`db.sync` still pull+push a remote-only record into local.
5. **Sync-peer primary + backup secondary unchanged (regression):** the primary pulls+pushes; the backup receives pushes only (existing fan-out behavior intact).

## Out of scope

- **Re-architecting primary election** (e.g. "no primary when no sync-peer"). The direction gate is sufficient; election restructuring is unneeded churn.
- **A pull-skipped diagnostic event** — additive future option (§4).
- **The `sync-peer` target-purge** and **fleet purge** — still #611 / klum concerns; this fix is a prerequisite for reasoning about the former, not the former itself.
