# FR-4 — Field-Authority Conflict Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a per-**field** conflict resolver (`'field-authority'` merge strategy) for cross-vault merges, driven by an app-supplied per-field policy map, resolving each divergent field via FR-5 provenance.

**Architecture:** Mostly **pure `@klum-db/lobby`** (the resolver + policy live at the FR-3 merge seam in `merge-compartment.ts`, which already hands both plaintext halves + `fieldsChanged`). One small **hub** touch: `Collection.put` gains an optional `sourceTs?` override so `source-newest` compares TRUE origin refresh times across re-merges (also fixes FR-5 follow-up #1). noy-db ships the **mechanism**; the app supplies the **policy** (Insight-Vault engine-vs-policy split).

**Tech stack:** TypeScript, vitest, pnpm workspaces. Hub: `packages/hub`. Klum: `packages/lobby`.

**Design decisions (resolved at the FR-4 design gate):**
- **Owner identity → by `_source`:** policy rule `{authority:'owner', ownerSource:'<id>'}`; the side whose record `_source` matches wins. Reuses FR-5 record-level provenance; no new primitive. Field-authority is only meaningful when the relevant collections have `provenance:true`.
- **`source-newest` → preserve origin `_sourceTs`:** small hub change (`put` accepts `sourceTs?`); record-level take strategies pass the incoming origin `_sourceTs` so it survives re-merges.
- **Per-field lineage → deferred:** a field-authority-MERGED record carries a single record-level `_source: 'merged'` (merge-time `_sourceTs`). Per-field source map is a future follow-up.

**Authority rules (the policy vocabulary):**
```ts
type FieldAuthorityRule =
  | { authority: 'source-newest' }                       // newer origin _sourceTs wins
  | { authority: 'owner'; ownerSource: string }          // side whose _source === ownerSource wins
  | { authority: 'fixed-source'; source: string }        // side whose _source === source wins
```
Resolution defaults (safety — never clobber on ambiguity): a field NOT in the policy → keep-local; `source-newest` with missing incoming provenance → keep-local; `source-newest` with missing local but present incoming → incoming; `source-newest` tie → keep-local; `owner`/`fixed-source` with no incoming match → keep-local.

---

## File structure

- **Modify** `packages/hub/src/collection.ts` — thread `sourceTs?` through put → encryptRecord → encryptJsonString / buildDebugEnvelope; putAtTier. (Task 1)
- **Create** `packages/lobby/src/interchange/field-authority.ts` — pure resolver functions + rule/policy types + `FieldAuthorityPolicyMissingError`. (Task 2)
- **Modify** `packages/lobby/src/interchange/merge-compartment.ts` — add `'field-authority'` strategy, `fieldAuthority` option, `incomingSourceTs` map, wire the resolver, deprecate `'field-level'` alias. (Task 3) + record-take origin-`_sourceTs` preservation. (Task 4)
- **Modify** `packages/lobby/src/index.ts` (or wherever interchange re-exports live) — export the new public types/functions. (Task 5)
- **Modify** `features.yaml` — register `field-authority-merge`. (Task 5)
- **Tests:** `packages/hub/__tests__/provenance.test.ts` (Task 1, 4-dependency), `packages/lobby/__tests__/field-authority.test.ts` (Task 2), `packages/lobby/__tests__/merge-compartment.test.ts` (Task 3, 4).

---

## Task 1 — hub: `put()` accepts `sourceTs?` origin override (TDD)

**Files:** Modify `packages/hub/src/collection.ts`; Test `packages/hub/__tests__/provenance.test.ts`.

**Context:** Today `_sourceTs` is always `new Date().toISOString()` at three envelope sites (4181 buildDebugEnvelope, 4194 encryptJsonString, 4407 putAtTier). `source` is threaded `put → putInternal → encryptRecord(…, source) → encryptJsonString/buildDebugEnvelope`. Add a parallel `sourceTs?` that, when supplied (+ provenance + source), replaces `now()`.

- [ ] **Step 1: Failing test** — append to `packages/hub/__tests__/provenance.test.ts`:
```ts
it('put({source, sourceTs}) preserves the supplied origin sourceTs', async () => {
  const db = await openTestVault()                       // match the file's existing harness
  const c = db.collection<{ id: string; name: string }>('clients', { provenance: true })
  const origin = '2020-01-02T03:04:05.000Z'
  await c.put('c1', { id: 'c1', name: 'A' }, { source: 'firm-A', sourceTs: origin })
  const meta = await c.getMetadata('c1')
  expect(meta?.source).toBe('firm-A')
  expect(meta?.sourceTs).toBe(origin)                    // NOT now()
})

it('put({source}) without sourceTs still stamps current time', async () => {
  const db = await openTestVault()
  const c = db.collection<{ id: string; name: string }>('clients', { provenance: true })
  await c.put('c1', { id: 'c1', name: 'A' }, { source: 'firm-A' })
  const meta = await c.getMetadata('c1')
  expect(meta?.source).toBe('firm-A')
  expect(typeof meta?.sourceTs).toBe('string')           // present, machine-stamped
})
```
(Open the test file first and reuse its existing setup helper instead of `openTestVault` if the name differs.)

- [ ] **Step 2: Run → fail.** `pnpm --filter @noy-db/hub test provenance` → first test fails (`sourceTs` ignored, returns now()).

- [ ] **Step 3: Implement.** In `collection.ts`:
  1. Widen the public `put` options (line 1242) and `putInternal` (line 1310) types — both currently `{ readonly reason?: string; readonly source?: string }` → add `; readonly sourceTs?: string`.
  2. Update the JSDoc near 1238 to mention `sourceTs` (origin override; only honoured with `provenance` + `source`).
  3. Main path (line 1626): `encryptRecord(record, version, cek, options?.source)` → `encryptRecord(record, version, cek, options?.source, options?.sourceTs)`.
  4. CRDT path (line 1510): `encryptJsonString(JSON.stringify(crdtState), version, cek, options?.source)` → add `, options?.sourceTs`.
  5. `encryptRecord` (4239): add param `sourceTs?: string` after `source`; pass to `buildDebugEnvelope(record, version, source, sourceTs)` (4250) and `encryptJsonString(JSON.stringify(record), version, cek, source, sourceTs)` (4252).
  6. `encryptJsonString` (4186): add param `sourceTs?: string` after `source`; change `provenanceFields` (4193):
     ```ts
     const provenanceFields = this.provenance && source !== undefined
       ? { _source: source, _sourceTs: sourceTs ?? new Date().toISOString() }
       : {}
     ```
  7. `buildDebugEnvelope` (4168): add param `sourceTs?: string` after `source`; change line 4181:
     ```ts
     ...(this.provenance && source !== undefined ? { _source: source, _sourceTs: sourceTs ?? new Date().toISOString() } : {}),
     ```
  8. `putAtTier` (4382): add `sourceTs?: string` to its `opts` type; change line 4407:
     ```ts
     ...(this.provenance && opts?.source !== undefined ? { _source: opts.source, _sourceTs: opts.sourceTs ?? new Date().toISOString() } : {}),
     ```
  **Do NOT touch** the history-snapshot encrypts (1526, 1608, 2169, 2312, 3689) — they pass no source and must never carry one (FR-5 invariant).

- [ ] **Step 4: Run → pass.** `pnpm --filter @noy-db/hub test provenance` green; then full `pnpm --filter @noy-db/hub test` (no regression), `pnpm --filter @noy-db/hub typecheck`, `pnpm --filter @noy-db/hub lint`, `pnpm check:architecture` (collection.ts ≤ ceiling — these are same-line edits + ~4 new param lines; if it trips 4800, bump to 4810 in `scripts/check-architecture.mjs`).

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): put() sourceTs override — preserve origin _sourceTs (FR-4/FR-5 follow-up)"`

