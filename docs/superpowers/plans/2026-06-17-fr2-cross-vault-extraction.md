# FR-2: Cross-vault FK-closure extraction → multi-compartment bundle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `@klum-db/lobby` orchestrator that walks an FK closure spanning vault boundaries (via an app-supplied cross-vault descriptor) and emits the seed vault's partition + exactly the FK-referenced slice of each other vault as compartments of one multi-compartment bundle.

**Architecture:** Pure `@klum-db/lobby` — composes hub's intra-vault primitives (`walkClosure`, `extractPartition`, `describeExtraction`) + FR-1's low-level `encodeMultiBundle` (composes *extracted-partition* bundle bytes, not snapshots). **hub is unchanged** (hub's `ref()` deliberately rejects cross-vault refs — `RefScopeError` — so the cross-vault edges live in a klum descriptor; the extraction primitives are intra-vault and reused as-is). FR-2 epic #442; design spec `docs/superpowers/specs/2026-06-16-lobby-framework-design.md` §8.

**Tech Stack:** TS strict, ESM `.js` specifiers, vitest. New code in `@klum-db/lobby` (`packages/lobby/src/interchange/`). Imports from `@noy-db/hub`, `@noy-db/hub/bundle`, `@noy-db/hub/kernel`.

**Approved decisions:**
- **Per-compartment transfer keys** — each `extractPartition` mints its own; the result returns a `{ vaultName → transferKey }` map (out-of-band). Zero hub change. Unified-handoff UX deferred to FR-6.
- **Scope = extract + describe** — `walkCrossVaultClosure` + `extractCrossVaultPartition` + `describeCrossVaultExtraction`. The adopt/merge side is FR-3.
- **Pure klum** — no hub change.

**⚠️ Lint discipline (FR-1 lesson):** run `pnpm --filter @klum-db/lobby lint` AND the FR-1 gate-gap killer `pnpm lint && pnpm typecheck` (full monorepo) before the final commit — package `typecheck` alone does not catch eslint errors.

---

## The cross-vault closure algorithm (Task 1 reference)

Hub's `walkClosure(vault, {seeds})` returns `{ closure: Map<collection, Set<id>> }` for ONE vault, using that vault's intra-vault refs. FR-2 bridges vaults:

1. Walk the **primary** vault with the caller's seed predicates → its closure.
2. **Harvest** cross-vault FK values: for each `CrossVaultRef {from:{collection,field}, to:{vault,collection,field?='id'}}` whose `from.collection` is in the closure, read each closure record and collect `record[from.field]` (scalar or array) into a per-target id-set `targetIds[to.vault][to.collection]`.
3. For each **target** vault, walk it with a seed predicate selecting records whose `to.field` (default `id`) ∈ the accumulated id-set → its closure. Harvest ITS cross-vault FKs (transitive).
4. **Fixpoint:** repeat (3) for any target whose id-set grew, bounded by `maxDepth` rounds, deduping already-walked `(vault, idset-signature)` to terminate on cycles.
5. **Dangling check:** every harvested `(targetVault, targetCollection, id)` must appear in that target's final closure; otherwise it's a dangling ref (referenced row missing/inaccessible) → collect and fail.

The per-vault **seed predicates** (primary: caller's; targets: id-membership) are what feed `extractPartition` later — it re-derives the identical intra-closure from them.

---

## File structure
- **Create** `packages/lobby/src/interchange/extract-cross-vault.ts` — types, `walkCrossVaultClosure`, `extractCrossVaultPartition`, `describeCrossVaultExtraction`, `CrossVaultDanglingRefError`.
- **Create** `packages/lobby/__tests__/extract-cross-vault.test.ts`.
- **Modify** `packages/lobby/src/index.ts` — public exports.
- **Modify** `features.yaml` — register the capability.

---

## Task 1 — Cross-vault descriptor + `walkCrossVaultClosure` (TDD)

**Files:** Create `packages/lobby/src/interchange/extract-cross-vault.ts` + the test.

- [ ] **Step 1: Failing test.** Set up TWO in-memory vaults via `createNoydb` + `@noy-db/to-memory` `memory()` (follow `packages/lobby/__tests__/federation-*.test.ts` for the idiom): a `directory` vault with `entities` (`{id:'e1',name:'Acme'}`, `{id:'e2',name:'Beta'}`, `{id:'e3',name:'Gamma'}`) and a `client` vault with `bills` (`{id:'b1',entityId:'e1'}`, `{id:'b2',entityId:'e2'}`). Then:
```typescript
import { walkCrossVaultClosure, type CrossVaultRef } from '../src/interchange/extract-cross-vault.js'

const refs: CrossVaultRef[] = [{ from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities' } }]
const plan = await walkCrossVaultClosure((name) => db.openVault(name), {
  seed: { vault: 'client', seeds: { bills: () => true } },
  crossVaultRefs: refs,
})
// primary closure has both bills
expect(plan.perVaultClosure.get('client')!.get('bills')!.size).toBe(2)
// directory closure has EXACTLY e1,e2 (referenced) — NOT e3
const dirEntities = plan.perVaultClosure.get('directory')!.get('entities')!
expect([...dirEntities].sort()).toEqual(['e1', 'e2'])
expect(plan.dangling).toEqual([])
```
Add a second test: a bill referencing a missing `e9` → `plan.dangling` contains `{vault:'directory',collection:'entities',id:'e9'}`.

- [ ] **Step 2: Run → fail** (`pnpm --filter @klum-db/lobby test -- extract-cross-vault`).

- [ ] **Step 3: Implement types + `walkCrossVaultClosure`** in `extract-cross-vault.ts`:
```typescript
/**
 * @klum-db/lobby interchange — cross-vault FK-closure extraction.
 * Composes hub's intra-vault primitives + FR-1's encodeMultiBundle.
 * @packageDocumentation
 */
import type { Vault } from '@noy-db/hub'
import { walkClosure } from '@noy-db/hub/bundle'

/** A denormalized cross-vault FK edge (hub refuses these as native refs). */
export interface CrossVaultRef {
  readonly from: { readonly collection: string; readonly field: string }
  readonly to: { readonly vault: string; readonly collection: string; readonly field?: string }
}

/** Seed for the primary vault (predicate per collection, like hub walkClosure). */
export interface CrossVaultSeed {
  readonly vault: string
  readonly seeds: Record<string, (rec: Record<string, unknown>) => boolean | Promise<boolean>>
}

export interface CrossVaultClosurePlan {
  /** vault → seed predicates to feed extractPartition (primary: caller's; targets: id-membership). */
  readonly perVaultSeeds: Map<string, Record<string, (rec: Record<string, unknown>) => boolean | Promise<boolean>>>
  /** vault → intra closure (collection → ids). */
  readonly perVaultClosure: Map<string, Map<string, Set<string>>>
  /** referenced rows not found in their target closure. */
  readonly dangling: { vault: string; collection: string; id: string }[]
}

function asIdArray(v: unknown): string[] {
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String)
  if (typeof v === 'string' || typeof v === 'number') return [String(v)]
  return []
}

export async function walkCrossVaultClosure(
  openVault: (name: string) => Promise<Vault>,
  opts: { seed: CrossVaultSeed; crossVaultRefs?: readonly CrossVaultRef[]; maxDepth?: number },
): Promise<CrossVaultClosurePlan> {
  const refs = opts.crossVaultRefs ?? []
  const maxDepth = opts.maxDepth ?? 16
  const perVaultClosure = new Map<string, Map<string, Set<string>>>()
  const perVaultSeeds: CrossVaultClosurePlan['perVaultSeeds'] = new Map()
  // accumulated referenced ids per target vault+collection
  const targetIds = new Map<string, Map<string, Set<string>>>()
  const addTarget = (v: string, c: string, id: string) => {
    let m = targetIds.get(v); if (!m) { m = new Map(); targetIds.set(v, m) }
    let s = m.get(c); if (!s) { s = new Set(); m.set(c, s) }
    s.add(id)
  }
  const mergeClosure = (v: string, cl: Map<string, Set<string>>) => {
    let dest = perVaultClosure.get(v); if (!dest) { dest = new Map(); perVaultClosure.set(v, dest) }
    for (const [c, ids] of cl) { let s = dest.get(c); if (!s) { s = new Set(); dest.set(c, s) } for (const id of ids) s.add(id) }
  }

  // round 0: primary
  perVaultSeeds.set(opts.seed.vault, opts.seed.seeds)
  const queue: string[] = [opts.seed.vault]
  const walkedSignature = new Set<string>()

  let round = 0
  while (queue.length > 0) {
    if (round++ > maxDepth) break
    const batch = queue.splice(0, queue.length)
    for (const vaultName of batch) {
      const seeds = perVaultSeeds.get(vaultName)!
      const v = await openVault(vaultName)
      const { closure } = await walkClosure(v, { seeds, ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}) })
      mergeClosure(vaultName, closure)
      // harvest cross-vault FKs from this vault's closure
      for (const ref of refs) {
        const ids = closure.get(ref.from.collection)
        if (!ids) continue
        const coll = v.collection<Record<string, unknown>>(ref.from.collection)
        for (const id of ids) {
          const rec = await coll.get(id)
          for (const fk of asIdArray(rec?.[ref.from.field])) addTarget(ref.to.vault, ref.to.collection, fk)
        }
      }
    }
    // enqueue targets whose id-set introduces records not yet in their closure
    for (const [tVault, colls] of targetIds) {
      for (const [tColl, ids] of colls) {
        const field = refs.find((r) => r.to.vault === tVault && r.to.collection === tColl)?.to.field ?? 'id'
        const have = perVaultClosure.get(tVault)?.get(tColl) ?? new Set<string>()
        const sig = `${tVault} ${tColl} ${[...ids].sort().join(',')}`
        if ([...ids].every((id) => have.has(id)) || walkedSignature.has(sig)) continue
        walkedSignature.add(sig)
        const wanted = new Set(ids)
        const seed = { [tColl]: (rec: Record<string, unknown>) => wanted.has(String(rec[field])) }
        const existing = perVaultSeeds.get(tVault)
        perVaultSeeds.set(tVault, existing ? { ...existing, ...seed } : seed)
        queue.push(tVault)
      }
    }
  }

  // dangling check
  const dangling: CrossVaultClosurePlan['dangling'] = []
  for (const [tVault, colls] of targetIds) {
    for (const [tColl, ids] of colls) {
      const have = perVaultClosure.get(tVault)?.get(tColl) ?? new Set<string>()
      for (const id of ids) if (!have.has(id)) dangling.push({ vault: tVault, collection: tColl, id })
    }
  }
  return { perVaultSeeds, perVaultClosure, dangling }
}
```
(Cross-check `walkClosure`'s `WalkClosureOptions`/`ClosureResult` shape against `@noy-db/hub/bundle`; `vault.collection(name).get(id)` returns `T | null`. If `db.openVault` differs, the caller passes the resolver, so the module stays decoupled.)

- [ ] **Step 4: Run → pass.** Then `pnpm --filter @klum-db/lobby typecheck`.
- [ ] **Step 5: Commit** — `git add packages/lobby/src/interchange/extract-cross-vault.ts packages/lobby/__tests__/extract-cross-vault.test.ts && git commit -m "feat(lobby): walkCrossVaultClosure — cross-vault FK closure planner"`

---

## Task 2 — `extractCrossVaultPartition` (emit multi-compartment bundle) (TDD)

**Files:** Modify `extract-cross-vault.ts` + the test.

- [ ] **Step 1: Failing test** (reuse the Task-1 two-vault fixture):
```typescript
import { extractCrossVaultPartition } from '../src/interchange/extract-cross-vault.js'
import { readNoydbBundleManifest, readMultiVaultBundleCompartment } from '@noy-db/hub/bundle'

const res = await extractCrossVaultPartition((name) => db.openVault(name), {
  seed: { vault: 'client', seeds: { bills: () => true } },
  crossVaultRefs: refs,
  compartmentMeta: { client: { roleTag: 'shard' }, directory: { roleTag: 'pool', disclose: { name: true } } },
})
const manifest = await readNoydbBundleManifest(res.bundle)
expect(manifest.map((m) => m.roleTag).sort()).toEqual(['pool', 'shard'])
expect(Object.keys(res.transferKeys).sort()).toEqual(['client', 'directory'])  // per-compartment keys
// the directory compartment carries EXACTLY e1,e2 (FK-reachable), not e3 — verify by adopting it
import { adoptPartition, createOwnerOnAdoptedPartition } from '@noy-db/hub/bundle'
import { memory } from '@noy-db/to-memory'
const dirEntry = manifest.find((m) => m.roleTag === 'pool')!
const dirBytes = readMultiVaultBundleCompartment(res.bundle, dirEntry.handle)
const destStore = memory()
await adoptPartition(dirBytes, { transferKey: res.transferKeys['directory']!, destinationStore: destStore, vaultName: 'dir-adopted' })
await createOwnerOnAdoptedPartition(destStore, 'dir-adopted', { userId: 'u', passphrase: 'correct-horse-battery-staple', transferKey: res.transferKeys['directory']! })
const dest = await (await createNoydb({ store: destStore, user: 'u', secret: 'correct-horse-battery-staple' })).openVault('dir-adopted')
const adoptedEntities = (await dest.collection('entities').list()).map((r:any)=>r.id).sort()
expect(adoptedEntities).toEqual(['e1', 'e2'])   // exactly the referenced rows, no e3
```
(If the adopt ceremony's exact option shape differs, match `AdoptPartitionOptions`/`CreateOwnerStandardOptions` from `@noy-db/hub/bundle`. The essential assertion: the directory compartment contains e1,e2 and NOT e3.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — append to `extract-cross-vault.ts`:
```typescript
import { extractPartition, encodeMultiBundle, readNoydbBundleHeader, readNoydbBundlePublicEnvelope, NOYDB_MULTI_BUNDLE_VERSION, generateULID, type MultiBundleManifest, type CompartmentManifest } from '@noy-db/hub/bundle'
import { sha256Hex } from '@noy-db/hub/kernel'

export class CrossVaultDanglingRefError extends Error {
  constructor(readonly dangling: { vault: string; collection: string; id: string }[]) {
    super(`cross-vault extraction: ${dangling.length} referenced row(s) missing from their target closure: ` + dangling.map((d) => `${d.vault}/${d.collection}/${d.id}`).slice(0, 5).join(', '))
    this.name = 'CrossVaultDanglingRefError'
  }
}

export interface CompartmentMeta {
  readonly roleTag?: string
  readonly disclose?: { readonly name?: boolean | string; readonly collections?: boolean; readonly publicEnvelope?: boolean }
}

export interface ExtractCrossVaultOptions {
  readonly seed: CrossVaultSeed
  readonly crossVaultRefs?: readonly CrossVaultRef[]
  readonly maxDepth?: number
  readonly carrySchemas?: boolean
  readonly carryLedger?: boolean
  readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none'
  readonly compartmentMeta?: Record<string, CompartmentMeta>
}

export interface ExtractCrossVaultResult {
  readonly bundle: Uint8Array
  readonly transferKeys: Record<string, Uint8Array>
  readonly sealIds: Record<string, string>
}

export async function extractCrossVaultPartition(
  openVault: (name: string) => Promise<Vault>,
  opts: ExtractCrossVaultOptions,
): Promise<ExtractCrossVaultResult> {
  const plan = await walkCrossVaultClosure(openVault, opts)
  if (plan.dangling.length > 0) throw new CrossVaultDanglingRefError(plan.dangling)

  const inner: Uint8Array[] = []
  const compartments: CompartmentManifest[] = []
  const transferKeys: Record<string, Uint8Array> = {}
  const sealIds: Record<string, string> = {}

  for (const [vaultName, seeds] of plan.perVaultSeeds) {
    const v = await openVault(vaultName)
    const { bundleBytes, transferKey, sealId } = await extractPartition(v, {
      seeds,
      ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
      carrySchemas: opts.carrySchemas ?? true,
      carryLedger: opts.carryLedger ?? false,
      ...(opts.compression !== undefined ? { compression: opts.compression } : {}),
    })
    const header = readNoydbBundleHeader(bundleBytes)
    const meta = opts.compartmentMeta?.[vaultName]
    const entry: { -readonly [K in keyof CompartmentManifest]: CompartmentManifest[K] } = {
      handle: header.handle,
      exportedAt: new Date().toISOString(),
      innerBytes: bundleBytes.length,
      innerSha256: await sha256Hex(bundleBytes),
    }
    if (meta?.roleTag !== undefined) entry.roleTag = meta.roleTag
    if (meta?.disclose?.name !== undefined && meta.disclose.name !== false) entry.name = meta.disclose.name === true ? v.name : meta.disclose.name
    if (meta?.disclose?.collections === true) {
      const cl = plan.perVaultClosure.get(vaultName)
      if (cl) entry.collections = [...cl].map(([name, ids]) => ({ name, count: ids.size }))
    }
    if (meta?.disclose?.publicEnvelope === true) {
      const env = readNoydbBundlePublicEnvelope(bundleBytes)
      if (env !== undefined) entry.publicEnvelope = env
    }
    inner.push(bundleBytes); compartments.push(entry)
    transferKeys[vaultName] = transferKey; sealIds[vaultName] = sealId
  }

  const manifest: MultiBundleManifest = { multiFormatVersion: NOYDB_MULTI_BUNDLE_VERSION, handle: generateULID(), compartments }
  return { bundle: encodeMultiBundle(manifest, inner), transferKeys, sealIds }
}
```
(Confirm `generateULID`/`NOYDB_MULTI_BUNDLE_VERSION`/`readNoydbBundlePublicEnvelope` are exported from `@noy-db/hub/bundle` — they are, per FR-1's `bundle/index.ts`. Note `collections` count here comes from the closure plan, not a full `vault.collections()` scan — it reflects exactly the extracted slice.)

- [ ] **Step 4: Run → pass; typecheck.**
- [ ] **Step 5: Commit** — `git commit -am "feat(lobby): extractCrossVaultPartition — emit multi-compartment bundle + per-compartment transfer keys"`

---

## Task 3 — `describeCrossVaultExtraction` (per-compartment preview) (TDD)

**Files:** Modify `extract-cross-vault.ts` + the test.

- [ ] **Step 1: Failing test:**
```typescript
import { describeCrossVaultExtraction } from '../src/interchange/extract-cross-vault.js'
const preview = await describeCrossVaultExtraction((name) => db.openVault(name), { seed: { vault: 'client', seeds: { bills: () => true } }, crossVaultRefs: refs })
expect(preview.compartments.map((c) => c.vault).sort()).toEqual(['client', 'directory'])
const dir = preview.compartments.find((c) => c.vault === 'directory')!
expect(dir.preview.byCollection.find((b) => b.name === 'entities')!.recordCount).toBe(2)  // e1,e2
expect(preview.dangling).toEqual([])
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — append:
```typescript
import { describeExtraction, type ExtractionPreview } from '@noy-db/hub/bundle'

export interface CrossVaultPreview {
  readonly compartments: { readonly vault: string; readonly preview: ExtractionPreview }[]
  readonly dangling: { vault: string; collection: string; id: string }[]
}

export async function describeCrossVaultExtraction(
  openVault: (name: string) => Promise<Vault>,
  opts: { seed: CrossVaultSeed; crossVaultRefs?: readonly CrossVaultRef[]; maxDepth?: number },
): Promise<CrossVaultPreview> {
  const plan = await walkCrossVaultClosure(openVault, opts)
  const compartments: CrossVaultPreview['compartments'] = []
  for (const [vaultName, seeds] of plan.perVaultSeeds) {
    const v = await openVault(vaultName)
    const preview = await describeExtraction(v, { seeds, ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}) })
    compartments.push({ vault: vaultName, preview })
  }
  return { compartments, dangling: plan.dangling }
}
```

- [ ] **Step 4: Run → pass; typecheck.**
- [ ] **Step 5: Commit** — `git commit -am "feat(lobby): describeCrossVaultExtraction — per-compartment dry-run preview"`

---

## Task 4 — Public exports + features.yaml + full verification

**Files:** Modify `packages/lobby/src/index.ts`, `features.yaml`.

- [ ] **Step 1: Export from `packages/lobby/src/index.ts`:**
```typescript
export {
  walkCrossVaultClosure,
  extractCrossVaultPartition,
  describeCrossVaultExtraction,
  CrossVaultDanglingRefError,
} from './interchange/extract-cross-vault.js'
export type {
  CrossVaultRef, CrossVaultSeed, CrossVaultClosurePlan,
  CompartmentMeta, ExtractCrossVaultOptions, ExtractCrossVaultResult,
  CrossVaultPreview,
} from './interchange/extract-cross-vault.js'
```

- [ ] **Step 2: Register in `features.yaml`** — add an entry (id e.g. `cross-vault-extraction`) mirroring the schema of the `multi-compartment-bundle` entry FR-1 added; artefact `packages/lobby/src/interchange/extract-cross-vault.ts`, spec the lobby-framework spec (FR-2). `node scripts/validate-features.mjs` must pass.

- [ ] **Step 3: Full verification (incl. the FR-1 lint-gap killer):**
```bash
pnpm --filter @noy-db/hub build          # klum resolves hub from dist
pnpm --filter @klum-db/lobby build
node --input-type=module -e "import('@klum-db/lobby').then(m=>{ for (const n of ['walkCrossVaultClosure','extractCrossVaultPartition','describeCrossVaultExtraction']) if (typeof m[n]!=='function') throw new Error('missing '+n); console.log('exports OK') })"  # run from packages/lobby
pnpm --filter @klum-db/lobby test
pnpm --filter @klum-db/lobby lint        # eslint — DO NOT SKIP (FR-1 lesson)
pnpm --filter @klum-db/lobby typecheck
pnpm lint && pnpm typecheck              # full monorepo (CI parity)
node scripts/validate-features.mjs
pnpm check:architecture
```
Expected all green.

- [ ] **Step 4: Commit** — `git commit -am "feat(lobby): export cross-vault extraction API + register in features.yaml"`

---

## Self-Review

**Spec coverage (issue #442):**
- "seed predicate on A + cross-vault FK descriptor to B → bundle contains A's partition + exactly the B rows reachable by FK (no more)" → Task 2 test adopts the directory compartment and asserts exactly `e1,e2` (not `e3`).
- "describeExtraction reports per-compartment counts" → Task 3 `describeCrossVaultExtraction` per-compartment `ExtractionPreview`.
- "dangling-ref check: nothing referenced is omitted" → Task 1 dangling test + `CrossVaultDanglingRefError` thrown in Task 2.
- Approved: per-compartment transfer keys (Task 2 `transferKeys` map); pure-klum (no hub change — verify `git diff main -- packages/hub` is empty at the end).

**Placeholder scan:** every step has concrete code; the "confirm the API shape" notes target verified-present exports (`walkClosure`/`extractPartition`/`encodeMultiBundle`/`generateULID`/`NOYDB_MULTI_BUNDLE_VERSION`/`sha256Hex`/`adoptPartition`).

**Lint discipline:** Task 4 runs `pnpm --filter @klum-db/lobby lint` + full `pnpm lint` (the FR-1 gap). Watch for `no-unnecessary-type-assertion` on the `-readonly` builder + any `as` casts.

**Risk notes:** the fixpoint loop is bounded by `maxDepth` + a walked-signature dedup (terminates on cycles); `extractPartition` re-derives each vault's intra-closure from the computed seeds (consistent with the planner); `collections` counts come from the closure plan (exact slice), not a full vault scan.
