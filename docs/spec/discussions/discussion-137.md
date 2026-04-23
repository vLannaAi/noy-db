# Discussion #137 — Multi-backend topology: sync as an array with per-target role and policy

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **State:** open
- **Comments:** 0
- **URL:** https://github.com/vLannaAi/noy-db/discussions/137

---

## Background

The current `NoydbOptions` API has a hard `primary + one sync` topology:

```ts
const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),   // primary (one)
  sync:    dynamo({ table: 'myapp' }),    // secondary (one)
})
```

This works for the common case but breaks down as soon as a consumer wants more than one secondary — for example: DynamoDB as the live sync peer **and** S3 as a periodic archive, or a bundle drop to Google Drive **and** a Git commit for audit trail.

Related prior discussions:
- #93 — bundle adapter shape (`NoydbBundleAdapter` interface and `bundleAdapter()` shim)
- #95 — sync scheduling (`syncPolicy` as a first-class `createNoydb()` option)

This discussion is specifically about **topological expansion** (how many adapters, in what roles) and **per-target policy** (each target gets its own push/pull schedule and role semantics). The scheduling mechanics proposed in #95 become the building blocks used here.

---

## Proposed API shape

```ts
export interface SyncTarget {
  adapter: NoydbAdapter

  /**
   * - 'sync-peer'  — bidirectional; participates in conflict resolution
   * - 'backup'     — push-only; never pulled from
   * - 'archive'    — push-only, append-only intent (IPFS, Git tags, S3 Object Lock)
   */
  role: 'sync-peer' | 'backup' | 'archive'

  /** Per-target policy. When absent, inherits the adapter-category default. */
  policy?: SyncPolicy

  /** Human label for DevTools and audit log. Defaults to adapter.name. */
  label?: string
}

// NoydbOptions.sync becomes:
interface NoydbOptions {
  adapter:  NoydbAdapter
  sync?:    NoydbAdapter | SyncTarget | SyncTarget[]  // backward-compat overload
  syncPolicy?: SyncPolicy
}
```

Passing a bare `NoydbAdapter` to `sync` keeps working — core wraps it as `{ adapter, role: 'sync-peer', policy: defaultPolicyFor(adapter) }`.

---

## Default policy per adapter category

Defaults are adapter-category-aware (not a single global default):

| Category | Examples | Default push | Default pull |
|---|---|---|---|
| **Indexed** (per-record) | dynamo, postgres, firestore | `'on-change'` | `'on-open'` |
| **Bundle** (whole-compartment) | drive, webdav, icloud, git | `'debounce'` (30s / 2min floor) | `'interval'` (60s probe) |

Developer override example:

```ts
sync: [
  {
    adapter: dynamo({ table: 'live' }),
    role: 'sync-peer',
    // inherits indexed default
  },
  {
    adapter: s3({ bucket: 'archive' }),
    role: 'backup',
    policy: {
      push: { mode: 'interval', intervalMs: 6 * 60 * 60 * 1000 },  // every 6h
      pull: { mode: 'manual' },
    },
  },
  {
    adapter: bundleAdapter(gitAdapter({ repo: 'git@github.com:…' })),
    role: 'archive',
    label: 'weekly-git-snapshot',
    policy: {
      push: { mode: 'interval', intervalMs: 7 * 24 * 60 * 60 * 1000 },
      pull: { mode: 'manual' },
    },
  },
]
```

---

## Role semantics

### `'sync-peer'`
Bidirectional. Push + pull. Participates in conflict resolution (`ConflictStrategy` applies). One sync-peer is the recommended topology for v0.11; N-way peer sync is a v0.9 CRDT concern.

### `'backup'`
Push-only. Never pulled from. Conflicts structurally impossible — backup receives the already-merged primary state. Suitable for: periodic S3 dumps, nightly Google Drive drops, compliance copies.

### `'archive'`
Push-only, append-only intent. Writes tagged with monotonic sequence so nothing is overwritten. Practical difference from `'backup'` is semantic (immutable/versioned stores), not technically enforced by core.

---

## Write fanout semantics

1. Write to `adapter` (primary). Fail immediately if this throws — do not fanout.
2. Mark all sync targets dirty. **Do not block `put()` on secondary writes.**
3. Each target's scheduler fires its push according to its own policy.

`put()` resolves only when the primary write completes. Callers needing secondary durability before proceeding should `await db.sync()`.

---

## DevTools topology view (v0.10)

```
[primary: file]  ──→  [sync-peer: dynamo]   last sync: 12s ago  dirty: 0
                 ──→  [backup: s3]           last push: 2h ago   next: 4h
                 ──→  [archive: git]         last push: 3d ago   next: 4d
```

---

## Open questions

1. **Fanout failure handling.** If a `backup` push fails, does it retry silently or surface? Proposal: retry with jittered backoff up to `maxRetries`, then emit `'sync:backup-error'`. Consumer decides whether to surface.
2. **`sync` vs. `targets` rename.** Renaming is more accurate but breaks the public API. Overloading `sync` preserves backward compat. Lean toward keeping `sync`.
3. **Per-target conflict policy.** Should `SyncTarget` carry its own `conflict: ConflictStrategy`? Probably yes — a backup target likely always wants `'local-wins'` since it's never read back.
4. **Pull order for multiple sync-peers.** Sequential (pull A, merge, pull B, merge, push once) is safe and predictable. Parallel is correct but complex. Start sequential.
5. **`acknowledgeRisks` for unsuitable topologies.** Should core warn (not throw) when a bundle adapter is configured as sync-peer without explicit opt-in? See the companion discussion on the adapter probe utility for context.