---

## Task 2 — klum: pure field-authority resolver (TDD)

**Files:** Create `packages/lobby/src/interchange/field-authority.ts`; Test `packages/lobby/__tests__/field-authority.test.ts`.

**Context:** The acceptance criterion requires the policy be "declarative + unit-testable in isolation." So the resolution logic is PURE (no vault I/O): given a rule + both sides' record-level provenance, decide per field whether incoming wins. Provenance is record-level (Q3 defer), so the per-record `io` is shared across all fields; only the per-field RULE varies.

- [ ] **Step 1: Failing test** — create `packages/lobby/__tests__/field-authority.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import {
  resolveFieldAuthority,
  resolveRecordByFieldAuthority,
  type FieldAuthorityPolicy,
} from '../src/interchange/field-authority'

describe('resolveFieldAuthority (pure)', () => {
  it('source-newest: newer incoming origin wins', () => {
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { incomingSourceTs: '2022-01-01T00:00:00Z', localSourceTs: '2021-01-01T00:00:00Z' })).toBe('incoming')
  })
  it('source-newest: older incoming keeps local', () => {
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { incomingSourceTs: '2020-01-01T00:00:00Z', localSourceTs: '2021-01-01T00:00:00Z' })).toBe('local')
  })
  it('source-newest: tie keeps local; missing incoming keeps local; missing local takes incoming', () => {
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { incomingSourceTs: '2021-01-01T00:00:00Z', localSourceTs: '2021-01-01T00:00:00Z' })).toBe('local')
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { localSourceTs: '2021-01-01T00:00:00Z' })).toBe('local')
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { incomingSourceTs: '2021-01-01T00:00:00Z' })).toBe('incoming')
  })
  it('owner: incoming wins only when its _source matches ownerSource', () => {
    expect(resolveFieldAuthority({ authority: 'owner', ownerSource: 'principal-X' },
      { incomingSource: 'principal-X' })).toBe('incoming')
    expect(resolveFieldAuthority({ authority: 'owner', ownerSource: 'principal-X' },
      { incomingSource: 'firm-B', localSource: 'principal-X' })).toBe('local')
    expect(resolveFieldAuthority({ authority: 'owner', ownerSource: 'principal-X' }, {})).toBe('local')
  })
  it('fixed-source: incoming wins only when its _source matches', () => {
    expect(resolveFieldAuthority({ authority: 'fixed-source', source: 'dbd-registry' },
      { incomingSource: 'dbd-registry' })).toBe('incoming')
    expect(resolveFieldAuthority({ authority: 'fixed-source', source: 'dbd-registry' },
      { incomingSource: 'firm-B' })).toBe('local')
  })
})

describe('resolveRecordByFieldAuthority (pure)', () => {
  it('merges per field: registry→newest-source, sovereign→owner, unlisted→local', () => {
    const policy: FieldAuthorityPolicy = {
      juristicName: { authority: 'source-newest' },
      nickname: { authority: 'owner', ownerSource: 'principal-X' },
    }
    const before = { id: 'c1', juristicName: 'Old Co', nickname: 'localNick', secret: 'keepme' }
    const incoming = { id: 'c1', juristicName: 'New Co', nickname: 'theirNick', secret: 'clobber' }
    const { merged, decisions } = resolveRecordByFieldAuthority(
      policy, before, incoming,
      ['juristicName', 'nickname', 'secret'],
      { incomingSource: 'firm-B', incomingSourceTs: '2022-01-01T00:00:00Z',
        localSource: 'principal-X', localSourceTs: '2021-01-01T00:00:00Z' },
    )
    expect(merged.juristicName).toBe('New Co')   // source-newest: incoming newer
    expect(merged.nickname).toBe('localNick')    // owner: incoming not principal-X → local
    expect(merged.secret).toBe('keepme')         // unlisted → local
    expect(decisions).toEqual({ juristicName: 'incoming', nickname: 'local', secret: 'local' })
  })
})
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @klum-db/lobby test field-authority` → module not found.

