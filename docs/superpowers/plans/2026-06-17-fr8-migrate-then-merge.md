# FR-8 — Migrate-then-Merge (upgrade incoming bundle before reconcile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-class two-stage pipeline `migrateThenMerge(receiver, compartmentBytes, opts)` that upgrades an older-schema incoming compartment to the receiver's current schema version **in staging**, then runs the FR-3/FR-4 merge against a now schema-homogeneous pair — so the merge engine never branches on version.

**Architecture:** Mostly **`@klum-db/lobby`** (the coordinator + a refactor of a shared decrypted-records merge core out of `mergeCompartment`). Two small **hub** touches: (1) `Collection.validateInput(record)` so migration can pre-validate staged records before any write (staging safety); (2) a `schemaVersion?` field on `CompartmentManifest` that FR-2's extract stamps from the source vault's fence, so the bundle self-describes its version.

**Tech stack:** TypeScript, vitest, pnpm workspaces. Hub: `packages/hub`. Klum: `packages/lobby`.

**Design decisions (resolved at the FR-8 design gate):**
- **Upgrade mechanism → app-supplied transforms + additive fast-path.** The app supplies a per-collection migration chain (transforms keyed by target version); FR-8 applies `fromVersion → toVersion` in staging. The **additive fast-path** is realized via **pre-write validation**: a collection with NO supplied transform still passes when the old shape validates against the receiver schema (additive-only evolution); a non-additive drift without a transform fails *before any write* with an actionable error. (This is a deliberate refinement of the gate's "computeSchemaDelta over carried `_schemas`" wording — pre-write validation reuses the real validator and avoids fragile JSON-schema introspection of the receiver's `StandardSchemaV1`. `computeSchemaDelta` remains available for a richer proactive diagnostic as a follow-up.)
- **Version source → stamped into the bundle.** FR-2's `extractCrossVaultPartition` reads the source vault's `schemaFenceState().currentSchemaVersion` and stamps `schemaVersion` into each `CompartmentManifest` entry. The caller reads it from the manifest (`readNoydbBundleManifest`) and passes `fromVersion`; an `assumeFromVersion` fallback covers older bundles that lack the field.
- **API → separate `migrateThenMerge` coordinator**, built on a `mergeDecryptedRecords` core refactored out of `mergeCompartment`. Newer-than-receiver bundles are refused with an actionable `MinVersionError`.

**Staging-safety guarantee:** all transforms are applied to in-memory decrypted records and **all** staged records are validated (`validateInput`) before `mergeDecryptedRecords` writes anything — a failed upgrade (throwing transform OR invalid output) never half-writes the receiver. (The merge write loop itself remains non-transactional per the existing FR-3 caveat.)

---

## File structure

- **Modify** `packages/hub/src/collection.ts` — add public `validateInput(record)`. (Task 1)
- **Modify** `packages/hub/src/bundle/multi-bundle.ts` — add `schemaVersion?: number` to `CompartmentManifest`. (Task 2)
- **Modify** `packages/lobby/src/interchange/extract-cross-vault.ts` — stamp `schemaVersion` from `v.schemaFenceState()`. (Task 2)
- **Modify** `packages/lobby/src/interchange/merge-compartment.ts` — extract a shared `mergeDecryptedRecords(receiver, decrypted, opts)` core; `mergeCompartment` delegates to it. (Task 3)
- **Create** `packages/lobby/src/interchange/migrate-then-merge.ts` — the coordinator + `MigrationStep`/options/`MinVersionError`/`MigrationTransformRequiredError`/report types. (Task 4)
- **Modify** `packages/lobby/src/index.ts` (barrel) — export the new public API. (Task 5)
- **Modify** `features.yaml` — register `migrate-then-merge`. (Task 5)
- **Tests:** `packages/hub/__tests__/` (Task 1 validateInput; Task 2 schemaVersion stamp — find the cross-vault extract test file), `packages/lobby/__tests__/migrate-then-merge.test.ts` (Task 4), and the additive fast-path / refusal cases (Task 4).

---

## Task 1 — hub: `Collection.validateInput(record)` (TDD)

**Files:** Modify `packages/hub/src/collection.ts`; Test `packages/hub/__tests__/` (append to an existing schema/validation test, or create `validate-input.test.ts`).

