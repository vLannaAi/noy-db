# Issue #158 — feat(core): multi-backend topology — SyncTarget[] with role and per-target policy

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-10
- **Milestone:** v0.12.0
- **Labels:** type: feature, area: core, area: adapters

---

Formalises the multi-backend topology proposed in discussion #137.

## Problem

The current API has a hard primary + one sync topology:

```ts
const db = await createNoydb({
  store:  jsonFile({ dir: './data' }),
  sync:   dynamo({ table: 'myapp' }),
})
```

This breaks down as soon as a consumer wants more than one secondary — e.g. DynamoDB as live sync peer **and** S3 as a periodic archive, or a bundle drop to Google Drive **and** a Git commit for audit trail.

## Proposed API

```ts
export interface SyncTarget {
  store:    NoydbStore
  role:     'sync-peer' | 'backup' | 'archive'
  policy?:  SyncPolicy   // inherits adapter-category default when absent
  label?:   string       // DevTools + audit log label
}

// NoydbOptions.sync becomes:
interface NoydbOptions {
  store:       NoydbStore
  sync?:       NoydbStore | SyncTarget | SyncTarget[]  // backward-compat overload
  syncPolicy?: SyncPolicy
}
```

Passing a bare `NoydbStore` keeps working — core wraps it as `{ store, role: 'sync-peer', policy: defaultPolicyFor(store) }`.

## Role semantics

| Role | Direction | Conflict resolution | Typical use |
|---|---|---|---|
| `sync-peer` | Bidirectional | Yes — ConflictStrategy applies | DynamoDB live sync |
| `backup` | Push-only | N/A — receives already-merged state | S3 nightly dump, Google Drive |
| `archive` | Push-only, append intent | N/A | IPFS, Git tags, S3 Object Lock |

## Default policy per store category

| Category | Examples | Default push | Default pull |
|---|---|---|---|
| Indexed (per-record) | dynamo, postgres, firestore | `'on-change'` | `'on-open'` |
| Bundle (whole-vault) | drive, webdav, git | `'debounce'` 30s/2min floor | `'interval'` 60s |

## Write fanout

1. Write to primary store. Fail immediately on error — do not fanout.
2. Mark all sync targets dirty. **Do not block `put()` on secondary writes.**
3. Each target's scheduler fires its push per its own policy.

`put()` resolves when primary write completes. Callers needing secondary durability before proceeding: `await db.sync()`.

## Open questions (to resolve during implementation)

- Fanout failure handling: retry with jittered backoff up to `maxRetries`, then emit `'sync:backup-error'`.
- Per-target `conflict: ConflictStrategy` on `SyncTarget` (backup likely always `'local-wins'`).
- Pull order for multiple sync-peers: sequential (pull A, merge, pull B, merge, push once) to start.
- Core warning (not throw) when a bundle store is configured as `sync-peer` without explicit opt-in.

## Acceptance

- [ ] `NoydbOptions.sync` accepts `NoydbStore | SyncTarget | SyncTarget[]`
- [ ] Bare `NoydbStore` backward-compat preserved
- [ ] Role semantics enforced: `backup` / `archive` targets never pulled from
- [ ] Per-target policy overrides global `syncPolicy`
- [ ] Default policy assigned by store category when `policy` absent
- [ ] `put()` does not block on secondary writes
- [ ] `db.sync()` awaits all targets
- [ ] `db.on('sync:backup-error', ...)` event for fanout failures
- [ ] Tests: primary failure aborts (no fanout), backup failure emits event (does not throw), archive push appends not overwrites
- [ ] Changeset for `@noy-db/hub`

## Related

- Discussion #137 — full design rationale and open questions
- #101 — `syncPolicy` scheduling (building block used here)
- #103 — `NoydbBundleAdapter` interface (archive targets)
- #154 — runtime monitor (multi-target health tracking)
- #158 — wizard multi-backend setup
- #159 — store-probe multi-backend support
