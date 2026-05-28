# `describeExtraction` Dry-Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `describeExtraction(vault, { seeds, maxDepth })` (#202) — a read-only preview of a future partition extraction that reports which records would travel, their counts, byte totals, and timestamp span, without writing anything or mutating the source.

**Architecture:** A free function in a new `packages/hub/src/bundle/describe-extraction.ts`. It runs `walkClosure` (Plan 1, #201) to compute the closure, then reads each record's **raw encrypted envelope** via `adapter.get(vaultName, collection, id)` to aggregate byte totals and oldest/newest `_ts` *without decrypting* (the walk itself decrypts for seed predicates + FK fields; the stats layer does not). Returns a frozen `ExtractionPreview`.

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` internals (`walkClosure` from `./walk-closure.js`, `Vault._introspectState()` for `adapter` + `name`, `EncryptedEnvelope` from `types.js`).

---

## Epic context

This is **Plan 2 of the Transferable Partition Bundles epic** (spec: `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md`; Plan 1 shipped `walkClosure` in PR #225). Build order: `describeExtraction` consumes `walkClosure` and is the first surface an operator/audit log inspects before committing to an extraction. No source mutation, no destination vault, no bundle.

## File structure

- **Create:** `packages/hub/src/bundle/describe-extraction.ts` — types + function. One responsibility: compute the preview. ~90 LOC.
- **Create:** `packages/hub/__tests__/describe-extraction.test.ts` — tests. Reuses the `memory()` store harness from `__tests__/walk-closure.test.ts`.
- **Modify:** `packages/hub/src/bundle/index.ts` — export `describeExtraction` + `ExtractionPreview`.

## Reference: what `walkClosure` returns (Plan 1, already shipped)

```ts
// packages/hub/src/bundle/walk-closure.ts
export async function walkClosure(
  vault: Vault,
  opts: { seeds: Record<string, (r: Record<string, unknown>) => boolean | Promise<boolean>>; maxDepth?: number },
): Promise<{ closure: Map<string, Set<string>>; graph: { depth: number; cyclesDetected: boolean } }>
```

## Reference: raw envelope access (no decrypt)

`vault._introspectState()` (`vault.ts:2405`) returns `{ name, adapter, ... }`. `adapter.get(name, collection, id)` returns `EncryptedEnvelope | null` (`types.ts:95`) with fields `_ts: string`, `_data: string`, etc. — readable without decryption.

---

## Task 1: Preview shape + record counts from the closure

**Files:**
- Create: `packages/hub/src/bundle/describe-extraction.ts`
- Test: `packages/hub/__tests__/describe-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file. Copy the `memory()` factory verbatim from `packages/hub/__tests__/walk-closure.test.ts` (lines 22–71, the `function memory()` block).

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { describeExtraction } from '../src/bundle/describe-extraction.js'

// ── paste memory() factory from walk-closure.test.ts here ──

interface Client { id: string; name: string; operatorUserId: string }
interface Bill { id: string; clientId: string; amount: number }

describe('describeExtraction', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
  })

  it('reports record counts per collection and total from the closure', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const bills = company.collection<Bill>('bills', { refs: { clientId: ref('clients') } })

    await clients.put('c-belle', { id: 'c-belle', name: 'Hotel', operatorUserId: 'belle' })
    await clients.put('c-ann', { id: 'c-ann', name: 'Shop', operatorUserId: 'ann' })
    await bills.put('b-1', { id: 'b-1', clientId: 'c-belle', amount: 100 })
    await bills.put('b-2', { id: 'b-2', clientId: 'c-belle', amount: 200 })
    await bills.put('b-3', { id: 'b-3', clientId: 'c-ann', amount: 50 })

    const preview = await describeExtraction(company, {
      seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
    })

    expect(preview.totalRecords).toBe(3) // c-belle + b-1 + b-2
    const byName = Object.fromEntries(preview.byCollection.map((c) => [c.name, c.recordCount]))
    expect(byName).toEqual({ clients: 1, bills: 2 })
    // byCollection is sorted by name for determinism
    expect(preview.byCollection.map((c) => c.name)).toEqual(['bills', 'clients'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/describe-extraction.test.ts -t "record counts"`
Expected: FAIL — `Cannot find module '../src/bundle/describe-extraction.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/hub/src/bundle/describe-extraction.ts
/**
 * Partition-extraction dry-run (#202). Read-only preview of what an
 * `extractPartition` would move: record counts, byte totals, and the
 * timestamp span per collection — computed from raw encrypted
 * envelopes WITHOUT decrypting them. Writes nothing, mutates nothing.
 *
 * @module
 */
import type { Vault } from '../vault.js'
import { walkClosure, type WalkClosureOptions } from './walk-closure.js'

export interface ExtractionPreview {
  readonly totalRecords: number
  /** Sum of serialized encrypted-envelope sizes (bytes). */
  readonly totalBytes: number
  readonly byCollection: ReadonlyArray<{
    readonly name: string
    readonly recordCount: number
    readonly bytes: number
    /** Earliest envelope `_ts` in this collection (lexicographic). */
    readonly oldestTs?: string
    readonly newestTs?: string
  }>
  readonly graph: { readonly depth: number; readonly cyclesDetected: boolean }
  /** Records the walk reached but whose envelope couldn't be read. */
  readonly inaccessible: ReadonlyArray<{ readonly collection: string; readonly id: string }>
}

export async function describeExtraction(
  vault: Vault,
  opts: WalkClosureOptions,
): Promise<ExtractionPreview> {
  const { closure, graph } = await walkClosure(vault, opts)

  const byCollection = [...closure.entries()]
    .map(([name, ids]) => ({ name, recordCount: ids.size, bytes: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const totalRecords = byCollection.reduce((n, c) => n + c.recordCount, 0)

  return Object.freeze({
    totalRecords,
    totalBytes: 0,
    byCollection,
    graph,
    inaccessible: [],
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/describe-extraction.test.ts -t "record counts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/describe-extraction.ts packages/hub/__tests__/describe-extraction.test.ts
git commit -m "feat(hub): describeExtraction record counts from closure (#202)"
```

---

## Task 2: Byte totals + oldest/newest `_ts` from raw envelopes

**Files:**
- Modify: `packages/hub/src/bundle/describe-extraction.ts`
- Test: `packages/hub/__tests__/describe-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('sums envelope bytes and tracks oldest/newest _ts without decrypting', async () => {
  const company = await db.openVault('demo-co')
  const clients = company.collection<Client>('clients')

  await clients.put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })
  await clients.put('c-2', { id: 'c-2', name: 'B', operatorUserId: 'belle' })

  const preview = await describeExtraction(company, {
    seeds: { clients: () => true },
  })

  const clientsStats = preview.byCollection.find((c) => c.name === 'clients')!
  expect(clientsStats.recordCount).toBe(2)
  expect(clientsStats.bytes).toBeGreaterThan(0)
  expect(preview.totalBytes).toBe(clientsStats.bytes)
  // Both records exist; oldest <= newest lexicographically.
  expect(clientsStats.oldestTs).toBeDefined()
  expect(clientsStats.newestTs).toBeDefined()
  expect(clientsStats.oldestTs! <= clientsStats.newestTs!).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/describe-extraction.test.ts -t "envelope bytes"`
Expected: FAIL — `clientsStats.bytes` is `0`, `oldestTs` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Replace the `byCollection` construction + the `return` in `describeExtraction` with a per-record envelope read. Replace from `const byCollection = ...` through the end of the function:

```ts
  const { name: vaultName, adapter } = vault._introspectState()
  const encoder = new TextEncoder()

  const byCollection: Array<{
    name: string; recordCount: number; bytes: number; oldestTs?: string; newestTs?: string
  }> = []
  const inaccessible: Array<{ collection: string; id: string }> = []
  let totalBytes = 0
  let totalRecords = 0

  for (const [collectionName, ids] of closure) {
    let bytes = 0
    let oldestTs: string | undefined
    let newestTs: string | undefined
    let recordCount = 0

    for (const id of ids) {
      const env = await adapter.get(vaultName, collectionName, id)
      if (!env) {
        // Walk reached it (via decrypted list) but the raw store read
        // returned nothing — surface rather than miscount.
        inaccessible.push({ collection: collectionName, id })
        continue
      }
      recordCount++
      bytes += encoder.encode(JSON.stringify(env)).length
      const ts = env._ts
      if (oldestTs === undefined || ts < oldestTs) oldestTs = ts
      if (newestTs === undefined || ts > newestTs) newestTs = ts
    }

    byCollection.push({ name: collectionName, recordCount, bytes, oldestTs, newestTs })
    totalBytes += bytes
    totalRecords += recordCount
  }

  byCollection.sort((a, b) => a.name.localeCompare(b.name))

  return Object.freeze({
    totalRecords,
    totalBytes,
    byCollection,
    graph,
    inaccessible,
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/hub && pnpm vitest run __tests__/describe-extraction.test.ts`
Expected: PASS (record counts + envelope bytes). The Task 1 `totalRecords`/counts test still passes (now computed in the same loop).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/describe-extraction.ts packages/hub/__tests__/describe-extraction.test.ts
git commit -m "feat(hub): describeExtraction byte totals + _ts span from raw envelopes (#202)"
```

---

## Task 3: Graph passthrough + empty `inaccessible` on the owner path

**Files:**
- Test: `packages/hub/__tests__/describe-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('passes through the walk graph metadata and reports no inaccessible records for an owner', async () => {
  const company = await db.openVault('demo-co')
  const clients = company.collection<Client>('clients')
  const bills = company.collection<Bill>('bills', { refs: { clientId: ref('clients') } })
  const creditNotes = company.collection<{ id: string; billId: string }>(
    'creditNotes', { refs: { billId: ref('bills') } },
  )

  await clients.put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })
  await bills.put('b-1', { id: 'b-1', clientId: 'c-1', amount: 100 })
  await creditNotes.put('cn-1', { id: 'cn-1', billId: 'b-1' })

  const preview = await describeExtraction(company, {
    seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
  })

  // clients -> bills -> creditNotes : two inbound expansion hops.
  expect(preview.graph.depth).toBe(2)
  expect(preview.graph.cyclesDetected).toBe(false)
  expect(preview.inaccessible).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/describe-extraction.test.ts -t "graph metadata"`
Expected: PASS already (Task 2 wired `graph` through and `inaccessible` stays empty when every envelope reads back; the owner holds all DEKs). If it FAILS on `depth`, re-confirm Plan 1's inbound-expansion depth counting — `depth` increments once per frontier generation.

- [ ] **Step 3: (no implementation if Step 2 passed)**

- [ ] **Step 4: Run the full file**

Run: `cd packages/hub && pnpm vitest run __tests__/describe-extraction.test.ts`
Expected: PASS (three tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/__tests__/describe-extraction.test.ts
git commit -m "test(hub): describeExtraction graph passthrough + empty inaccessible (#202)"
```

---

## Task 4: Export from the bundle subpath

**Files:**
- Modify: `packages/hub/src/bundle/index.ts`
- Test: `packages/hub/__tests__/describe-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('is exported from the @noy-db/hub/bundle subpath', async () => {
  const mod = await import('../src/bundle/index.js')
  expect(typeof mod.describeExtraction).toBe('function')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/describe-extraction.test.ts -t "exported from"`
Expected: FAIL — `mod.describeExtraction` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `packages/hub/src/bundle/index.ts`, extend the partition-extraction export block added in Plan 1:

```ts
// ─── Partition extraction (#198 epic) ───────────────────
export { walkClosure } from './walk-closure.js'
export type { WalkClosureOptions, ClosureResult } from './walk-closure.js'
export { describeExtraction } from './describe-extraction.js'
export type { ExtractionPreview } from './describe-extraction.js'
```

- [ ] **Step 4: Run the file + full suite**

Run: `cd packages/hub && pnpm vitest run __tests__/describe-extraction.test.ts`
Expected: PASS (four tests).

Run: `cd packages/hub && pnpm typecheck && pnpm exec eslint src/bundle/describe-extraction.ts && pnpm vitest run`
Expected: typecheck clean, lint clean, full suite green (prior count + 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/index.ts
git commit -m "feat(hub): export describeExtraction from bundle subpath (#202)"
```

---

## Out of scope for this plan (later plans)

- **Populated `inaccessible[]` for the non-owner path** (#199 `exportMyAccessibleData`). For owner-initiated extraction every DEK is held, so `inaccessible` is empty unless a raw store read returns null (defensive). The graph-cut-on-undecryptable-FK branch lands with #199.
- **`features.yaml` registration + docs** — `describeExtraction` registers alongside `extractPartition` (its first user-facing companion) in the #203 plan.
- **Performance** — inherits `walkClosure`'s O(frontier·collections·records) scan; raw `adapter.get` per closure record adds one read each. Acceptable at consumer-firm scale.

## Self-review notes

- **Spec coverage:** implements #202 — returns `totalRecords`, `totalBytes`, `byCollection[{name, recordCount, bytes, oldestTs, newestTs}]`, `graph{depth, cyclesDetected}`, `inaccessible[]`; computes bytes/`_ts` from raw envelopes (no decrypt); cycles flagged not thrown (inherited from `walkClosure`); writes nothing.
- **Type consistency:** `ExtractionPreview` defined in Task 1, extended in-place in Task 2 (same field names), exported in Task 4. `WalkClosureOptions` reused as the input type — `describeExtraction` and `extractPartition` share the seeds/maxDepth shape.
- **No decrypt in the stats layer:** `adapter.get` returns the encrypted envelope; only `_ts` and the serialized size are read. The decryption that `walkClosure` performs (predicates + FK fields) is unavoidable and separate.
