# Discussion #95 — Sync scheduling: how often should a bundle adapter push and pull?

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **State:** closed
- **Comments:** 1
- **URL:** https://github.com/vLannaAi/noy-db/discussions/95

---

Per-record adapters (`s3`, `dynamo`, `file`) can push on every write cheaply because each write is one small object. Bundle adapters (`drive`, future `dropbox`/`icloud`) cannot — every push re-uploads the entire compartment. This changes the scheduling question from "when do we flush" to "how do we batch without losing work."

## Why this deserves its own discussion

Sync frequency sits at the intersection of three things the library currently handles implicitly:

1. **Cost.** Each Drive push is bandwidth, battery, and a slot against Drive's per-file write quota (Drive silently retains fewer revisions past ~500 writes/file). Over-syncing is wasteful and rate-limit hostile.
2. **Safety.** Under-syncing loses work when the tab dies, the battery dies, or the user closes the browser.
3. **UX.** A "syncing..." spinner that never stops destroys trust. An "all saved" badge that lies destroys trust harder.

For per-record adapters today, `SyncEngine` dirty-tracks and the consumer calls `db.sync()` manually or wires it to events. This works because per-record pushes are cheap. For bundle adapters it's the wrong default — firing on every mutation means uploading the same 40 MB twenty times in a minute of active editing.

## Proposed: `syncPolicy` as a first-class core concept

Move scheduling out of adapter-specific config and into `createNoydb()`:

```ts
const db = await createNoydb({
  auth: { ... },
  sync: drive({ ... }),
  syncPolicy: {
    push: {
      mode: 'debounce',          // 'manual' | 'debounce' | 'interval' | 'on-change'
      debounceMs: 30_000,        // wait 30s after last write before pushing
      minIntervalMs: 120_000,    // never push more than once every 2 minutes
      onUnload: true,            // forced push on visibilitychange→hidden / pagehide
      onIdle: true,              // push when tab goes idle > 60s (if dirty)
    },
    pull: {
      mode: 'interval',          // 'manual' | 'on-open' | 'interval' | 'on-focus'
      intervalMs: 60_000,        // ETag probe every 60s while visible
      onFocus: true,             // pull immediately when tab regains focus
      onOpen: true,              // pull on compartment open
      whileHidden: false,        // don't poll while tab is backgrounded
    },
    conflict: {
      strategy: 'retry-merge',   // 'retry-merge' | 'fail-fast'
      maxRetries: 3,
      backoffMs: [500, 2000, 8000],  // jittered
    },
  },
})
```

Default policy, adapter-aware:

- **Per-record adapters** get `{ push: 'on-change', pull: 'on-open' }` — current behavior.
- **Bundle adapters** get `{ push: 'debounce' (30s/120s), pull: 'interval' (60s) }` — the proposal above.

Consumers can override per-deployment. The defaults should make the common case correct without tuning.

## Why debounced push with a min-interval floor

Debounce-only ("push 30s after last write") has a failure mode: continuous edits defer the push forever. A user entering 50 invoices over 20 minutes in a steady cadence never flushes until they stop.

Min-interval floor ("but at least once every 2 minutes") fixes that. Worst-case latency between a write and its upload is `debounceMs + minIntervalMs = 2m30s` under continuous editing, `debounceMs = 30s` under bursty editing, and `0` under `onUnload`.

For accounting data — the current first consumer — 2m30s of exposure to a lost tab is acceptable. For real-time collaboration it wouldn't be, but real-time collaboration is not the NOYDB use case.

## Pull strategy: cheap probes, selective fetches

Pulls split into two operations:

1. **Probe** — `headVersion(handle)` returns the backend's opaque version token (Drive ETag / headRevisionId). Cheap: no body download, no decryption. Safe to run frequently.
2. **Fetch** — `pullBundle(handle)` only runs when the probe reports a version different from what we last loaded.

Default `intervalMs: 60_000` means one HEAD-equivalent per minute while the tab is visible. Drive's quota budget is thousands per day per user. Essentially free.

Pulls stop while the tab is backgrounded (`whileHidden: false` default) to save battery on mobile. Resume on `focus`/`visibilitychange`.

## Surfacing state to the UI

`useSync()` currently exposes `{ status, syncing, push, pull, sync }`. Bundle adapters need two more reactive fields:

```ts
interface UseSyncReturn {
  // existing
  status: Ref<SyncStatus>
  syncing: Ref<boolean>
  push: () => Promise<PushResult>
  pull: () => Promise<PullResult>
  sync: () => Promise<void>

  // new
  nextScheduledPush: Ref<Date | null>    // when the next debounced push fires
  lastPushError: Ref<Error | null>       // retry-visible error state
}
```

The scaffolder's default sync indicator should render:

- "All changes saved" when `dirty === 0 && !syncing`
- "Saving in 23s..." when `nextScheduledPush` is set
- "Saving..." when `syncing`
- "Failed to save — retrying" when `lastPushError` is set and retries are pending
- "Out of sync — reconnect required" when `drive:auth-required` has fired

This is small but high-value: the current `useSync` composable doesn't expose enough state to render a trustworthy indicator under a debounced push model.

## Open questions

1. **Service worker sync?** `navigator.serviceWorker.sync.register('noydb-sync')` could fire a push when connectivity returns after offline. Attractive for mobile. But: service worker runs in a context where the KEK is not available (no passphrase unlock). Probably defer to a follow-up.
2. **Per-collection policies?** A "drafts" collection might deserve faster sync than an "archive" collection. YAGNI until someone asks.
3. **Quiet hours?** Consumers in Thailand might not want their phones waking up to sync at 3am. Could default `pull.whileHidden: false` and document `push.onUnload` fires synchronously regardless.
4. **What counts as a "write" for debounce purposes?** Every `put`/`delete`? Also `grant`/`revoke`/`rotate`? Probably yes to all — any mutation that changes the bundle's bytes.

## Out of scope for this discussion

- The bundle adapter interface itself — sibling discussion.
- Drive-specific OAuth and token handling — sibling discussion.
- The `.noydb` format — sibling discussion.


> _Comments are not archived here — see the URL for the full thread._