**Context:** `putInternal` validates via `validateSchemaInput(this.schema, record, ...)` (~line 1370). FR-8 needs to validate a record WITHOUT writing, to pre-check all staged records before the merge writes. Expose a thin public wrapper. `validateSchemaInput` is already imported in `collection.ts` (used by putInternal); confirm the import.

- [ ] **Step 1: Failing test** — create `packages/hub/__tests__/validate-input.test.ts` (reuse a sibling test's vault-open + zod-schema helper; mirror how existing schema tests declare a `collection({ schema })`):
```ts
import { describe, it, expect } from 'vitest'
// ... imports mirrored from an existing schema test (createNoydb, memory, zod or the repo's schema lib)

describe('Collection.validateInput', () => {
  it('returns the record when it matches the schema', async () => {
    const c = /* open a collection with a schema requiring { id: string, n: number } */
    await expect(c.validateInput({ id: 'a', n: 1 })).resolves.toEqual({ id: 'a', n: 1 })
  })
  it('throws when the record violates the schema (without writing)', async () => {
    const c = /* same collection */
    await expect(c.validateInput({ id: 'a', n: 'not-a-number' } as never)).rejects.toThrow()
    // and nothing was written:
    expect(await c.get('a')).toBeNull()
  })
  it('passes any record through when the collection has no schema', async () => {
    const c = /* open a collection WITHOUT a schema */
    await expect(c.validateInput({ anything: true } as never)).resolves.toEqual({ anything: true })
  })
})
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @noy-db/hub test validate-input` → `validateInput is not a function`.

- [ ] **Step 3: Implement.** Add a public method on `Collection` (place near `put`, after `putInternal` or beside the other public read methods). Confirm the schema field name (`this.schema`) and the `validateSchemaInput` import from `./schema.js`:
```ts
/**
 * Validate a record against this collection's schema WITHOUT writing it.
 * Returns the (possibly coerced) record on success; throws SchemaValidationError
 * (direction: 'input') on violation. A no-op pass-through when no schema is declared.
 * Used by FR-8 migrate-then-merge to pre-validate staged records before any write.
 */
async validateInput(record: T): Promise<T> {
  if (this.schema === undefined) return record
  return validateSchemaInput(this.schema, record, `validateInput(${this.name})`)
}
```

- [ ] **Step 4: Run → pass.** `pnpm --filter @noy-db/hub test validate-input` green; full `pnpm --filter @noy-db/hub test` (no regression); `pnpm --filter @noy-db/hub typecheck && lint`; `pnpm check:architecture` (collection.ts is ~4810 against the 4810 ceiling after FR-4 — this adds ~10 lines; **bump the ceiling to 4830** in `scripts/check-architecture.mjs` and note it).

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): Collection.validateInput — validate a record without writing (FR-8 staging)"`

---

## Task 2 — hub + klum: stamp `schemaVersion` into the bundle manifest (TDD)

**Files:** Modify `packages/hub/src/bundle/multi-bundle.ts` (add field); Modify `packages/lobby/src/interchange/extract-cross-vault.ts` (stamp it); Test the cross-vault extract test in `packages/lobby/__tests__/`.

**Context:** `CompartmentManifest` has no schema-version stamp. FR-2's `extractCrossVaultPartition` (extract-cross-vault.ts:215) already loops per vault with the open `Vault v`; `v.schemaFenceState()` returns `{ currentSchemaVersion, fenceState }`. Stamp `currentSchemaVersion` into each manifest entry so the bundle self-describes its version. Additive + optional → old readers ignore it.

- [ ] **Step 1: Failing test** — find the existing cross-vault extract test (grep `extractCrossVaultPartition` in `packages/lobby/__tests__/`). Append a test: build a source vault, run a schema cutover (or directly assert version 0 if no cutover helper is handy — match what the test harness supports), `extractCrossVaultPartition`, read the manifest via `readNoydbBundleManifest`, assert the compartment entry has `schemaVersion` equal to the source vault's `schemaFenceState().currentSchemaVersion`.
```ts
it('stamps each compartment schemaVersion from the source vault fence', async () => {
  // ... build vaults + seed, extract
  const { bundle } = await extractCrossVaultPartition(openVault, { seed, crossVaultRefs })
  const manifest = readNoydbBundleManifest(bundle)
  const expected = (await (await openVault('clients')).schemaFenceState()).currentSchemaVersion
  const entry = manifest.compartments.find(c => /* match the clients compartment */)
  expect(entry?.schemaVersion).toBe(expected)
})
```

