# Milestone 44 — Transactions: atomic commit delegation [internal] — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `db.transaction(fn)` commits through one `store.tx(ops)` call (true all-or-nothing) when the store declares `txAtomic` and the batch is statically safe; everything else keeps today's per-record OCC path byte-for-byte.

**Architecture:** Split `Collection._putInternal` and `Collection._doDelete` each into an @internal *prepare* half (produces the encrypted envelope, zero observable side effects) and a *commit* half (history snapshot → store write → `#commitWriteTail`). `runTransaction` Phase 2 gains an eligibility-gated atomic branch: prepare every op, submit one `store.tx(ops)`, then run each op's finalize (history/ledger/cache/events) in staged order. Ineligible batches take the existing OCC path with **no behaviour change**.

**Tech Stack:** TypeScript, pnpm + turbo, vitest, tsup. All work in `packages/hub` (+ one conformance note); docs land later in the sibling noy-db-docs repo (#907).

## Global Constraints

- **Never** add Claude attribution to commits/PRs/CHANGELOGs (family-wide rule).
- **Never** publish; changesets are authored but release requires explicit user go-ahead.
- `packages/hub/src/kernel/collection.ts` ceiling: **4264** (currently 4263 — 1 line of slack). Every task touching it must end with `pnpm check:architecture` green; fund growth by reflow first, bump with a precedent-style justification comment only for the genuinely-core delta.
- Hub stays portable: no Node built-ins, `crypto.subtle` only, no new npm deps.
- `db.transaction(fn)` keeps its exact public signature. No new subpath, no barrel export — everything new is `@internal`.
- TDD: red test → minimal code → green → commit, per task.
- Run guards before each commit that touches structure: `pnpm check:architecture`, and `pnpm --filter @noy-db/hub test` at minimum; full `pnpm test` before the PR.

---

## The settled design (#893)

This section is the design deliverable for issue #893. Task 1 posts it to the issue.

### 1. The seam

Two @internal method pairs on `Collection`:

- `_preparePut(id, record, options) → PreparedPut<T>` — runs the seven pre-envelope stages exactly as today (`dispatchGate('beforePut')` → `via.enforceWrite` → computed fields → schema → `via.encodeWrite` → `enforceRefsOnPut` → prior/version resolution → unique-constraint check → CEK resolve → vdig read → `codec.encryptRecord`). Ends holding the encrypted envelope. **Guarantee: no store write, no cache/index mutation, no history entry, no ledger append, no event.** Gate dispatch and ref checks may *read* the store and may *throw* — that is prepare's job (reject before anything commits).
- `_commitPut(prepared) → void` — `#savePriorHistory` → `adapter.put` → `markerIds.delete` → `#commitWriteTail`. The atomic path calls a third entry, `_finalizePut(prepared)`, which is `_commitPut` minus the `adapter.put` (the store write already happened inside `tx()`).
- `_prepareDelete(id, internal) → PreparedDelete<T> | null` / `_commitDelete(prepared)` / `_finalizeDelete(prepared)` — same shape, kept **separate** from the put split per #842(c): hydrate, the history-read gate, and the #589 marker/envelope-reuse rules each interact with "produce now, commit later" differently. `null` means the early-return cases (no live record / already marker / elevated-internal) — the op is a no-op, exactly as today's `return false`.

`PreparedPut` / `PreparedDelete` interfaces live in a **new type-only file `packages/hub/src/kernel/prepared-write.ts`** (not under the kernel-surface ceiling; erases at runtime):

```ts
/** @internal Everything `_commitPut` needs after `_preparePut` produced the envelope. */
export interface PreparedPut<T> {
  readonly id: string
  readonly envelope: EncryptedEnvelope
  readonly version: number
  /** Record as caches/indexes/ledger-delta see it. */
  readonly indexed: T
  /** Record as `_onRecordMutated` reports it (drives events). */
  readonly event: T
  readonly prior: { record: T; version: number } | undefined
  readonly cek: EnclaveKey | undefined
  readonly vdigCtx: { id: string; prev: EncryptedEnvelope | null } | undefined
  readonly reason: string | undefined
}

/** @internal Everything `_commitDelete` needs. `marker` set ⇒ sync-mode delete (a put of the marker). */
export interface PreparedDelete<T> {
  readonly id: string
  readonly internal: boolean
  readonly existing: { record: T; version: number } | undefined
  readonly previousEnvelope: EncryptedEnvelope | null
  readonly previousPayloadHash: string
  readonly marker: EncryptedEnvelope | undefined
  readonly markerVersion: number | undefined
}
```

**One deliberate micro-reorder on the non-tx path:** today `#savePriorHistory` runs *before* `codec.encryptRecord`; after the split it runs after (inside commit). The real invariant — "a history failure leaves no write behind", i.e. history-before-`adapter.put` — is preserved. The only observable change is the encrypt-throws failure path, where today an orphan history snapshot is left behind; post-split it isn't. That is a strict improvement, called out in the changeset.

The **CRDT branch stays inline** in `_putInternal` untouched — CRDT collections never take the atomic path (see gate), and their merge-then-write shape doesn't decompose the same way.

### 2. The dynamic op set — eligibility gate (option (b), conservative)

"Will this batch trigger extra writes" is answerable up front (O(1) registry lookups: `strategiesForSource`, `mvsForSource`); "what op set it produces" is not (`triggerBy` fan-out and array-shape outputs require running `derive()`). And sequential Phase 2 gives intra-batch *visibility* that batch-prepare cannot (op 2's ref check / unique check / version chain seeing op 1's write). So the atomic path is taken **only when every condition holds**, else the OCC path runs unchanged:

1. `db._store.capabilities?.txAtomic === true && typeof db._store.tx === 'function'` (both, mirroring #892's gate — an undeclared `tx()` is never used).
2. Not amendment mode (`ctx._amendment === false`). Amendment's guard-registry collect/consume windows assume per-op execution; excluding it keeps the drain sites untouched.
3. No duplicate `(vault, collection, id)` among `ctx._ops` — batch-prepare cannot give op N read-your-write of op N−1 (version chains, CRDT merge, unique/ref visibility all assume it).
4. For every touched collection:
   - no derivation or MV source registered (**any** lifecycle — lazy stale-marking and the MV registration-order hole make "eager only" a trap; conservative is honest),
   - not CRDT mode,
   - no unique constraints declared (intra-batch conflicts are only caught by sequential apply),
   - no refs declared on the write direction (put-refs for puts, inbound/cascade refs for deletes — a batch where op 2 references op 1's insert would falsely reject under batch-prepare, and cascade expands the op set).
5. `txInvariants` and commit-time changeset invariants **stay allowed**: they already run after Phase 2 and revert on failure; under the atomic path the revert is itself atomic (#892), so semantics only improve.

The gate lives in `packages/hub/src/with-commit/tx/atomic-eligibility.ts` (service side, not kernel). It consults one new terse @internal `Collection` accessor (`_txAtomicBlockers(opType): true|false`-style predicate) so the service never reaches into private kernel state.

**Fallback framing (from #906, adopted verbatim):** the OCC fallback "is not a compromise to apologise for: it is the only honest option while the op set can grow during execution."

### 3. Audit ordering

Under the atomic path, per staged op **in declaration order, after `tx()` succeeds**: history snapshot → ledger append → cache/index maintenance → change event → `onDirty`. This is a real ordering change (today they interleave per op *during* execution) and gets an explicit test, not an assumption. Embedding `_vec` sidecars also land in finalize (they were never OCC-protected anyway).

### 4. Failure semantics

- `tx()` throws → **nothing was applied**; rethrow (ConflictError from store CAS surfaces as-is). No unwind, no ledger entries, no events — assert the store is byte-identical to pre-transaction state.
- A finalize-loop throw (e.g. ledger append fails) → data is already committed, so fall into the existing Phase-3 `revertExecuted` (which #892 already makes atomic on these stores) and rethrow. `ctx._executed` is therefore still populated per-op (with priors) on the atomic path *before* `tx()` is submitted. Audit artifacts from earlier finalized ops may remain — same best-effort class as today, documented.
- `TxOp.expectedVersion` is set on every op (`prior._v ?? 0` for puts; `live._v` for deletes) so the store re-validates CAS atomically at commit — closing the Phase-1→Phase-2 concurrent-writer window that the OCC path leaves open.

### 5. The collection.ts ceiling

The prepared shapes and any pure helpers go in `kernel/prepared-write.ts` (non-ceilinged). The split itself restructures existing lines; expected net growth in `collection.ts` is the new signatures + doc comments (~+30–60). Execute as: reflow-fund what's cheap, then **bump the ceiling by the measured net with a precedent-style justification comment** ("prepare/commit split of the two kernel write paths — the seam #893 settled; envelope-production and side-effect halves must both live beside the private state they share"). A genuinely-core write-path seam is exactly what the ratchet's "if the growth is genuinely core, raise with justification" clause is for.

### 6. Out of scope / follow-ups (file, don't build)

- `putManyAtomic` delegation (same seam, second consumer) — follow-up issue after #906 lands.
- noy-db-to: **to-cloudflare-d1's `tx()` silently ignores `expectedVersion`** (violates the `TxOp` contract's MUST); to-turso's batch path likewise, and its `txAtomic` is client-conditional. File one issue per store in noy-db-to. The conformance harness only tests tx-liveness, never rollback/CAS — a harness-hardening issue in noy-db (would currently fail D1/turso, hence cross-repo, hence not in this milestone).
- Stale changelog copy-paste: to-file/to-browser-idb CHANGELOGs claim `txAtomic` they don't have — fold a correction into the milestone PR or the noy-db-to issue sweep.
- The `NoydbStore.tx` JSDoc "native implementations" list is stale (claims to-dynamo/to-browser-idb) — fix it in Task 5 while touching the delegation comment it sits next to.

---

### Task 1: Settle #893 — post the design, close the issue

**Files:** none in-repo (GitHub only). The design text is the section above.

**Interfaces:** Produces the go-ahead for Tasks 2–6; later tasks quote the gate conditions and seam names (`_preparePut`, `_commitPut`, `_finalizePut`, `_prepareDelete`, `_commitDelete`, `_finalizeDelete`, `PreparedPut`, `PreparedDelete`).

- [ ] **Step 1: Post the design comment on #893** — the full "The settled design" section above, via `gh issue comment 893 -R vLannaAi/noy-db --body-file <extract>`.
- [ ] **Step 2: Close #893** as completed with a closing note that #904/#905/#906 are now unblocked and carry the execution: `gh issue close 893 -R vLannaAi/noy-db -c "Design settled — see the design comment. #904/#905/#906 unblocked."`
- [ ] **Step 3: Remove the `blocked` label from #904 and #905** (`gh issue edit 904 905 -R vLannaAi/noy-db --remove-label blocked`). #906 stays `blocked` until Tasks 2–3 land.

### Task 2: `_preparePut` / `_commitPut` split (#904)

**Files:**
- Create: `packages/hub/src/kernel/prepared-write.ts`
- Modify: `packages/hub/src/kernel/collection.ts:1824-2055` (`_putInternal`)
- Test: `packages/hub/__tests__/tx/prepare-commit-put.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Collection._preparePut(id: string, record: T, options?): Promise<PreparedPut<T>>`, `Collection._commitPut(prepared: PreparedPut<T>): Promise<void>`, `Collection._finalizePut(prepared: PreparedPut<T>): Promise<void>` (commit minus `adapter.put`), and the `PreparedPut<T>` type from `prepared-write.ts`. `_putInternal`'s body becomes `await this._commitPut(await this._preparePut(id, record, options))` for the non-CRDT path; the CRDT branch stays inline and untouched.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/hub/__tests__/tx/prepare-commit-put.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { toMemory } from '../../../to-memory/src/index.js'
import { createNoydb } from '../../src/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import type { Noydb } from '../../src/index.js'

interface Doc { n: number }

describe('#904 — _preparePut / _commitPut split', () => {
  let db: Noydb
  beforeEach(async () => {
    db = await createNoydb({
      store: toMemory(),
      user: 'owner',
      historyStrategy: withHistory(),
    })
    await db.openVault('v')
  })

  it('prepare-without-commit leaves store, cache, history and event stream untouched', async () => {
    const coll = db.vault('v').collection<Doc>('docs')
    await coll.put('seed', { n: 1 })
    const events: unknown[] = []
    coll.subscribe(e => events.push(e))
    const store = db._store
    const before = JSON.stringify(await store.list('v', 'docs'))
    const eventsBefore = events.length

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._preparePut('seed', { n: 2 })
    expect(prepared.envelope).toBeDefined()
    expect(prepared.version).toBe(2)

    expect(JSON.stringify(await store.list('v', 'docs'))).toBe(before)   // store untouched
    expect(await coll.get('seed')).toEqual({ n: 1 })                     // cache untouched
    expect((await coll.history('seed')).length).toBe(0)                  // no history entry
    expect(events.length).toBe(eventsBefore)                             // no events
  })

  it('prepare → commit behaves identically to a single put (_v, _ts, history, events)', async () => {
    const coll = db.vault('v').collection<Doc>('docs')
    await coll.put('a', { n: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._preparePut('a', { n: 2 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (coll as any)._commitPut(prepared)

    const env = await db._store.get('v', 'docs', 'a')
    expect(env?._v).toBe(2)
    expect(await coll.get('a')).toEqual({ n: 2 })
    const hist = await coll.history('a')
    expect(hist.length).toBe(1) // the v1 snapshot, same as a plain second put
  })
})
```

Adjust `history()` / `subscribe` call shapes to the real Collection API while writing (check neighbours in `__tests__/`); the assertions are the contract.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run packages/hub/__tests__/tx/prepare-commit-put.test.ts` → FAIL (`_preparePut is not a function`).
- [ ] **Step 3: Create `prepared-write.ts`** with the `PreparedPut` interface from the design section (imports: `EncryptedEnvelope` from `./types.js`, `EnclaveKey` from wherever `resolveRecordCek`'s return type lives — check `collection.ts` imports).
- [ ] **Step 4: Split `_putInternal`.** Mechanical rules:
  - `_preparePut` = lines from the permission check through `codec.encryptRecord(...)` inclusive, minus the CRDT branch (which `_putInternal` keeps, guarded exactly as today) and **minus `#savePriorHistory`** (moves to commit — the design's sanctioned micro-reorder). Returns the `PreparedPut`.
  - `_commitPut` = `if (prepared.prior) #savePriorHistory(...)` → `adapter.put` → `markerIds.delete(id)` → `#commitWriteTail({...})`.
  - `_finalizePut` = `_commitPut` minus the `adapter.put` + `markerIds.delete` still runs. Implement as `_commitPut(prepared, { persist = true })` internally if that's fewer lines — the two public @internal names can be thin delegates; pick whichever keeps the ceiling delta smaller.
  - `_putInternal` (non-CRDT) becomes the two calls.
- [ ] **Step 5: Run the new test + the sensitive suites** — `pnpm vitest run packages/hub/__tests__/tx/prepare-commit-put.test.ts` then `pnpm --filter @noy-db/hub test` (the full suite IS the regression test for "non-transactional path unchanged"; pay attention to via/CRDT/refs/classified/derivations suites).
- [ ] **Step 6: Ceiling + guards** — `pnpm check:architecture`. Reflow-fund; if net growth remains, bump `collection.ts` ceiling in `scripts/check-architecture.mjs` with a justification comment in the established style, citing #893/#904.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(hub): split Collection._putInternal into prepare/commit halves (#904)"`

### Task 3: `_prepareDelete` / `_commitDelete` split (#905)

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts:2419-2580` (`_doDelete`), `packages/hub/src/kernel/prepared-write.ts` (add `PreparedDelete`)
- Test: `packages/hub/__tests__/tx/prepare-commit-delete.test.ts`

**Interfaces:**
- Consumes: `prepared-write.ts` from Task 2.
- Produces: `Collection._prepareDelete(id: string, internal: boolean): Promise<PreparedDelete<T> | null>` (null ⇔ today's early `return false` paths), `Collection._commitDelete(prepared): Promise<boolean>`, `Collection._finalizeDelete(prepared): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/hub/__tests__/tx/prepare-commit-delete.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { toMemory } from '../../../to-memory/src/index.js'
import { createNoydb } from '../../src/index.js'
import { withSync } from '../../src/with-sync/index.js'
import type { Noydb } from '../../src/index.js'

interface Doc { n: number }

describe('#905 — _prepareDelete / _commitDelete split', () => {
  let db: Noydb
  beforeEach(async () => {
    db = await createNoydb({ store: toMemory(), user: 'owner', syncStrategy: withSync() })
    await db.openVault('v')
  })

  it('prepare-without-commit leaves no marker visible to a reader', async () => {
    const coll = db.vault('v').collection<Doc>('docs')
    await coll.put('a', { n: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._prepareDelete('a', false)
    expect(prepared).not.toBeNull()
    expect(prepared.marker).toBeDefined() // sync is on ⇒ delete is a marker put
    expect(await coll.get('a')).toEqual({ n: 1 })
    const env = await db._store.get('v', 'docs', 'a')
    expect(env?._del).toBeUndefined() // no marker written
  })

  it('prepare → commit behaves identically to a single delete (marker version, ledger version)', async () => {
    const coll = db.vault('v').collection<Doc>('docs')
    await coll.put('a', { n: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._prepareDelete('a', false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (coll as any)._commitDelete(prepared)
    expect(result).toBe(true)
    expect(await coll.get('a')).toBeNull()
    const env = await db._store.get('v', 'docs', 'a')
    expect(env?._v).toBe(2) // marker minted at live._v + 1, exactly as today
  })

  it('prepare returns null for a missing record (no-op), matching today's `return false`', async () => {
    const coll = db.vault('v').collection<Doc>('docs')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (coll as any)._prepareDelete('ghost', false)).toBeNull()
  })
})
```

Check the delete-marker field name (`_del` vs the real `isDeleteMarker` predicate — import the helper if exported) while writing.

- [ ] **Step 2: Run to verify failure** — FAIL with `_prepareDelete is not a function`.
- [ ] **Step 3: Split `_doDelete`.** Prepare = permission/tier checks, gate dispatch, ref enforcement, `existing` resolution, `previousEnvelope` read + `previousPayloadHash`, the marker decision (`buildDeleteMarker(live._v + 1, ...)` built but **not written**; the no-live-record/tombstone/marker early-outs return `null`). Commit = history snapshot (moved here, order vs. marker-write preserved: history first, exactly as today) → marker `adapter.put` or `adapter.delete` → `markerIds.add` → ledger → cache/index → `_onRecordMutated` → the `!internal` MV/array-derivation/rollup dispatch. `_finalizeDelete` = commit minus the store write. `_doDelete` = `const p = await this._prepareDelete(id, internal); return p === null ? false : this._commitDelete(p)`.
- [ ] **Step 4: Run new test + the tombstone suites** — `pnpm vitest run packages/hub/__tests__/tx/prepare-commit-delete.test.ts` and every `delete-tombstone-*.test.ts` / `sync-tombstone-*.test.ts` file, then the full hub suite. The tombstone suites must pass **untouched** — if one needs editing, the split moved observable behaviour and must be redone.
- [ ] **Step 5: Ceiling + guards** — `pnpm check:architecture`; same fund-or-bump discipline as Task 2.
- [ ] **Step 6: Commit** — `git commit -m "feat(hub): split Collection._doDelete into prepare/commit halves (#905)"`

### Task 4: Atomic-path eligibility gate

**Files:**
- Create: `packages/hub/src/with-commit/tx/atomic-eligibility.ts`
- Modify: `packages/hub/src/kernel/collection.ts` (one terse @internal predicate)
- Test: `packages/hub/src/with-commit/tx/atomic-eligibility.test.ts` (or `__tests__/tx/` — match neighbours)

**Interfaces:**
- Consumes: `Collection` internals via the new accessor.
- Produces: `canCommitAtomically(db: Noydb, ctx: TxContext): boolean` implementing gate conditions 1–4 from the design (condition 5 needs no code — invariants simply aren't checked), and `Collection._txAtomicSafe(opType: 'put' | 'delete'): boolean` returning false when the collection has derivation/MV sources, CRDT mode, unique constraints, or refs on that direction.

- [ ] **Step 1: Write the failing tests** — one per gate condition:

```ts
// each test builds a db + staged TxContext and asserts canCommitAtomically(...)
it('true for a plain multi-collection batch on to-memory', ...)          // baseline
it('false when the store lacks txAtomic', ...)                            // toFile-like stub or capabilities-stripped wrapper
it('false when txAtomic declared but tx missing (out-of-tree store)', ...)
it('false in amendment mode', ...)
it('false when the batch touches the same (vault,coll,id) twice', ...)
it('false when a touched collection has a derivation registered', ...)    // withDerivation, lifecycle eager
it('false when a touched collection has a LAZY derivation registered', ...)
it('false for a CRDT collection', ...)
it('false when a touched collection declares unique constraints', ...)
it('false when a put touches a collection with refs declared', ...)
it('false when a delete touches a collection with inbound refs', ...)
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `_txAtomicSafe` on Collection (compose from the same registry lookups `describe()`'s `hasDerivedOutputs` uses at `collection.ts:4230`, plus `this.crdtMode`, `this.uniqueConstraints`, `this.refEnforcer` presence per direction) and `canCommitAtomically` (store bits + `!ctx._amendment` + duplicate-key scan over `ctx._ops` + per-collection `_txAtomicSafe`).
- [ ] **Step 4: Green + ceiling + guards** (the Collection accessor is a handful of lines — reflow-fund it).
- [ ] **Step 5: Commit** — `git commit -m "feat(hub): atomic-commit eligibility gate for db.transaction (#906 prep)"`

### Task 5: `runTransaction` atomic branch (#906)

**Files:**
- Modify: `packages/hub/src/with-commit/tx/transaction.ts` (Phase 2, lines 379-428, + the module-header "does not yet delegate" paragraph), `packages/hub/src/kernel/types.ts:730-751` (fix the stale "native implementations" JSDoc list)
- Test: `packages/hub/__tests__/tx/atomic-commit.test.ts`

**Interfaces:**
- Consumes: `_preparePut`/`_finalizePut` (Task 2), `_prepareDelete`/`_finalizeDelete` (Task 3), `canCommitAtomically` (Task 4), `TxOp` from `kernel/types.js`.
- Produces: the user-visible guarantee. No signature changes anywhere.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/hub/__tests__/tx/atomic-commit.test.ts — the five verifications #906 names:
it('submits exactly ONE tx() call for an eligible batch on to-memory', ...)
  // wrap toMemory() counting tx/put/delete calls; assert calls === ['tx'] and no per-op put
it('a tx() failure leaves the store byte-identical to pre-transaction state', ...)
  // wrapper whose tx() throws after the hub prepared; deep-compare full store dump before/after;
  // assert NO ledger entries and NO change events fired
it('a store without txAtomic takes the OCC path unchanged', ...)
  // counting wrapper with capabilities stripped: assert per-op put calls, no tx call
it('an ineligible batch (derivation registered) takes the OCC path', ...)
it('history, ledger and change events fire per op in staged order AFTER the atomic commit', ...)
  // instrument: store-wrapper records commit time; subscribe records event times; assert every
  // event/ledger append happens after the tx() call returned, in ctx._ops order
it('every TxOp carries expectedVersion (concurrent writer between phases → ConflictError, nothing applied)', ...)
  // interleave a direct coll.put between body-return and commit via a store wrapper hook
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the branch.** Inside `db._setActiveTxContext(ctx)`'s try, before the existing loop:

```ts
if (canCommitAtomically(db, ctx)) {
  const preparedOps: Array<{ op: StagedOp; txOp: TxOp; prepared: PreparedPut<unknown> | PreparedDelete<unknown> | null }> = []
  for (const op of ctx._ops) {
    const coll = db.vault(op.vaultName).collection(op.collectionName)
    const prior = priorEnvelopes.get(keyOf(op)) ?? null
    ctx._executed.push({ op, priorEnvelope: prior })      // finalize-failure revert plan (design §4)
    if (op.type === 'put') {
      const prepared = await coll._preparePut(op.id, op.record, ...)
      preparedOps.push({ op, prepared, txOp: { type: 'put', vault: op.vaultName, collection: op.collectionName, id: op.id, envelope: prepared.envelope, expectedVersion: prior?._v ?? 0 } })
    } else {
      const prepared = await coll._prepareDelete(op.id, false)
      if (prepared === null) { ctx._executed.pop(); continue }   // no-op delete, same as today's return false
      preparedOps.push({ op, prepared, txOp: prepared.marker
        ? { type: 'put', vault: op.vaultName, collection: op.collectionName, id: op.id, envelope: prepared.marker, expectedVersion: prior?._v ?? 0 }
        : { type: 'delete', vault: op.vaultName, collection: op.collectionName, id: op.id, expectedVersion: prior?._v ?? 0 } })
    }
  }
  await store.tx(preparedOps.map(p => p.txOp))            // throws ⇒ nothing applied ⇒ plain rethrow
  for (const { op, prepared } of preparedOps) {           // finalize in staged order (design §3)
    const coll = db.vault(op.vaultName).collection(op.collectionName)
    if (op.type === 'put') await coll._finalizePut(prepared)
    else await coll._finalizeDelete(prepared)
  }
} else {
  /* existing per-op loop, unchanged */
}
```

Details to honor while implementing: prepare throws before `tx()` ⇒ nothing written, drop through to the existing catch (revert is a no-op on an empty write set — `ctx._executed` priors equal current state, and `bestEffortRevert` restoring priors is idempotent, matching today's record-plan-before-call convention); `tx()` throw ⇒ **skip** `revertExecuted` (nothing applied — rethrow directly, and assert in the test that no compensating writes happen); finalize throw ⇒ existing catch path (revert + amendment drain doesn't apply — amendment is gate-excluded); `writeQueue.track` wraps each op's prepare and finalize so `hub.writeQueue.pending` still reflects in-flight writes. Update the module-header crash-window paragraph — it is now conditional on store + eligibility — and fix the `NoydbStore.tx` JSDoc's stale store list.

- [ ] **Step 4: Green** — new suite + `pnpm --filter @noy-db/hub test`.
- [ ] **Step 5: Simulation harness** — `pnpm vitest run` in `test-harnesses/simulation-concurrent` (per #906's verify list) — must pass untouched.
- [ ] **Step 6: Guards + changeset** — `pnpm check:architecture && pnpm knip`; author the changeset (hub minor, pre-1.0 line): "db.transaction(fn) commits through one store.tx() batch on txAtomic stores when the batch is statically safe; OCC fallback otherwise (unchanged)."
- [ ] **Step 7: Commit** — `git commit -m "feat(hub): db.transaction commits through store.tx() on txAtomic stores (#906)"`

### Task 6: Milestone close-out — follow-up issues + docs handoff (#907)

**Files:** GitHub only (+ noy-db-docs later).

- [ ] **Step 1: File the cross-repo store issues** (from the design's §6): noy-db-to — "to-cloudflare-d1 tx() ignores TxOp.expectedVersion (contract violation)"; noy-db-to — "to-turso batch path ignores expectedVersion; txAtomic is client-conditional — document or fix"; noy-db — "adapter-conformance: behavioral tx() tests (rollback-on-failure, expectedVersion enforcement)" noting it will fail D1/turso until their fixes land. Also the stale to-file/to-browser-idb CHANGELOG claims.
- [ ] **Step 2: File the `putManyAtomic` follow-up** in noy-db: "delegate putManyAtomic through store.tx() — second consumer of the #893 seam", referencing the eligibility helper.
- [ ] **Step 3: Un-block #907** and hand it its facts: comment on #907 with the exact guarantee wording (all-or-nothing on txAtomic stores **when the batch is statically safe** — no derivations/MVs, no CRDT, no unique constraints, no refs, no duplicate ids, not amendment mode; per-record OCC with best-effort unwind otherwise) and the per-store readiness table (memory/postgres/mysql/sqlite/supabase full; d1/turso caveated until their issues fix). Per #907: "A guarantee with a silent exception is worse than a narrower guarantee stated clearly." The docs work itself executes in noy-db-docs per that repo's workflow (llms corpus regen + freshness gates).
- [ ] **Step 4: PR** — branch, push, open the PR for Tasks 2–5's commits (no attribution footer), milestone 44, closes #904/#905/#906.

---

## Self-review notes

- **Spec coverage:** #893 → design section + Task 1; #904 → Task 2; #905 → Task 3; #906 → Tasks 4–5 (all five of its verify bullets appear in Task 5's tests + Step 5); #907 → Task 6 Step 3 (docs execute in the sibling repo, as the issue itself specifies). Milestone-description gates (design first, ceiling call) → design §2/§5, executed before any split starts.
- **Known intentional deviations, called out above:** the history-save/encrypt micro-reorder (§1); audit-ordering change under the atomic path (§3, tested not assumed); tx-throw skips revert (nothing applied).
- **Type consistency:** seam names (`_preparePut`/`_commitPut`/`_finalizePut`, `_prepareDelete`/`_commitDelete`/`_finalizeDelete`, `PreparedPut`/`PreparedDelete`, `canCommitAtomically`, `_txAtomicSafe`) are used identically across Tasks 2–5.
- **Honesty check on test code:** exact Collection API shapes (`history()`, `subscribe`, marker field predicates) must be confirmed against neighbours at implementation time; the assertions are the contract, the call shapes are indicative.
