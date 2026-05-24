# `walkClosure` Primitive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the transitive-closure FK walker — the dependency root of the Transferable Partition Bundles epic (#201 part 2). Given seed predicates, it returns the set of `(collection, id)` tuples that must travel together to form a referentially-complete partition.

**Architecture:** A free function `walkClosure(vault, { seeds, maxDepth })` in a new `packages/hub/src/bundle/walk-closure.ts` module. It reads the existing per-vault `RefRegistry` (auto-derives the FK graph — no hand-written edge list) and enumerates decrypted records via the same `vault.collection(name).list()` path `checkIntegrity` uses (`vault.ts:1377`). Traversal is **two-phase**: inbound expansion from seeds (children travel with parents) to a fixed point, then outbound completion (pull referenced parents for FK validity) without re-expanding inbound from those parents. Fixed-point iteration with a seen-set; `maxDepth` caps runaway walks.

**Tech Stack:** TypeScript, Vitest, the `@noy-db/hub` package internals (`RefRegistry` from `refs.js`, `Vault` from `vault.js`).

---

## Epic context (read once)

This is **Plan 1 of the Transferable Partition Bundles epic** (spec: `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md`). The spec's §5 build order is revised here: `walkClosure` is the true dependency root (the extraction chain #202/#203 needs it; `setupNewVaultIdentity` is deferred to just before #208 because only owner-creation needs it). Subsequent plans, each its own PR:

1. **`walkClosure`** ← this plan (#201 part 2)
2. `describeExtraction` dry-run (#202)
3. `extractPartition` core + transfer seal (#203 + #206)
4. `carrySchemas` / `carryLedger` (#204 / #205)
5. `adoptPartition` (#207)
6. `setupNewVaultIdentity` refactor + `createOwnerOnAdoptedPartition` (#201 part 1 + #208)
7. transfer-seal cleanup (#209)

## File structure

- **Create:** `packages/hub/src/bundle/walk-closure.ts` — the walker (types + function). One responsibility: compute the closure. ~120 LOC.
- **Create:** `packages/hub/__tests__/walk-closure.test.ts` — tests. Reuses the `memory()` store harness pattern from `packages/hub/__tests__/refs.test.ts`.
- **Modify:** `packages/hub/src/errors.ts` — add `PartitionExtractionError` (used here for `maxDepth` exceeded; reused by later plans).
- **Modify:** `packages/hub/src/bundle/index.ts` — export `walkClosure` + its types (internal subpath; not re-exported from the root barrel yet).

## Pre-flight verification

- [ ] **Step 0: Confirm `_introspectState()` exposes `refRegistry`.**

Run: `grep -n "refRegistry" packages/hub/src/introspection/walk.ts`
Expected: the `VaultIntrospectState` interface includes a `refRegistry: RefRegistry` field. If it does NOT, add it to the interface and to the object returned by `Vault._introspectState()` (`vault.ts:2405`) — the field is `this.refRegistry`, already on the class (`vault.ts:258`). This is a one-line exposure, no behavior change.

---

## Task 1: Module scaffold + types + empty-seed base case

**Files:**
- Create: `packages/hub/src/bundle/walk-closure.ts`
- Test: `packages/hub/__tests__/walk-closure.test.ts`

- [ ] **Step 1: Write the failing test**

Add the harness + first test. Copy the `memory()` store factory verbatim from `packages/hub/__tests__/refs.test.ts` (lines 33–80) into the new test file.

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { walkClosure } from '../src/bundle/walk-closure.js'

// ── paste memory() factory from refs.test.ts here ──

interface Client { id: string; name: string; operatorUserId: string }
interface Bill { id: string; clientId: string; amount: number }

describe('walkClosure', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
  })

  it('returns an empty closure when no record matches the seed predicate', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('clients')
    await company.collection<Client>('clients').put('c-1', {
      id: 'c-1', name: 'Acme', operatorUserId: 'belle',
    })

    const result = await walkClosure(company, {
      seeds: { clients: () => false },
    })

    expect(result.closure.size).toBe(0)
    expect(result.graph.depth).toBe(0)
    expect(result.graph.cyclesDetected).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts -t "empty closure"`
Expected: FAIL — `Cannot find module '../src/bundle/walk-closure.js'` (or `walkClosure is not a function`).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/hub/src/bundle/walk-closure.ts
/**
 * Transitive-closure FK walker (#201). Computes the set of
 * (collection, id) tuples reachable from seed predicates, so a
 * partition extraction ships a referentially-complete subset.
 *
 * Two-phase, plaintext, read-only (runs inside the unlocked vault
 * session — see foundation §13.4 / spec invariant 7):
 *   1. INBOUND expansion: from selected records, pull every record
 *      that references them (children travel with parents), to a
 *      fixed point.
 *   2. OUTBOUND completion: pull every parent the selected set
 *      references (no dangling FKs), transitively, WITHOUT
 *      re-expanding inbound from those parents (bounds the closure).
 *
 * @module
 */
import type { Vault } from '../vault.js'

/** Seed predicate per collection. Records that return true become roots. */
export interface WalkClosureOptions {
  readonly seeds: Record<
    string,
    (record: Record<string, unknown>) => boolean | Promise<boolean>
  >
  /** Max fixed-point iterations before throwing. Default 16. */
  readonly maxDepth?: number
}

export interface ClosureResult {
  /** collection → set of record ids that travel together. */
  readonly closure: Map<string, Set<string>>
  readonly graph: {
    /** Fixed-point iterations the walk needed to converge. */
    readonly depth: number
    /** True if an edge pointed back to an already-selected node. */
    readonly cyclesDetected: boolean
  }
}

export async function walkClosure(
  vault: Vault,
  opts: WalkClosureOptions,
): Promise<ClosureResult> {
  const closure = new Map<string, Set<string>>()

  const add = (collection: string, id: string): boolean => {
    let set = closure.get(collection)
    if (!set) {
      set = new Set<string>()
      closure.set(collection, set)
    }
    if (set.has(id)) return false
    set.add(id)
    return true
  }

  // Phase 0: evaluate seed predicates.
  for (const [collectionName, predicate] of Object.entries(opts.seeds)) {
    const coll = vault.collection<Record<string, unknown>>(collectionName)
    const records = await coll.list()
    for (const record of records) {
      if (await predicate(record)) {
        const id = record['id']
        if (typeof id === 'string') add(collectionName, id)
      }
    }
  }

  return { closure, graph: { depth: 0, cyclesDetected: false } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts -t "empty closure"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/walk-closure.ts packages/hub/__tests__/walk-closure.test.ts
git commit -m "feat(hub): walkClosure scaffold + seed-predicate base case (#201)"
```

---

## Task 2: Seed selection + inbound expansion

**Files:**
- Modify: `packages/hub/src/bundle/walk-closure.ts`
- Test: `packages/hub/__tests__/walk-closure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('expands inbound: a seeded client pulls its bills, transitively', async () => {
  const company = await db.openVault('demo-co')
  const clients = company.collection<Client>('clients')
  const bills = company.collection<Bill>('bills', { refs: { clientId: ref('clients') } })
  const creditNotes = company.collection<{ id: string; billId: string }>(
    'creditNotes', { refs: { billId: ref('bills') } },
  )

  await clients.put('c-belle', { id: 'c-belle', name: 'Hotel A', operatorUserId: 'belle' })
  await clients.put('c-ann', { id: 'c-ann', name: 'Shop B', operatorUserId: 'ann' })
  await bills.put('b-1', { id: 'b-1', clientId: 'c-belle', amount: 100 })
  await bills.put('b-2', { id: 'b-2', clientId: 'c-ann', amount: 50 })
  await creditNotes.put('cn-1', { id: 'cn-1', billId: 'b-1' })

  const { closure } = await walkClosure(company, {
    seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
  })

  expect([...(closure.get('clients') ?? [])]).toEqual(['c-belle'])
  expect([...(closure.get('bills') ?? [])]).toEqual(['b-1'])       // not b-2 (ann's)
  expect([...(closure.get('creditNotes') ?? [])]).toEqual(['cn-1']) // transitive child
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts -t "expands inbound"`
Expected: FAIL — `closure.get('bills')` is undefined (no expansion yet).

- [ ] **Step 3: Write minimal implementation**

Replace the `return` at the end of `walkClosure` with a phase-1 worklist loop. Insert before the final `return`:

```ts
  const { refRegistry } = vault._introspectState()
  const maxDepth = opts.maxDepth ?? 16
  let depth = 0
  let cyclesDetected = false

  // Phase 1 — INBOUND expansion. Worklist of newly-added (collection,id)
  // whose children we still need to pull.
  let frontier: Array<[string, string]> = []
  for (const [c, ids] of closure) for (const id of ids) frontier.push([c, id])

  while (frontier.length > 0) {
    if (++depth > maxDepth) {
      throw new PartitionExtractionError(
        `walkClosure exceeded maxDepth=${maxDepth}; the FK graph may be ` +
          `unexpectedly deep or cyclic. Raise maxDepth or narrow the seeds.`,
      )
    }
    const next: Array<[string, string]> = []
    for (const [collectionName, id] of frontier) {
      // Which collections reference THIS collection, and via which field?
      for (const inbound of refRegistry.getInbound(collectionName)) {
        const childColl = vault.collection<Record<string, unknown>>(inbound.collection)
        const childRecords = await childColl.list()
        for (const child of childRecords) {
          if (String(child[inbound.field] ?? '') !== id) continue
          const childId = child['id']
          if (typeof childId !== 'string') continue
          if (add(inbound.collection, childId)) {
            next.push([inbound.collection, childId])
          } else {
            cyclesDetected = true
          }
        }
      }
    }
    frontier = next
  }

  return { closure, graph: { depth, cyclesDetected } }
```

Add the import at the top of the file:

```ts
import { PartitionExtractionError } from '../errors.js'
```

Delete the now-dead `return { closure, graph: { depth: 0, cyclesDetected: false } }` line from Task 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts`
Expected: FAIL — `PartitionExtractionError` is not yet defined (next task adds it). The "empty closure" test now expects `depth: 0` which still holds (empty frontier → loop never runs). If the import error blocks the run, do Task 3 first; ordering note: Task 3 (error type) and this task are coupled — commit them together if executing inline.

- [ ] **Step 5: (defer commit to Task 3 — coupled by the error import)**

---

## Task 3: `PartitionExtractionError`

**Files:**
- Modify: `packages/hub/src/errors.ts`
- Test: `packages/hub/__tests__/walk-closure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('throws PartitionExtractionError when maxDepth is exceeded', async () => {
  const company = await db.openVault('demo-co')
  const nodes = company.collection<{ id: string; parentId: string | null }>(
    'nodes', { refs: { parentId: ref('nodes', 'warn') } },
  )
  // A 5-deep chain: n0 <- n1 <- n2 <- n3 <- n4 (each parentId points up)
  await nodes.put('n0', { id: 'n0', parentId: null })
  for (let i = 1; i <= 4; i++) {
    await nodes.put(`n${i}`, { id: `n${i}`, parentId: `n${i - 1}` })
  }

  await expect(
    walkClosure(company, { seeds: { nodes: (n) => n['id'] === 'n0' }, maxDepth: 2 }),
  ).rejects.toThrow(PartitionExtractionError)
})
```

Add the import to the test file: `import { PartitionExtractionError } from '../src/errors.js'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts -t "maxDepth"`
Expected: FAIL — `PartitionExtractionError` is not exported from `../src/errors.js`.

- [ ] **Step 3: Write minimal implementation**

In `packages/hub/src/errors.ts`, add alongside the existing error classes (match the existing `NoydbError` subclass pattern — check an existing class like `RefIntegrityError`'s constructor signature first):

```ts
/**
 * Thrown by partition-extraction primitives (#198 epic) when the
 * transitive-closure walk fails — e.g. the FK graph is deeper than
 * `maxDepth`, signalling a runaway or unexpectedly cyclic graph.
 */
export class PartitionExtractionError extends NoydbError {
  constructor(message: string) {
    super('PARTITION_EXTRACTION', message)
    this.name = 'PartitionExtractionError'
  }
}
```

(Verify the `NoydbError` constructor takes `(code, message)` — confirm against an existing subclass in the same file; adjust if the signature differs.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts`
Expected: PASS (all of: empty closure, inbound expansion, maxDepth throw).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/walk-closure.ts packages/hub/src/errors.ts packages/hub/__tests__/walk-closure.test.ts
git commit -m "feat(hub): walkClosure inbound expansion + PartitionExtractionError (#201)"
```

---

## Task 4: Outbound completion (FK validity, no re-expansion)

**Files:**
- Modify: `packages/hub/src/bundle/walk-closure.ts`
- Test: `packages/hub/__tests__/walk-closure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('completes outbound parents without re-expanding their other children', async () => {
  const company = await db.openVault('demo-co')
  const entities = company.collection<{ id: string; name: string }>('entities')
  const clients = company.collection<Client & { entityId: string }>(
    'clients', { refs: { entityId: ref('entities') } },
  )
  const bills = company.collection<Bill>('bills', { refs: { clientId: ref('clients') } })

  await entities.put('e-1', { id: 'e-1', name: 'Group' })
  // Two clients share entity e-1; only c-belle is seeded.
  await clients.put('c-belle', { id: 'c-belle', name: 'Hotel', operatorUserId: 'belle', entityId: 'e-1' })
  await clients.put('c-ann',   { id: 'c-ann',   name: 'Shop',  operatorUserId: 'ann',   entityId: 'e-1' })
  await bills.put('b-1', { id: 'b-1', clientId: 'c-belle', amount: 100 })

  const { closure } = await walkClosure(company, {
    seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
  })

  expect([...(closure.get('entities') ?? [])]).toEqual(['e-1'])   // parent pulled (FK validity)
  expect([...(closure.get('clients') ?? [])].sort()).toEqual(['c-belle']) // NOT c-ann
  expect([...(closure.get('bills') ?? [])]).toEqual(['b-1'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts -t "outbound parents"`
Expected: FAIL — `entities` is absent from the closure (no outbound phase yet).

- [ ] **Step 3: Write minimal implementation**

Insert a phase-2 loop after the phase-1 `while` loop and before the final `return`. Phase 2 follows outbound edges transitively but never re-enters phase-1 inbound expansion:

```ts
  // Phase 2 — OUTBOUND completion. Pull referenced parents so no FK
  // dangles. Transitive over outbound edges only; parents are NOT
  // inbound-expanded (that would drag in unrelated siblings).
  let outboundFrontier: Array<[string, string]> = []
  for (const [c, ids] of closure) for (const id of ids) outboundFrontier.push([c, id])

  while (outboundFrontier.length > 0) {
    if (++depth > maxDepth) {
      throw new PartitionExtractionError(
        `walkClosure exceeded maxDepth=${maxDepth} during outbound completion.`,
      )
    }
    const next: Array<[string, string]> = []
    for (const [collectionName, id] of outboundFrontier) {
      const outbound = refRegistry.getOutbound(collectionName)
      if (Object.keys(outbound).length === 0) continue
      const coll = vault.collection<Record<string, unknown>>(collectionName)
      const record = await coll.get(id)
      if (!record) continue
      for (const [field, descriptor] of Object.entries(outbound)) {
        const rawId = record[field]
        if (rawId === null || rawId === undefined) continue
        const parentId = String(rawId)
        if (add(descriptor.target, parentId)) {
          next.push([descriptor.target, parentId])
        } else {
          cyclesDetected = true
        }
      }
    }
    outboundFrontier = next
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/walk-closure.ts packages/hub/__tests__/walk-closure.test.ts
git commit -m "feat(hub): walkClosure outbound completion (FK validity) (#201)"
```

---

## Task 5: Cycle detection flag + self-reference safety

**Files:**
- Test: `packages/hub/__tests__/walk-closure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('flags cyclesDetected and terminates on a self-referential / mutual cycle', async () => {
  const company = await db.openVault('demo-co')
  // a.refB -> b, b.refA -> a : a 2-node cycle.
  const as = company.collection<{ id: string; refB: string | null; tag: string }>(
    'as', { refs: { refB: ref('bs', 'warn') } },
  )
  const bs = company.collection<{ id: string; refA: string | null }>(
    'bs', { refs: { refA: ref('as', 'warn') } },
  )
  await as.put('a-1', { id: 'a-1', refB: 'b-1', tag: 'seed' })
  await bs.put('b-1', { id: 'b-1', refA: 'a-1' })

  const { closure, graph } = await walkClosure(company, {
    seeds: { as: (r) => r['tag'] === 'seed' },
  })

  expect([...(closure.get('as') ?? [])]).toEqual(['a-1'])
  expect([...(closure.get('bs') ?? [])]).toEqual(['b-1'])
  expect(graph.cyclesDetected).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts -t "cyclesDetected"`
Expected: PASS already (the seen-set `add()` returns false on revisit → sets `cyclesDetected`, and the worklist drains so it terminates). If it FAILS by not terminating, the `add()`/worklist guard has a bug — fix so revisited nodes are never re-queued. This task is a guard test confirming Tasks 2 + 4 handle cycles; no new implementation expected.

- [ ] **Step 3: (no implementation if Step 2 passed)**

- [ ] **Step 4: Run the full file once more**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts`
Expected: PASS (five tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/__tests__/walk-closure.test.ts
git commit -m "test(hub): walkClosure cycle-termination guard (#201)"
```

---

## Task 6: Export from the bundle subpath

**Files:**
- Modify: `packages/hub/src/bundle/index.ts`
- Test: `packages/hub/__tests__/walk-closure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('is exported from the @noy-db/hub/bundle subpath', async () => {
  const mod = await import('../src/bundle/index.js')
  expect(typeof mod.walkClosure).toBe('function')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts -t "exported from"`
Expected: FAIL — `mod.walkClosure` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `packages/hub/src/bundle/index.ts`, add after the existing exports:

```ts
export { walkClosure } from './walk-closure.js'
export type { WalkClosureOptions, ClosureResult } from './walk-closure.js'
```

And in `packages/hub/src/errors.ts`'s bundle re-export block referenced by `bundle/index.ts` (the spec notes new errors re-export from `bundle/index.ts`), add `PartitionExtractionError` to that re-export list:

```ts
// in bundle/index.ts, alongside BundleIntegrityError etc.
export { PartitionExtractionError } from '../errors.js'
```

- [ ] **Step 4: Run the full suite to verify no regressions**

Run: `cd packages/hub && pnpm vitest run __tests__/walk-closure.test.ts && pnpm vitest run __tests__/refs.test.ts`
Expected: PASS for both (the new module + the refs suite the walker depends on).

Then run the whole hub suite to confirm nothing else broke:

Run: `cd packages/hub && pnpm vitest run`
Expected: PASS (existing count + 6 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/index.ts packages/hub/src/errors.ts
git commit -m "feat(hub): export walkClosure + PartitionExtractionError from bundle subpath (#201)"
```

---

## Out of scope for this plan (owned by later plans)

- **`inaccessible[]`** (records the caller's keyring can't decrypt) — only meaningful for the non-owner `exportMyAccessibleData` path (#199). Owner-initiated extraction (the #198 ceremony) has all DEKs, so the graph never cuts on access. `describeExtraction` (#202) surfaces this field; the walker gains a graph-cut branch then.
- **`features.yaml` registration + docs** — `walkClosure` is an internal primitive with no standalone public surface; it gets registered as part of `extractPartition`'s entry (#203 plan), the first user-facing surface that consumes it.
- **Performance / pagination** — full `list()` scans per inbound collection per iteration (foundation §13.4 bound). Acceptable for consumer-firm scale; opt-in pagination deferred.

## Self-review notes

- **Spec coverage:** implements #201's `walkClosure` (the `setupNewVaultIdentity` half of #201 is intentionally deferred per the revised build order above). Auto-derive-from-RefRegistry decision (spec §4.1) is honored — no `followReferences` parameter.
- **Type consistency:** `WalkClosureOptions`/`ClosureResult` defined in Task 1 are used unchanged through Task 6; `closure: Map<string, Set<string>>` shape is stable across all tasks.
- **Traversal-direction decision** (flagged to the user): two-phase (inbound-expand seeds → outbound-complete parents, no parent re-expansion). If the intended semantics differ (e.g. outbound-only, or symmetric expansion), Tasks 2 + 4 are where it changes.