- [ ] **Step 3: Implement** — create `packages/lobby/src/interchange/field-authority.ts`:
```ts
/**
 * @klum-db/lobby interchange — field-authority conflict resolution (FR-4).
 *
 * Pure functions: given an app-supplied per-field policy and both sides'
 * RECORD-level provenance (FR-5 `_source`/`_sourceTs`), decide field-by-field
 * whether the incoming value wins. No vault I/O — unit-testable in isolation.
 * @module
 */

/** How a single field's authority is decided on merge. */
export type FieldAuthorityRule =
  | { readonly authority: 'source-newest' }
  | { readonly authority: 'owner'; readonly ownerSource: string }
  | { readonly authority: 'fixed-source'; readonly source: string }

/** Per-collection field → rule map. Fields not listed default to keep-local. */
export type FieldAuthorityPolicy = Record<string, FieldAuthorityRule>

/** Record-level provenance for both sides (shared across all fields — Q3 defer). */
export interface FieldAuthorityInputs {
  readonly incomingSource?: string
  readonly incomingSourceTs?: string
  readonly localSource?: string
  readonly localSourceTs?: string
}

/** Thrown when a collection resolves to `field-authority` but no policy is supplied for it. */
export class FieldAuthorityPolicyMissingError extends Error {
  constructor(collection: string) {
    super(
      `mergeCompartment: the 'field-authority' strategy for "${collection}" requires a ` +
        `fieldAuthority policy entry for that collection, but none was supplied.`,
    )
    this.name = 'FieldAuthorityPolicyMissingError'
  }
}

/** Decide whether the INCOMING value of one field wins. Pure. Defaults never clobber on ambiguity. */
export function resolveFieldAuthority(
  rule: FieldAuthorityRule,
  io: FieldAuthorityInputs,
): 'incoming' | 'local' {
  switch (rule.authority) {
    case 'source-newest': {
      const inc = io.incomingSourceTs
      const loc = io.localSourceTs
      if (inc === undefined) return 'local'        // no incoming provenance → don't clobber
      if (loc === undefined) return 'incoming'     // local has none, incoming does
      return inc > loc ? 'incoming' : 'local'      // ISO-8601 lexicographic; tie → local
    }
    case 'owner':
      return io.incomingSource === rule.ownerSource ? 'incoming' : 'local'
    case 'fixed-source':
      return io.incomingSource === rule.source ? 'incoming' : 'local'
  }
}

/**
 * Build the merged record per policy, starting from the local (`before`) copy
 * and overlaying only the changed fields whose rule resolves to `incoming`.
 * Returns the merged record plus a per-field decision map (for the audit report).
 * Pure — no I/O.
 */
export function resolveRecordByFieldAuthority(
  policy: FieldAuthorityPolicy,
  before: Record<string, unknown>,
  incoming: Record<string, unknown>,
  changedFields: readonly string[],
  io: FieldAuthorityInputs,
): { merged: Record<string, unknown>; decisions: Record<string, 'incoming' | 'local'> } {
  const merged: Record<string, unknown> = { ...before }
  const decisions: Record<string, 'incoming' | 'local'> = {}
  for (const f of changedFields) {
    const rule = policy[f]
    if (rule === undefined) { decisions[f] = 'local'; continue }   // unlisted → keep local
    const who = resolveFieldAuthority(rule, io)
    decisions[f] = who
    if (who === 'incoming') merged[f] = incoming[f]
  }
  return { merged, decisions }
}
```

