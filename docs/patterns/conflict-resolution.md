# Pattern — sync conflicts: pick a policy, handle the edge cases

> **TL;DR** — `@noy-db/hub` has pluggable sync-conflict resolution
> since v0.9. Pass `conflictPolicy` when declaring a collection.
> Four strategies ship built-in: `'last-writer-wins'`,
> `'first-writer-wins'`, `'manual'` (emit event, you decide), or a
> custom `(local, remote) => merged` function. Conflicts only fire
> during sync `push` / `pull` — local CAS races throw `ConflictError`
> as always. This doc is the cookbook; types were in JSDoc, no
> user-facing guide existed until now.

---

## The 60-second pattern

```ts
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

const db = await createNoydb({ store: memory(), passphrase: 'demo' })
const vault = await db.openVault('acme')

// Option 1 — built-in string strategy
const invoices = vault.collection<Invoice>('invoices', {
  conflictPolicy: 'last-writer-wins',  // envelope with newer _ts wins
})

// Option 2 — custom merge function (decrypted T in, merged T out)
const notes = vault.collection<Note>('notes', {
  conflictPolicy: (local, remote) => ({
    ...local,
    text: `${local.text}\n\n---\n\n${remote.text}`,   // Concat bodies
    version: Math.max(local.version, remote.version) + 1,
  }),
})

// Option 3 — surface to UI, human picks
const urgent = vault.collection<Ticket>('urgent', { conflictPolicy: 'manual' })
db.on('sync:conflict', ({ id, local, remote, resolve }) => {
  const winner = await askUser(id, local, remote)
  resolve?.(winner === 'local' ? local : remote)
})

await db.pull('acme')  // triggers resolver on conflicts
```

## When does a conflict actually fire?

| Event | Does it invoke the resolver? |
|-------|------------------------------|
| Local two-writer race on the same device | ❌ — throws `ConflictError` at the `put` call (optimistic-lock mismatch) |
| `push` — local `_v` older than remote | ✅ — the resolver is called |
| `pull` — remote `_v` newer than a locally-dirty record | ✅ — the resolver is called |
| `pull` — remote newer than local, local NOT dirty | ❌ — remote just wins cleanly (no conflict, local updates) |
| `pushFiltered` (partial sync) | ✅ — same rules as `push` |

The resolver is a **merge point for parallel histories**, not a
generic write-collision handler. Local races are the caller's job.

## The four built-in strategies

### 1. `'last-writer-wins'` (timestamp-based)

```ts
conflictPolicy: 'last-writer-wins'
```

The envelope with the larger `_ts` wins. Simple and predictable, but
assumes devices have reasonably-synced clocks. Clock skew of seconds
is fine; skew of days will silently pick the wrong winner.

Good for: notes, drafts, single-user-across-devices scenarios.

### 2. `'first-writer-wins'` (version-based, monotonic)

```ts
conflictPolicy: 'first-writer-wins'
```

The envelope with the *lower* `_v` wins. Useful when the first-saved
version should be canonical and later attempts to rewrite are treated
as conflicts to be discarded.

Good for: append-only logs, immutable-after-submission records.

### 3. `'manual'` (emit event, you resolve)

```ts
conflictPolicy: 'manual'
```

The sync engine emits `'sync:conflict'` with a `resolve(winner)`
callback. The record stays in a conflicted state until the handler
calls `resolve()`. Two ways to provide the winner:

**Synchronous — pick one side:**
```ts
db.on('sync:conflict', ({ id, local, remote, resolve }) => {
  resolve?.(local)   // Keep local
  // or: resolve?.(remote)
  // or: resolve?.(null) — defer, conflict stays queued, try again next sync
})
```

**Asynchronous — surface to UI:**
```ts
db.on('sync:conflict', async ({ id, collection, local, remote, resolve }) => {
  const choice = await openConflictModal(id, collection)
  resolve?.(choice === 'local' ? local : remote)
})
```

Good for: human-authority records (manual ticket assignments, policy
overrides, anything where "make the UI show it to a person" is the
right answer).

### 4. Custom merge function `(local: T, remote: T) => T`

```ts
conflictPolicy: (local, remote) => ({
  id: local.id,
  amount: Math.max(local.amount, remote.amount),
  tags: [...new Set([...local.tags, ...remote.tags])],
  notes: local.notes || remote.notes,
  updatedAt: new Date().toISOString(),
})
```

The function sees decrypted records (not envelopes). Return value is
re-encrypted and assigned `_v = max(local._v, remote._v) + 1`. Use
for field-level merges.

Good for: additive data (sets, counters, append-only lists),
multi-field records where each field has its own merge rule.

## Default behaviour when `conflictPolicy` is omitted

Falls through to the **db-level `conflict` strategy** on
`createNoydb({ conflict: ... })`. Default of that is `'version'` —
remote wins if remote `_v` is newer, otherwise local wins. This is
silent (no event, no custom call). For most single-user scenarios
this is what you want.

```ts
// Explicit db-level fallback
const db = await createNoydb({
  store: memory(),
  passphrase: 'demo',
  conflict: 'version',  // default — remote-newer wins
})
```

Collection-level `conflictPolicy` overrides db-level `conflict` on a
per-collection basis.

## Multi-operator scenarios — the invoice example

Two accountants in different offices both edit invoice `01H5ABCD`
while offline. On reconnect, both sync. What happens depends on
policy choice:

```ts
// Office A — 10:00 — edits amount 1500 → 1700, notes += "client adjustment"
// Office B — 10:05 — edits status 'draft' → 'open', adds tags: ['urgent']

// LWW — Office B's write wins (later _ts) → amount still 1700? NO.
//       Whole envelope from B wins → amount stays 1500 (B never edited it),
//       status 'open', tags: ['urgent'], notes unchanged from pre-race.
//       A's amount change is LOST. ❌ Not what the firm wants.

// 'first-writer-wins' — A's write wins → status stays 'draft',
//                       tags missing. B's changes LOST. ❌

// Custom merge — handles both:
conflictPolicy: (local, remote) => ({
  ...local,
  ...remote,
  amount: local.amount !== remote.amount ? Math.max(local.amount, remote.amount) : local.amount,
  status: local.status !== 'draft' ? local.status : remote.status,  // Promote past draft
  tags: [...new Set([...(local.tags ?? []), ...(remote.tags ?? [])])],
  notes: [local.notes, remote.notes].filter(Boolean).join('\n---\n'),
})
// ✅ Both operators' changes preserved. _v bumped. Both devices converge.
```

For any multi-operator deployment: **either pick `'manual'` and build
a UI, or write a domain-aware merge function**. Don't ship LWW to
production unless you accept that concurrent edits lose data.

## Registering a resolver at envelope level

`CollectionConflictResolver` is the lower-level shape — takes
`EncryptedEnvelope`s (not decrypted records), returns one. Used
internally by the built-in policies; rarely needed in userland unless
you're doing something unusual (e.g., both-sides-wins: write two
separate records, return `null` from the resolver to defer).

```ts
type CollectionConflictResolver = (
  id: string,
  local: EncryptedEnvelope,
  remote: EncryptedEnvelope,
) => Promise<EncryptedEnvelope | null>
```

For the 99% case, stay with `conflictPolicy: (local, remote) => T`
— the library wraps your merge fn into a resolver for you.

## Events the sync engine emits

| Event | When | Payload |
|-------|------|---------|
| `'sync:push'` | After every `push()` call completes | `PushResult` with `pushed`, `conflicts: Conflict[]`, `status` |
| `'sync:pull'` | After every `pull()` call completes | `PullResult` with `pulled`, `conflicts`, `status` |
| `'sync:conflict'` | Only when `conflictPolicy: 'manual'` OR a custom resolver returns `null` | `Conflict { vault, collection, id, local, remote, localVersion, remoteVersion, resolve? }` |
| `'change'` | After every local put/delete (not remote pulls, that's `'sync:pull'`) | `ChangeEvent` |

The `PushResult.conflicts` / `PullResult.conflicts` arrays let you
audit or log every conflict regardless of policy. `'sync:conflict'`
is for interactive resolution only.

## Sync results — inspecting conflict outcomes

```ts
const result = await db.pull('acme')
if (result.conflicts.length > 0) {
  console.warn(`${result.conflicts.length} conflicts during pull:`)
  for (const c of result.conflicts) {
    console.warn(`  ${c.collection}/${c.id}: local v${c.localVersion} vs remote v${c.remoteVersion}`)
  }
}
```

This is independent of policy — even LWW and version-wins write to
`result.conflicts` for observability.

## Common pitfalls

### ❌ Expecting the resolver on local races

```ts
// Two tabs in one browser both put the same record:
await invoices.put(record)  // tab 1
await invoices.put(record)  // tab 2, throws ConflictError
// → resolver is NOT called. This is a CAS violation, not a sync conflict.
```

Local races are the *caller's* problem — catch `ConflictError`,
re-read, reconcile, retry. The resolver only fires when two *already-
committed* versions meet during sync.

### ❌ Forgetting `resolve?.()` in the `'manual'` handler

```ts
db.on('sync:conflict', ({ resolve }) => {
  console.log('conflict!')
  // Forgot to call resolve(...) → conflict stays queued, record stays stale
})
```

The `?` is because the `resolve` callback is only present on the
event when the sync engine is waiting. If you want manual handling
but also want a fallback when nobody listens, combine: set
`conflictPolicy: 'last-writer-wins'` as the base and emit your own
app-level conflict ticket from `PushResult.conflicts`.

### ❌ Merge functions with non-deterministic output

```ts
conflictPolicy: (local, remote) => ({
  ...local,
  ...remote,
  merged: Math.random() > 0.5 ? local.value : remote.value,  // ❌ different on every device
})
```

Two devices running the same merge on the same inputs must produce
the same output, or the conflict keeps re-emerging. Pure functions of
`(local, remote)` only.

### ❌ Per-call-site policies

The policy is set at `vault.collection()` declaration time. Changing
policy at runtime for a collection isn't supported — re-declare the
collection reference. If you need request-level policy, use
`'manual'` and branch in the handler.

## Cross-references

- **[`SPEC.md`](../../SPEC.md)** — search for "Pluggable conflict policies (v0.9 #131)"; the spec-level description.
- **[`packages/hub/__tests__/sync-conflict-policy.test.ts`](../../packages/hub/__tests__/sync-conflict-policy.test.ts)** — worked examples for every policy (LWW, FWW, manual, custom merge), including the two-office invoice scenario.
- **[`packages/hub/src/types.ts`](../../packages/hub/src/types.ts)** — `ConflictPolicy`, `CollectionConflictResolver`, `Conflict`, `ConflictStrategy` type definitions with JSDoc.
- **[`packages/hub/src/team/sync.ts`](../../packages/hub/src/team/sync.ts)** §`handleConflict` — the enforcement-point method in `SyncEngine`.

---

*Pattern doc last updated: 2026-04-21. Addresses [#244](https://github.com/vLannaAi/noy-db/issues/244) — types existed since v0.9; the gap was a readable cookbook.*
