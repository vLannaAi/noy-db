# Issue #101 — feat(core): syncPolicy — debounce / interval / on-change scheduling for bundle adapters

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-10
- **Milestone:** v0.12.0
- **Labels:** type: feature, area: core

---

## Target package

`@noy-db/core`

## Spawned from

Discussion #95 — Sync scheduling. Full scheduling matrix, UX trade-offs, and rate-limit rationale live in the discussion.

## Problem

Per-record adapters (`s3`, `dynamo`, `file`) push on every write cheaply because each write is one small object. Bundle adapters (`drive` and friends — #94, v0.11) cannot — every push re-uploads the entire compartment. The current `SyncEngine` dirty-tracks and flushes on consumer-driven events, which is the wrong default for bundle adapters: active editing would re-upload the same 40 MB twenty times in a minute.

Sync scheduling currently sits implicitly inside the adapter or inside consumer code. For bundle adapters to land (#94, v0.11) there needs to be a first-class scheduling policy in core that adapters can declare their preferred default for.

## Scope

- **`syncPolicy` as a first-class option on `createNoydb()`:**
  ```ts
  const db = await createNoydb({
    auth: { ... },
    sync: driveAdapter({ ... }),
    syncPolicy: {
      push: {
        mode: 'debounce',          // 'manual' | 'debounce' | 'interval' | 'on-change'
        debounceMs: 30_000,
        minIntervalMs: 120_000,
        onUnload: true,
      },
      pull: {
        mode: 'interval',          // 'manual' | 'interval' | 'on-focus'
        intervalMs: 300_000,
      },
    },
  })
  ```

- **Four push modes**: `manual`, `debounce`, `interval`, `on-change` (default for per-record adapters).
- **Three pull modes**: `manual`, `interval`, `on-focus` (fetch on `visibilitychange → visible`).
- **Adapter-declared defaults** — each adapter exposes a `defaultSyncPolicy` so consumers don't have to know the right numbers. `drive()` defaults to debounce + interval; `s3()` defaults to on-change + manual pull.
- **`onUnload` flag** — forced push on `visibilitychange → hidden` / `pagehide`, using `navigator.sendBeacon` where available and best-effort async fetch otherwise. This is the safety net against losing work when the tab closes during the debounce window.
- **Reactive status surface** — `db.syncStatus` ref exposes `{ state: 'idle' | 'pending' | 'pushing' | 'error', lastPushAt, lastError, pendingWrites }` for UI consumption. \"syncing\" / \"all saved\" spinners read from this.
- **Rate-limit budget awareness** — the policy can be queried for \"can I push now?\" before kicking off a push, so adapters can surface quota-aware backoff to the consumer.

## Non-goals

- CRDT sync semantics — separate v0.9 work
- Conflict policies — separate v0.9 work
- Per-collection sync policies — single policy per instance in v1

## Acceptance

- [ ] `SyncPolicy` type exported from `@noy-db/core`
- [ ] `createNoydb({ syncPolicy })` accepts all four push modes + three pull modes
- [ ] `defaultSyncPolicy` extension point on the adapter interface; per-record adapters default to `on-change`, bundle adapters to `debounce`
- [ ] `onUnload` push fires on `pagehide` / `visibilitychange → hidden` in browser; `beforeExit` in Node
- [ ] `db.syncStatus` reactive ref matches v0.3 reactive query conventions
- [ ] `minIntervalMs` enforces a hard floor between pushes regardless of mode
- [ ] Tests: debounce coalescing, minIntervalMs floor, onUnload firing, status-ref transitions, adapter default selection
- [ ] Changeset (`@noy-db/core: minor`)
- [ ] Full turbo pipeline green

## Invariant compliance

- [x] No crypto changes
- [x] Adapters never see plaintext — scheduling is a timing concern, not a data concern
- [x] Optimistic concurrency unchanged

## Related

- Discussion #95 (source)
- #94 — @noy-db/drive (consumes this, both land in adapter-expansion timeframe)
- Discussion #93 — bundle adapter shape (#93 will be filed as an issue, consumes this)

v0.9.0.