- [ ] **Step 4: Run → pass.** `pnpm --filter @klum-db/lobby test field-authority` green; `pnpm --filter @klum-db/lobby typecheck`.

- [ ] **Step 5: Commit** — `git commit -am "feat(lobby): pure field-authority resolver + policy types (FR-4)"`

---

## Task 3 — klum: wire `'field-authority'` into `mergeCompartment` (TDD)

**Files:** Modify `packages/lobby/src/interchange/merge-compartment.ts`; Test `packages/lobby/__tests__/merge-compartment.test.ts`.

**Context:** The seam is the `modified` switch (line 184-217). Today `if (strat === 'field-level') throw new FieldLevelDeferredError(...)` (line 187-189). Replace with the resolver. Receiver-side provenance comes from `adapter.get(receiverName, collection, id)` — the same pattern `lww-by-ts` already uses for `_ts` (line 205), now also reading `_source`/`_sourceTs`. Step 0: `pnpm --filter @noy-db/hub build` so lobby sees Task 1's `sourceTs` put option.

- [ ] **Step 1: Failing test** — append to `packages/lobby/__tests__/merge-compartment.test.ts` a `describe('mergeCompartment — field-authority (FR-4)')`:
```ts
// Setup mirrors the existing provenance test in this file: a source vault with
// provenance:true, extract → bundle, receiver with provenance:true. Use the
// file's existing extraction helper. The client record diverges on two fields.
it('merges per field: registry field takes newest source, sovereign field keeps owner', async () => {
  // source (incoming) — firm-B's refresh: newer juristicName, different nickname
  // receiver (local)  — principal-X owns nickname; older juristicName
  // ... (build via the file's helpers; write incoming c1 with {source:'firm-B', sourceTs:'2022-..'},
  //      receiver c1 with {source:'principal-X', sourceTs:'2021-..'})
  const report = await mergeCompartment(receiver, bundle, {
    transferKey,
    strategy: 'field-authority',
    fieldAuthority: {
      clients: {
        juristicName: { authority: 'source-newest' },
        nickname: { authority: 'owner', ownerSource: 'principal-X' },
      },
    },
  })
  const merged = await receiver.collection('clients').get('c1')
  expect(merged.juristicName).toBe('New Co')     // source-newest → incoming (firm-B newer)
  expect(merged.nickname).toBe('localNick')      // owner principal-X → local kept
  expect(report.summary.updated).toBe(1)
})

it('throws FieldAuthorityPolicyMissingError when no policy for the collection', async () => {
  await expect(mergeCompartment(receiver, bundle, { transferKey, strategy: 'field-authority' }))
    .rejects.toThrow(/fieldAuthority policy/)
})

it('dryRun computes the field-authority outcome without writing', async () => {
  const report = await mergeCompartment(receiver, bundle, {
    transferKey, strategy: 'field-authority', dryRun: true,
    fieldAuthority: { clients: { juristicName: { authority: 'source-newest' } } },
  })
  expect(report.dryRun).toBe(true)
  const untouched = await receiver.collection('clients').get('c1')
  expect(untouched.juristicName).toBe('Old Co')  // not written
})
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @noy-db/hub build && pnpm --filter @klum-db/lobby test merge-compartment` → fails (strategy not implemented / still throws deferral).

