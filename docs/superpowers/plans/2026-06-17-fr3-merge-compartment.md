# FR-3: Merge-import / reconcile-into-existing vault — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Reconcile an incoming extracted-partition compartment into a RECEIVER's existing vault (already holding overlapping rows) via a per-collection conflict strategy, returning a `MergeReport`, with a dry-run that writes nothing.

**Architecture:** Two parts. (1) **hub** gains a small read-side primitive `decryptExtractedPartition(bytes, transferKey)` → decrypted records per collection (hub's `decrypt`/`unwrapCek` are internal; this is the read-side counterpart to `extractPartition`'s re-key, reusable by FR-4). (2) **`@klum-db/lobby`** gains `mergeCompartment(receiver, compartmentBytes, {transferKey, strategy, dryRun})`: decrypt incoming → `diffVault(receiver, incoming)` → resolve `modified` per the per-collection strategy → apply via `collection.put(id, rec, {reason})` → `MergeReport`. FR-3 epic #443; spec §8.

**Tech Stack:** TS strict, ESM `.js` specifiers, vitest.

**Approved decisions:**
- **Hub decrypt helper** (read-side `decryptExtractedPartition`) — FR-3 is hub + klum (decryption is hub's concern).
- **Strategies:** per-collection `take-incoming` / `keep-local` / `lww-by-ts` / `manual-queue`; **`field-level` guarded as "deferred to FR-4"**.
- **Scope:** single-compartment `mergeCompartment` + `MergeReport` + dry-run (merge-whole-bundle wrapper deferred).

**⚠️ Lint discipline:** run `lint` (eslint) per package AND full `pnpm lint && pnpm typecheck` before the PR.

---

## Semantics (reference)

`diffVault(receiver, incomingRecords)` classifies by id: **added** (in incoming, not receiver), **modified** (in both, body differs), **deleted** (in receiver, not incoming). Apply:
- **added** → insert (every strategy).
- **modified** → CONFLICT → resolve per the collection's strategy.
- **deleted** → **ignore** (the incoming is a *slice*, not a full vault — its absence of a row is not a delete; never delete receiver rows).
- **unchanged** → no-op.

Conflict resolution per strategy (on a `modified` entry): `take-incoming` → write incoming; `keep-local` → skip; `lww-by-ts` → compare the incoming envelope `_ts` vs the receiver envelope `_ts`, write incoming only if newer; `manual-queue` → don't write, record in `MergeReport.conflicts` as `queued`; `field-level` → throw (deferred to FR-4).

---

## File structure
- **Create** `packages/hub/src/bundle/decrypt-partition.ts` — `decryptExtractedPartition`.
- **Create** `packages/hub/__tests__/decrypt-partition.test.ts`.
- **Modify** `packages/hub/src/bundle/index.ts` + `packages/hub/src/index.ts` — export it.
- **Create** `packages/lobby/src/interchange/merge-compartment.ts` — `mergeCompartment`, `MergeReport`, types, `FieldLevelDeferredError`.
- **Create** `packages/lobby/__tests__/merge-compartment.test.ts`.
- **Modify** `packages/lobby/src/index.ts` + `features.yaml`.

---

## Task 1 — hub `decryptExtractedPartition` (TDD)

**Files:** Create `packages/hub/src/bundle/decrypt-partition.ts` + test.

- [ ] **Step 1: Failing test** `packages/hub/__tests__/decrypt-partition.test.ts` — create a vault with a couple of records, `extractPartition` it (→ bundleBytes + transferKey), then:
```typescript
import { decryptExtractedPartition } from '../src/bundle/decrypt-partition.js'
const out = await decryptExtractedPartition(bundleBytes, transferKey)
// out: Record<collection, { id, record, ts, version }[]>
expect(Object.keys(out)).toContain('bills')
const rec = out['bills']!.find((r) => r.id === 'b1')!
expect(rec.record).toMatchObject({ /* the original plaintext fields of b1 */ })
expect(typeof rec.ts).toBe('string')
// wrong transfer key throws
await expect(decryptExtractedPartition(bundleBytes, new Uint8Array(32))).rejects.toThrow()
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `packages/hub/src/bundle/decrypt-partition.ts`:
```typescript
/**
 * Read-side counterpart to `extractPartition`: decrypt an
 * extracted-partition bundle's records to plaintext using its transfer
 * key, WITHOUT adopting it into a vault. Used by reconcile/merge
 * (@klum-db/lobby FR-3) and field-authority (FR-4) to compare incoming
 * records against a receiver. The transfer key validates the bundle
 * (wrong key throws).
 * @module
 */
import type { EncryptedEnvelope } from '../types.js'
import { decrypt } from '../crypto.js'
import { unwrapCek } from '../record-keys/index.js'
import { readNoydbBundleHeader, readNoydbBundle, parseExtractedPartitionBody } from './bundle.js'
import { unsealDeks } from './adopt-partition.js'

/** One decrypted record from an extracted-partition compartment. */
export interface DecryptedRecord {
  readonly id: string
  readonly record: Record<string, unknown>
  /** Source envelope write timestamp (ISO) — for last-write-wins merges. */
  readonly ts: string
  /** Source envelope version. */
  readonly version: number
}

/**
 * Decrypt every record of an extracted-partition bundle to plaintext,
 * grouped by collection. Throws if the bundle isn't an
 * extracted-partition or the transfer key is wrong.
 */
export async function decryptExtractedPartition(
  bundleBytes: Uint8Array,
  transferKey: Uint8Array,
): Promise<Record<string, DecryptedRecord[]>> {
  const header = readNoydbBundleHeader(bundleBytes)
  if (header.bundleKind !== 'extracted-partition' || header.transferSeal === undefined) {
    throw new Error('decryptExtractedPartition: bundle is not an extracted-partition.')
  }
  const { dumpJson } = await readNoydbBundle(bundleBytes)
  const { dump, seal } = parseExtractedPartitionBody(dumpJson)
  const deks = await unsealDeks(seal, transferKey) // throws TransferSealError on wrong key
  const backup = JSON.parse(dump) as { collections: Record<string, Record<string, EncryptedEnvelope>> }
  const out: Record<string, DecryptedRecord[]> = {}
  for (const [collection, byId] of Object.entries(backup.collections)) {
    const dek = deks.get(collection)
    if (dek === undefined) continue // no DEK sealed for this collection — skip
    const recs: DecryptedRecord[] = []
    for (const [id, env] of Object.entries(byId)) {
      const plaintext = env._cek !== undefined
        ? await decrypt(env._iv, env._data, await unwrapCek(env._cek, dek))
        : await decrypt(env._iv, env._data, dek)
      const body = JSON.parse(plaintext) as Record<string, unknown>
      recs.push({ id, record: { ...body, id }, ts: env._ts, version: env._v })
    }
    out[collection] = recs
  }
  return out
}
```
(`record: { ...body, id }` guarantees an `id` field so the array is directly usable as a `diffVault` `Record<collection, T[]>` candidate. `decrypt` returns the plaintext JSON string; `unsealDeks` is exported from `adopt-partition.js`; `parseExtractedPartitionBody` from `bundle.js`.)

- [ ] **Step 4: Run → pass.** Then `pnpm --filter @noy-db/hub typecheck` + `pnpm --filter @noy-db/hub lint`.
- [ ] **Step 5: Export** — add `export { decryptExtractedPartition } from './decrypt-partition.js'` + `export type { DecryptedRecord } from './decrypt-partition.js'` to `packages/hub/src/bundle/index.ts`, and re-export both from `packages/hub/src/index.ts` (next to the other bundle exports).
- [ ] **Step 6: Commit** — `git add packages/hub/src/bundle/decrypt-partition.ts packages/hub/__tests__/decrypt-partition.test.ts packages/hub/src/bundle/index.ts packages/hub/src/index.ts && git commit -m "feat(hub): decryptExtractedPartition — read-side decrypt of an extracted partition"`

---

## Task 2 — klum `mergeCompartment` + strategies + MergeReport + dry-run (TDD)

**Files:** Create `packages/lobby/src/interchange/merge-compartment.ts` + test.

- [ ] **Step 1: Failing test** `packages/lobby/__tests__/merge-compartment.test.ts`. Fixture: a `source` vault with `clients` (c1={id,name:'A'}, c2={id,name:'B'}, c3={id,name:'C'}); `extractPartition(source, {seeds:{clients:()=>true}})` → `{bundleBytes, transferKey}`. A `receiver` vault that ALREADY has `clients` c1={name:'A-OLD'} (overlap, different body) and c4={name:'D'} (receiver-only). Then assert per strategy:
```typescript
import { mergeCompartment } from '../src/interchange/merge-compartment.js'
// take-incoming
let r = await mergeCompartment(receiver, bundleBytes, { transferKey, strategy: 'take-incoming' })
expect(r.summary.inserted).toBe(2)   // c2,c3 new
expect(r.summary.updated).toBe(1)    // c1 overwritten
expect((await receiver.collection('clients').get('c1') as any).name).toBe('A')   // incoming won
expect((await receiver.collection('clients').get('c4'))).not.toBeNull()           // receiver-only kept
// keep-local (fresh receiver): c1 conflict skipped
// lww-by-ts: incoming c1 newer → wins; older → skipped
// manual-queue: c1 -> r.summary.queued===1, r.conflicts has c1, receiver c1 UNCHANGED
// dry-run: r.dryRun===true, summary computed, but receiver NOT modified
// field-level: rejects with FieldLevelDeferredError
```
Write a case per strategy (use a fresh receiver per case to avoid cross-contamination), plus the dry-run and field-level-guard cases.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `packages/lobby/src/interchange/merge-compartment.ts`:
```typescript
/**
 * @klum-db/lobby interchange — reconcile an incoming extracted-partition
 * compartment into an existing receiver vault (FR-3).
 * @module
 */
import type { Vault } from '@noy-db/hub'
import { diffVault } from '@noy-db/hub'
import { decryptExtractedPartition } from '@noy-db/hub/bundle'

/** Per-collection conflict strategy. `field-level` is deferred to FR-4. */
export type MergeStrategy = 'take-incoming' | 'keep-local' | 'lww-by-ts' | 'manual-queue' | 'field-level'

export interface MergeCompartmentOptions {
  readonly transferKey: Uint8Array
  /** One strategy for all collections, or a per-collection map (with optional `default`). */
  readonly strategy: MergeStrategy | (Record<string, MergeStrategy> & { default?: MergeStrategy })
  readonly dryRun?: boolean
  /** Audit reason stamped on writes. Default 'merge:compartment'. */
  readonly reason?: string
}

export interface MergeConflict {
  readonly collection: string
  readonly id: string
  readonly strategy: MergeStrategy
  readonly resolution: 'incoming' | 'local' | 'queued'
}

export interface MergeReport {
  readonly vault: string
  readonly dryRun: boolean
  readonly summary: { inserted: number; updated: number; skipped: number; queued: number; total: number }
  readonly byCollection: Record<string, { inserted: number; updated: number; skipped: number; queued: number }>
  readonly conflicts: MergeConflict[]
}

export class FieldLevelDeferredError extends Error {
  constructor(collection: string) {
    super(`mergeCompartment: the 'field-level' strategy for "${collection}" is not implemented yet — it lands with FR-4 (field-authority). Use take-incoming / keep-local / lww-by-ts / manual-queue for now.`)
    this.name = 'FieldLevelDeferredError'
  }
}

function strategyFor(opts: MergeCompartmentOptions['strategy'], collection: string): MergeStrategy {
  if (typeof opts === 'string') return opts
  return opts[collection] ?? opts.default ?? 'manual-queue'
}

export async function mergeCompartment(
  receiver: Vault,
  compartmentBytes: Uint8Array,
  opts: MergeCompartmentOptions,
): Promise<MergeReport> {
  const reason = opts.reason ?? 'merge:compartment'
  // 1. Decrypt incoming → diffVault candidate (records carry id).
  const incoming = await decryptExtractedPartition(compartmentBytes, opts.transferKey)
  // incoming-ts lookup for lww: collection -> id -> ts
  const incomingTs = new Map<string, Map<string, string>>()
  const candidate: Record<string, Record<string, unknown>[]> = {}
  for (const [coll, recs] of Object.entries(incoming)) {
    candidate[coll] = recs.map((r) => r.record)
    incomingTs.set(coll, new Map(recs.map((r) => [r.id, r.ts])))
  }
  const diff = await diffVault(receiver, candidate)

  const byCollection: MergeReport['byCollection'] = {}
  const conflicts: MergeConflict[] = []
  const bump = (c: string, k: 'inserted' | 'updated' | 'skipped' | 'queued') => {
    const e = byCollection[c] ?? { inserted: 0, updated: 0, skipped: 0, queued: 0 }
    e[k]++; byCollection[c] = e
  }
  const writes: { collection: string; id: string; record: Record<string, unknown> }[] = []

  // 2. added → insert (all strategies)
  for (const a of diff.added) { writes.push({ collection: a.collection, id: a.id, record: a.record as Record<string, unknown> }); bump(a.collection, 'inserted') }

  // 3. modified → resolve per strategy
  const { adapter, name: receiverName } = receiver._introspectState()
  for (const m of diff.modified) {
    const strat = strategyFor(opts.strategy, m.collection)
    if (strat === 'field-level') throw new FieldLevelDeferredError(m.collection)
    if (strat === 'take-incoming') {
      writes.push({ collection: m.collection, id: m.id, record: m.record as Record<string, unknown> }); bump(m.collection, 'updated')
    } else if (strat === 'keep-local') {
      bump(m.collection, 'skipped'); conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'local' })
    } else if (strat === 'manual-queue') {
      bump(m.collection, 'queued'); conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'queued' })
    } else { // lww-by-ts
      const incTs = incomingTs.get(m.collection)?.get(m.id) ?? ''
      const recvEnv = await adapter.get(receiverName, m.collection, m.id)
      const localTs = recvEnv?._ts ?? ''
      if (incTs > localTs) { writes.push({ collection: m.collection, id: m.id, record: m.record as Record<string, unknown> }); bump(m.collection, 'updated'); conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'incoming' }) }
      else { bump(m.collection, 'skipped'); conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'local' }) }
    }
  }
  // diff.deleted (receiver-only) is intentionally ignored — incoming is a slice.

  // 4. apply (unless dry-run)
  if (!opts.dryRun) {
    for (const w of writes) await receiver.collection(w.collection).put(w.id, w.record, { reason })
  }

  const summary = { inserted: 0, updated: 0, skipped: 0, queued: 0, total: 0 }
  for (const e of Object.values(byCollection)) { summary.inserted += e.inserted; summary.updated += e.updated; summary.skipped += e.skipped; summary.queued += e.queued }
  summary.total = summary.inserted + summary.updated + summary.skipped + summary.queued
  return { vault: receiverName, dryRun: opts.dryRun ?? false, summary, byCollection, conflicts }
}
```
(Cross-check: `Vault._introspectState()` returns `{ name, adapter, getDEK }` — `adapter.get(vault, coll, id)` yields the receiver `EncryptedEnvelope` with `_ts` (verified, used by `extractPartition`). `diffVault` `modified`/`added` entries carry `.record` (the candidate's incoming record) and `.collection`/`.id`. `collection.put(id, rec, {reason})` is the write API. ISO `_ts` strings compare lexicographically for lww. If `_introspectState` isn't on the public Vault type, report NEEDS_CONTEXT.)

- [ ] **Step 4: Run → pass.** Then `pnpm --filter @klum-db/lobby typecheck` + `pnpm --filter @klum-db/lobby lint`.
- [ ] **Step 5: Commit** — `git commit -am "feat(lobby): mergeCompartment — reconcile into existing vault (strategies + MergeReport + dry-run)"`

---

## Task 3 — exports + features.yaml + full verification

**Files:** Modify `packages/lobby/src/index.ts`, `features.yaml`.

- [ ] **Step 1: Export from `packages/lobby/src/index.ts`:**
```typescript
export { mergeCompartment, FieldLevelDeferredError } from './interchange/merge-compartment.js'
export type { MergeStrategy, MergeCompartmentOptions, MergeConflict, MergeReport } from './interchange/merge-compartment.js'
```
- [ ] **Step 2: features.yaml** — add `merge-into-existing` (or `merge-compartment`) entry, mirroring the `cross-vault-extraction` entry; artefact `packages/lobby/src/interchange/merge-compartment.ts`, spec the lobby-framework spec (FR-3). (Note: the hub `decryptExtractedPartition` is a primitive of this feature — point the artefact at the lobby file; the hub helper is covered transitively. If the schema wants the hub file too, add it.)
- [ ] **Step 3: Full verification (the lint-gap killer):**
```bash
pnpm --filter @noy-db/hub build
pnpm --filter @klum-db/lobby build
node --input-type=module -e "import('@klum-db/lobby').then(m=>{ if(typeof m.mergeCompartment!=='function') throw new Error('missing'); console.log('exports OK') })"   # from packages/lobby
pnpm --filter @noy-db/hub test
pnpm --filter @klum-db/lobby test
pnpm lint && pnpm typecheck          # full monorepo (CI parity)
node scripts/validate-features.mjs
pnpm check:architecture
```
All green.
- [ ] **Step 4: Commit** — `git commit -am "feat(lobby): export mergeCompartment + register in features.yaml"`

---

## Self-Review

**Spec coverage (issue #443):**
- "merging a compartment into a vault with overlapping rows applies the per-collection strategy correctly" → Task 2 per-strategy tests (take-incoming overwrites, keep-local skips, manual-queue queues; receiver-only rows kept; added inserted).
- "lww-by-ts keeps the newer record; field-level defers to FR-4" → lww-by-ts compares envelope `_ts` (incoming via decrypt helper, receiver via `_introspectState().adapter.get`); `field-level` throws `FieldLevelDeferredError`.
- "a dry-run yields the MergeReport without writing" → `dryRun` computes writes/report but skips `put`; test asserts the receiver is unmodified.
- Approved: hub decrypt helper (Task 1), strategies + scope (Task 2).

**Placeholder scan:** every step has concrete code; the verified-present APIs (`decrypt`→string, `unsealDeks`, `parseExtractedPartitionBody`, `diffVault` candidate-by-id, `_introspectState().adapter.get`→`_ts`, `collection.put({reason})`) are noted with confirm-on-build fallbacks.

**Risk notes:** `diff.deleted` deliberately ignored (slice semantics — never delete receiver rows). lww uses lexicographic ISO `_ts` compare (correct for ISO-8601). `field-level` fails loud (no silent no-op). The hub helper is read-only/decrypt-only (no re-encrypt, no writes) and reusable by FR-4.
```