- [ ] **Step 2: Run → fail.** `schemaVersion` is undefined on the entry.

- [ ] **Step 3: Implement.**
  1. `multi-bundle.ts` `CompartmentManifest` (after `innerSha256`, ~line 49): add
     ```ts
     /** Source vault's schema fence version at extract time (FR-8). Opt-in; absent on older bundles. */
     readonly schemaVersion?: number
     ```
  2. `extract-cross-vault.ts` in the per-vault loop (after building `entry`, before `inner.push`, ~line 245): read the fence and stamp:
     ```ts
     const fence = await v.schemaFenceState()
     entry.schemaVersion = fence.currentSchemaVersion
     ```
     (The `entry` is already the mutable `-readonly` mapped type, so direct assignment is fine.)
  3. Check `writeMultiVaultBundle` in `multi-bundle.ts` — if it also builds `CompartmentManifest` entries from live vaults, stamp `schemaVersion` there too (read each vault's `schemaFenceState()`); if it doesn't have the vault handy, leave the field absent (optional). Note which you did.

- [ ] **Step 4: Run → pass.** `pnpm --filter @noy-db/hub build` (manifest type changed) then `pnpm --filter @klum-db/lobby test` (extract test + no regression); `pnpm --filter @noy-db/hub test` (multi-bundle codec round-trips the new field — verify the encode/decode/innerBytes cross-checks still pass); typecheck + lint both packages.

- [ ] **Step 5: Commit** — `git commit -am "feat: stamp source schemaVersion into CompartmentManifest (FR-8 version source)"`

---

## Task 3 — klum: refactor a shared `mergeDecryptedRecords` core out of `mergeCompartment` (TDD-by-existing-tests)

**Files:** Modify `packages/lobby/src/interchange/merge-compartment.ts`.

**Context:** `mergeCompartment` (merge-compartment.ts:129) currently does `decrypt → build candidate/maps → diff → resolve → write`. FR-8 needs to run the SAME merge over records it has already decrypted + migrated. Extract everything after decryption into a reusable core; `mergeCompartment` becomes decrypt-then-core. **No behavior change** — the existing 110+ merge-compartment tests are the guard.

- [ ] **Step 1: Establish green baseline.** `pnpm --filter @klum-db/lobby test merge-compartment` → all pass (this is the refactor's safety net; no new test first — the refactor must preserve behavior).

- [ ] **Step 2: Refactor.** Introduce:
```ts
/**
 * Merge an already-decrypted record set into the receiver. The shared core of
 * mergeCompartment (decrypt → this) and migrateThenMerge (decrypt → migrate → this).
 * `decrypted` is keyed by collection; each record carries id/record/ts/source/sourceTs.
 */
export async function mergeDecryptedRecords(
  receiver: Vault,
  decrypted: Record<string, readonly DecryptedRecord[]>,
  opts: MergeCompartmentOptions,
): Promise<MergeReport> {
  const reason = opts.reason ?? 'merge:compartment'
  // ... everything currently in mergeCompartment AFTER the decrypt call:
  //     build incomingTs / incomingSource / incomingSourceTs / candidate,
  //     diffVault, resolve (added/modified strategies incl. field-authority),
  //     apply writes (gated by !dryRun), aggregate summary, return report.
}
```
  Then `mergeCompartment` collapses to:
```ts
export async function mergeCompartment(
  receiver: Vault,
  compartmentBytes: Uint8Array,
  opts: MergeCompartmentOptions,
): Promise<MergeReport> {
  const incoming = await decryptExtractedPartition(compartmentBytes, opts.transferKey)
  return mergeDecryptedRecords(receiver, incoming, opts)
}
```
  - Import `DecryptedRecord` type: `import { decryptExtractedPartition, type DecryptedRecord } from '@noy-db/hub/bundle'`.
  - Keep `opts.transferKey` on `MergeCompartmentOptions` (mergeCompartment still needs it to decrypt); `mergeDecryptedRecords` ignores it (or accept a trimmed opts type — simplest is to reuse `MergeCompartmentOptions` and just not read `transferKey` in the core).
  - Move the `incomingSourceTs`/`incomingSource`/`incomingTs` map-building and the whole resolve+write body verbatim into the core.

- [ ] **Step 3: Run → still green.** `pnpm --filter @klum-db/lobby test merge-compartment` → all pass unchanged; `pnpm --filter @klum-db/lobby typecheck && lint`.

- [ ] **Step 4: Commit** — `git commit -am "refactor(lobby): extract mergeDecryptedRecords core from mergeCompartment (FR-8 prep)"`

---

## Task 4 — klum: `migrateThenMerge` coordinator (TDD)

**Files:** Create `packages/lobby/src/interchange/migrate-then-merge.ts`; Test `packages/lobby/__tests__/migrate-then-merge.test.ts`.

**Context:** The coordinator: decrypt → resolve `fromVersion`/`toVersion` → refuse if newer → apply transforms in staging → pre-validate all staged records → `mergeDecryptedRecords`. `toVersion` defaults to `receiver.schemaFenceState().currentSchemaVersion`. Step 0: `pnpm --filter @noy-db/hub build` (Tasks 1+2 changed hub).

- [ ] **Step 1: Failing tests** — create `migrate-then-merge.test.ts`. Reuse the merge-compartment test's extraction helpers. Build a source vault whose records are at an OLDER shape (e.g. `{ id, fullName }`) and a receiver whose schema is the NEW shape (e.g. `{ id, firstName, lastName }`); supply a migration that splits `fullName`. Cases:
```ts
// (a) older bundle migrates then merges, zero version-branching downstream
it('migrates an older-schema compartment to the receiver version, then merges', async () => {
  const report = await migrateThenMerge(receiver, compartmentBytes, {
    transferKey,
    fromVersion: 0,
    toVersion: 1,
    strategy: 'take-incoming',
    migrations: { clients: [{ toVersion: 1, transform: (r) => {
      const [firstName, ...rest] = String(r.fullName).split(' ')
      return { id: r.id, firstName, lastName: rest.join(' ') }
    } }] },
  })
  expect(report.summary.inserted + report.summary.updated).toBeGreaterThan(0)
  const merged = await receiver.collection('clients').get('c1')
  expect(merged).toMatchObject({ firstName: 'Jane', lastName: 'Doe' })
})

// (b) newer-than-receiver bundle refused with MinVersionError
it('refuses a newer-than-receiver bundle with an actionable MinVersionError', async () => {
  await expect(migrateThenMerge(receiver, compartmentBytes, {
    transferKey, fromVersion: 5, toVersion: 1, strategy: 'take-incoming',
  })).rejects.toThrow(MinVersionError)
})

// (c) additive fast-path: no transform needed when old shape still validates
it('additive evolution merges with no transform supplied', async () => {
  // receiver schema adds an OPTIONAL field vs the incoming shape
  const report = await migrateThenMerge(receiver, compartmentBytes, {
    transferKey, fromVersion: 0, toVersion: 1, strategy: 'take-incoming',
  })
  expect(report.summary.total).toBeGreaterThan(0)   // no MigrationTransformRequiredError
})

// (d) staging safety: a non-additive drift with NO transform throws BEFORE any write
it('throws MigrationTransformRequiredError before writing when a transform is required', async () => {
  await expect(migrateThenMerge(receiver, compartmentBytes, {
    transferKey, fromVersion: 0, toVersion: 1, strategy: 'take-incoming',
  })).rejects.toThrow(/transform required|MigrationTransformRequired/)
  // receiver untouched:
  expect(await receiver.collection('clients').get('c1')).toBeNull()
})

// (e) same-version bundle merges directly (no migration)
it('merges directly when fromVersion === toVersion', async () => { /* ... */ })
```

- [ ] **Step 2: Run → fail.** Module not found.

- [ ] **Step 3: Implement** — create `migrate-then-merge.ts`:
```ts
/**
 * @klum-db/lobby interchange — migrate-then-merge (FR-8). Upgrade an incoming
 * compartment to the receiver's schema version IN STAGING, then merge.
 * @module
 */
import type { Vault } from '@noy-db/hub'
import { decryptExtractedPartition, type DecryptedRecord } from '@noy-db/hub/bundle'
import {
  mergeDecryptedRecords,
  type MergeCompartmentOptions,
  type MergeReport,
} from './merge-compartment.js'

/** One upgrade step: transform a record up to `toVersion`. */
export interface MigrationStep {
  readonly toVersion: number
  readonly transform: (record: Record<string, unknown>) => Record<string, unknown>
}

export interface MigrateThenMergeOptions extends MergeCompartmentOptions {
  /** Incoming bundle's schema version. Read from CompartmentManifest.schemaVersion (FR-8). */
  readonly fromVersion?: number
  /** Fallback when the bundle manifest carries no schemaVersion. */
  readonly assumeFromVersion?: number
  /** Target version. Defaults to the receiver's fence currentSchemaVersion. */
  readonly toVersion?: number
  /** Per-collection ordered upgrade steps. */
  readonly migrations?: Record<string, readonly MigrationStep[]>
}

export interface MigrateThenMergeReport extends MergeReport {
  readonly migration: {
    readonly fromVersion: number
    readonly toVersion: number
    /** Per-collection: how the records reached the target version. */
    readonly byCollection: Record<string, 'transformed' | 'additive-no-transform' | 'same-version'>
  }
}

/** Thrown when the incoming bundle is NEWER than the receiver — receiver must upgrade first. */
export class MinVersionError extends Error {
  constructor(public readonly fromVersion: number, public readonly toVersion: number) {
    super(
      `migrateThenMerge: incoming bundle is at schema version ${fromVersion} but the receiver ` +
        `is at ${toVersion}. Upgrade the receiver to at least v${fromVersion} before merging ` +
        `(a newer bundle cannot be down-migrated).`,
    )
    this.name = 'MinVersionError'
  }
}

/** Thrown (BEFORE any write) when a collection needs a transform that wasn't supplied. */
export class MigrationTransformRequiredError extends Error {
  constructor(public readonly collection: string, public readonly cause?: unknown) {
    super(
      `migrateThenMerge: collection "${collection}" did not validate against the receiver schema ` +
        `after migration and no transform was supplied to reach the target version. Provide a ` +
        `migration step for "${collection}". Underlying: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'MigrationTransformRequiredError'
  }
}