- [ ] **Step 3: Implement** in `merge-compartment.ts`:
  1. Imports: add
     ```ts
     import {
       resolveRecordByFieldAuthority,
       FieldAuthorityPolicyMissingError,
       type FieldAuthorityPolicy,
     } from './field-authority'
     ```
  2. `MergeStrategy` (line 21): add `| 'field-authority'`. Keep `'field-level'` in the union as a **deprecated alias** (handled identically below); update its doc comment to "deprecated alias of `field-authority`".
  3. `MergeCompartmentOptions` (line 28): add
     ```ts
     /** Per-collection field→authority policy. Required for any collection using `field-authority`. */
     readonly fieldAuthority?: Record<string, FieldAuthorityPolicy>
     ```
  4. `MergeConflict.resolution` (line 47): widen to `'incoming' | 'local' | 'queued' | 'field-merged'`.
  5. Build `incomingSourceTs` alongside `incomingSource` in the decrypt loop (after line 142):
     ```ts
     const incomingSourceTs = new Map<string, Map<string, string>>()
     ```
     in the loop (after line 149): `const tsSrcMap = ...` — simplest is a second map populated next to `srcMap`:
     ```ts
     const stsMap = new Map<string, string>()
     for (const r of recs) {
       tsMap.set(r.id, r.ts)
       if (r.source !== undefined) srcMap.set(r.id, r.source)
       if (r.sourceTs !== undefined) stsMap.set(r.id, r.sourceTs)
     }
     // ...
     incomingSourceTs.set(coll, stsMap)
     ```
  6. In the `modified` loop, REPLACE the `field-level` throw (line 187-189) with:
     ```ts
     if (strat === 'field-authority' || strat === 'field-level') {
       const policy = opts.fieldAuthority?.[m.collection]
       if (policy === undefined) throw new FieldAuthorityPolicyMissingError(m.collection)
       const recvEnv = await adapter.get(receiverName, m.collection, m.id)
       const io = {
         incomingSource: incomingSource.get(m.collection)?.get(m.id),
         incomingSourceTs: incomingSourceTs.get(m.collection)?.get(m.id),
         localSource: recvEnv?._source,
         localSourceTs: recvEnv?._sourceTs,
       }
       const { merged } = resolveRecordByFieldAuthority(
         policy,
         m.before as Record<string, unknown>,
         m.record,
         m.fieldsChanged,
         io,
       )
       // Per-field MERGED synthesis carries a record-level 'merged' source (Q3 defer).
       writes.push({ collection: m.collection, id: m.id, record: merged, source: 'merged' })
       bump(m.collection, 'updated')
       conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'field-merged' })
       continue
     }
     ```
     (Keep the existing `take-incoming` / `keep-local` / `manual-queue` / `lww-by-ts` branches below it. Note: `recvEnv?._source` requires the envelope type to expose `_source`/`_sourceTs` — they were added to `EncryptedEnvelope` in FR-5, so `adapter.get` returns them. If the `adapter.get` return type doesn't surface them, read via `(recvEnv as EncryptedEnvelope | null)?._source`.)
  7. Remove the now-unused `throw new FieldLevelDeferredError`. Keep the `FieldLevelDeferredError` class EXPORTED but mark it `@deprecated` (no longer thrown — kept so existing imports don't break).
  8. The apply loop (223-230) already spreads `w.source` — no change needed for source. (sourceTs handled in Task 4.)

- [ ] **Step 4: Run → pass.** `pnpm --filter @klum-db/lobby test merge-compartment` green; also update/repurpose any existing test asserting `'field-level'` THROWS `FieldLevelDeferredError` — that behavior is gone; rewrite it to assert `'field-level'` now resolves via field-authority (or delete if redundant with the new tests). `pnpm --filter @klum-db/lobby typecheck && pnpm --filter @klum-db/lobby lint`.

- [ ] **Step 5: Commit** — `git commit -am "feat(lobby): field-authority merge strategy + per-field policy (FR-4)"`

---

## Task 4 — klum: record-level takes preserve incoming origin `_sourceTs` (TDD)

**Files:** Modify `packages/lobby/src/interchange/merge-compartment.ts`; Test `packages/lobby/__tests__/merge-compartment.test.ts`.

**Context:** Q2 — `take-incoming`, `lww-by-ts` (incoming wins), and `added` write an incoming record WHOLESALE; they should preserve that record's ORIGIN `_sourceTs` (via Task 1's `put` override) so `source-newest` stays correct across re-merges. (Field-authority MERGED records keep the merge-time stamp + `source:'merged'` — Q3 defer — so they are intentionally excluded here.)

- [ ] **Step 1: Failing test** — append to `merge-compartment.test.ts`:
```ts
it('take-incoming preserves the incoming origin _sourceTs (not merge time)', async () => {
  // incoming c1 written with {source:'firm-A', sourceTs:'2020-05-05T00:00:00.000Z'}
  // receiver has a divergent c1; strategy take-incoming
  await mergeCompartment(receiver, bundle, { transferKey, strategy: 'take-incoming' })
  const meta = await receiver.collection('clients').getMetadata('c1')
  expect(meta?.source).toBe('firm-A')
  expect(meta?.sourceTs).toBe('2020-05-05T00:00:00.000Z')   // origin preserved, not now()
})
```

- [ ] **Step 2: Run → fail.** Receiver `sourceTs` is merge-time, not origin.

- [ ] **Step 3: Implement** in `merge-compartment.ts`:
  1. Add `sourceTs?: string` to the `writes[]` item type (line 162).
  2. At the three wholesale write sites — `added` (line 176), `take-incoming` (line 193), `lww-by-ts` incoming-wins (line 209) — also look up and attach the incoming origin sourceTs:
     ```ts
     const sts = incomingSourceTs.get(<coll>)?.get(<id>)
     writes.push({ collection: <coll>, id: <id>, record: <rec>,
       ...(src !== undefined ? { source: src } : {}),
       ...(sts !== undefined ? { sourceTs: sts } : {}) })
     ```
     (Do NOT add `sourceTs` to the field-authority push — it stays merge-time by design.)
  3. Apply loop (223-230): pass it through:
     ```ts
     await receiver.collection(w.collection).put(w.id, w.record, {
       reason,
       ...(w.source !== undefined ? { source: w.source } : {}),
       ...(w.sourceTs !== undefined ? { sourceTs: w.sourceTs } : {}),
     })
     ```

- [ ] **Step 4: Run → pass.** `pnpm --filter @noy-db/hub build` (Task 1 already built; rebuild if needed) then `pnpm --filter @klum-db/lobby test merge-compartment` green (no regression in the FR-5 provenance-preservation test); `pnpm --filter @klum-db/lobby typecheck && lint`.

- [ ] **Step 5: Commit** — `git commit -am "feat(lobby): record-level takes preserve incoming origin _sourceTs (FR-4 Q2)"`

---

## Task 5 — exports + features.yaml + full verification

**Files:** Modify `packages/lobby/src/index.ts` (or the interchange barrel that re-exports `mergeCompartment`), `features.yaml`.

- [ ] **Step 1: Exports** — re-export from the same barrel that exports `mergeCompartment`/`MergeCompartmentOptions`: `resolveFieldAuthority`, `resolveRecordByFieldAuthority`, `FieldAuthorityPolicyMissingError`, and types `FieldAuthorityRule`, `FieldAuthorityPolicy`, `FieldAuthorityInputs`. Find the existing export site first (grep `mergeCompartment` in `packages/lobby/src`) and mirror it. Confirm with `pnpm --filter @klum-db/lobby typecheck`.
- [ ] **Step 2: features.yaml** — add a `field-authority-merge` entry mirroring the sibling `merge-compartment` / `record-provenance` entries (study them first for exact field shape): artefact `packages/lobby/src/interchange/field-authority.ts` (+ note merge-compartment integration), spec `docs/superpowers/specs/2026-06-16-lobby-framework-design.md` (FR-4), package `@klum-db/lobby`, status `preview`. `node scripts/validate-features.mjs` must pass.
- [ ] **Step 3: Full verification (lint-gap killer):**
```bash
pnpm --filter @noy-db/hub build && pnpm --filter @klum-db/lobby build
pnpm --filter @noy-db/hub test && pnpm --filter @klum-db/lobby test
pnpm lint && pnpm typecheck
node scripts/validate-features.mjs
pnpm check:architecture
```
All green.
- [ ] **Step 4: Commit** — `git commit -am "feat: register field-authority-merge feature + verify"`

---

## Self-Review

**Spec coverage (issue #444):**
- "a record present on both sides with divergent fields merges per the field policy (registry field takes newest-source; sovereign field takes owner)" → Task 3 (wiring) over Task 2 (resolver); the integration test asserts exactly this.
- "policy is declarative + unit-testable in isolation" → Task 2 (pure functions, no I/O, unit tests).
- `ConflictStrategy: 'field-authority'` with rules `source-newest | owner | fixed-source` → Task 2 types + Task 3 strategy.
- Builds on #348 (vocabulary only — overlay is read-only, so FR-4 builds the write resolver), FR-3 (the seam), FR-5 (provenance + the `sourceTs` override).

**Placeholder scan:** every step has concrete code + verified line refs (put 1242/1310, encryptRecord 4239/4250/4252, encryptJsonString 4186/4193, buildDebugEnvelope 4168/4181, putAtTier 4382/4407, merge seam 184-217). The ceiling bump is conditional + explicit.

**Type consistency:** `FieldAuthorityRule`/`FieldAuthorityPolicy`/`FieldAuthorityInputs` defined in Task 2 are used verbatim in Task 3. `resolveRecordByFieldAuthority` signature `(policy, before, incoming, changedFields, io)` matches the Task 3 call. `MergeConflict.resolution` widened to include `'field-merged'` (Task 3).

**Risk notes:** field-authority is only meaningful with `provenance:true` (source-based rules need `_source`); without it, all source-rules fall back to keep-local (safe, never clobbers) — documented in the resolver defaults. Per-field lineage deferred (merged record = record-level `source:'merged'`, merge-time `sourceTs`). The hub `sourceTs` override is guarded (`provenance && source !== undefined`) → zero cost off, no migration. `'field-level'` kept as a deprecated alias so prior callers don't break; `FieldLevelDeferredError` kept exported (no longer thrown). Non-transactional partial-merge caveat is unchanged from FR-3 (already documented).