export async function migrateThenMerge(
  receiver: Vault,
  compartmentBytes: Uint8Array,
  opts: MigrateThenMergeOptions,
): Promise<MigrateThenMergeReport> {
  const toVersion = opts.toVersion ?? (await receiver.schemaFenceState()).currentSchemaVersion
  const fromVersion = opts.fromVersion ?? opts.assumeFromVersion
  if (fromVersion === undefined) {
    throw new Error(
      'migrateThenMerge: cannot determine the incoming schema version. Pass fromVersion ' +
        '(read from the bundle manifest CompartmentManifest.schemaVersion) or assumeFromVersion.',
    )
  }
  if (fromVersion > toVersion) throw new MinVersionError(fromVersion, toVersion)

  // 1. Decrypt (records only — _schemas is a separate bundle section, not surfaced).
  const incoming = await decryptExtractedPartition(compartmentBytes, opts.transferKey)

  // 2. STAGING: transform + pre-validate every record before any write.
  const migrationByCollection: Record<string, 'transformed' | 'additive-no-transform' | 'same-version'> = {}
  const staged: Record<string, DecryptedRecord[]> = {}

  for (const [coll, recs] of Object.entries(incoming)) {
    const steps = (opts.migrations?.[coll] ?? [])
      .filter((s) => s.toVersion > fromVersion && s.toVersion <= toVersion)
      .slice()
      .sort((a, b) => a.toVersion - b.toVersion)

    const out: DecryptedRecord[] = []
    for (const r of recs) {
      let body = r.record
      for (const step of steps) body = step.transform(body)   // throwing transform → caught by caller, nothing written
      out.push({ ...r, record: body })
    }
    staged[coll] = out

    if (fromVersion === toVersion) migrationByCollection[coll] = 'same-version'
    else if (steps.length > 0) migrationByCollection[coll] = 'transformed'
    else migrationByCollection[coll] = 'additive-no-transform'

    // pre-validate ALL staged records against the receiver schema (staging safety).
    const rc = receiver.collection(coll)
    for (const r of out) {
      try {
        await rc.validateInput(r.record as never)
      } catch (cause) {
        throw new MigrationTransformRequiredError(coll, cause)
      }
    }
  }

  // 3. Merge the (now homogeneous) staged records — engine never branches on version.
  const report = await mergeDecryptedRecords(receiver, staged, opts)
  return { ...report, migration: { fromVersion, toVersion, byCollection: migrationByCollection } }
}
```
  - Confirm `receiver.schemaFenceState()` is on the public `Vault` type exported from `@noy-db/hub` (it is — vault.ts:1124). If the exported `Vault` type doesn't surface it, use `receiver._introspectState()`-style access or widen as needed; report if so.
  - `validateInput` accepts `T`; pass `r.record as never` (the core merge already treats records as `Record<string, unknown>`).

- [ ] **Step 4: Run → pass.** All five cases green; `pnpm --filter @klum-db/lobby test` (full, no regression); typecheck + lint.

- [ ] **Step 5: Commit** — `git commit -am "feat(lobby): migrateThenMerge coordinator — staged upgrade then merge (FR-8)"`

---

## Task 5 — exports + features.yaml + full verification

**Files:** Modify `packages/lobby/src/index.ts` (barrel), `features.yaml`.

- [ ] **Step 1: Exports** — from the barrel that exports `mergeCompartment` (grep `mergeCompartment` in `packages/lobby/src/index.ts`), also export: `migrateThenMerge`, `mergeDecryptedRecords`, `MinVersionError`, `MigrationTransformRequiredError`, and types `MigrationStep`, `MigrateThenMergeOptions`, `MigrateThenMergeReport`. Verify `pnpm --filter @klum-db/lobby typecheck`.
- [ ] **Step 2: features.yaml** — add a `migrate-then-merge` entry mirroring the sibling `merge-compartment` / `field-authority-merge` entries (study them for exact shape): artefact `packages/lobby/src/interchange/migrate-then-merge.ts`, spec `docs/superpowers/specs/2026-06-16-lobby-framework-design.md` (FR-8), package `@klum-db/lobby`, status `preview`, related `[merge-compartment, field-authority-merge, cross-vault-extraction]`. `node scripts/validate-features.mjs` must pass.
- [ ] **Step 3: Full verification (lint-gap killer):**
```bash
pnpm --filter @noy-db/hub build && pnpm --filter @klum-db/lobby build
pnpm --filter @noy-db/hub test && pnpm --filter @klum-db/lobby test
pnpm lint && pnpm typecheck
node scripts/validate-features.mjs
pnpm check:architecture
```
All green.
- [ ] **Step 4: Commit** — `git commit -am "feat: register migrate-then-merge feature + verify"`

---

## Self-Review

**Spec coverage (issue #448):**
- "an older-schema compartment is migrated to the receiver version, then merges with zero version-branching" → Task 4 case (a) + Task 3 (the merge core operates on homogeneous records; no version branch anywhere in `mergeDecryptedRecords`).
- "a newer-than-receiver bundle is refused with an actionable `minVersion` message" → Task 4 `MinVersionError` + case (b).
- "migration runs in staging — a failed upgrade never half-writes the target" → Task 4 (transforms applied in-memory + `validateInput` pre-check on ALL staged records before `mergeDecryptedRecords`) + case (d) asserts the receiver is untouched; Task 1 provides the validation primitive.
- Builds on `carrySchemas` (#204, already default-on in FR-2 extract), the fence `currentSchemaVersion` (#271 schema lifecycle), FR-3 (the merge core), FR-4 (field-authority flows through the same core).

**Placeholder scan:** every code step has concrete contents; verified refs (extract loop extract-cross-vault.ts:227-263, CompartmentManifest multi-bundle.ts:33-50, `schemaFenceState` vault.ts:1124, `validateSchemaInput` schema.ts:134, mergeCompartment 129-249). Test bodies are concrete except where they reuse the existing extraction harness (called out explicitly, not a placeholder).

**Type consistency:** `MigrateThenMergeOptions extends MergeCompartmentOptions` (so `transferKey`/`strategy`/`fieldAuthority`/`dryRun`/`reason` flow through to the core). `mergeDecryptedRecords(receiver, Record<string, readonly DecryptedRecord[]>, MergeCompartmentOptions)` — Task 3 signature matches the Task 4 call. `MigrateThenMergeReport extends MergeReport` + `migration`. `MigrationStep.toVersion`/`transform` used verbatim in the apply loop.

**Risk notes:** the additive fast-path is realized via pre-write validation (documented refinement of the gate's computeSchemaDelta wording — same outcome, robust). `schemaVersion` manifest field is additive/optional (old bundles → undefined → `assumeFromVersion` required). `validateInput` is a no-op when no schema is declared (so schemaless receivers accept any shape — the fast-path then always "passes", which is correct: no schema = no constraint). collection.ts ceiling raised first (4810→4830). The merge write loop stays non-transactional (pre-existing FR-3 caveat) — but the UPGRADE is fully staged, satisfying the acceptance criterion. `mergeDecryptedRecords` is exported (Task 3) so it's a tested, reusable seam for future coordinators (e.g. FR-6 graduate()).
