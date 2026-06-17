# FR-5: Record provenance (`_source`/`_sourceTs`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Optional per-record lineage — `_source` (opaque source id: which party/registry wrote the record) + `_sourceTs` — written on put/merge, queryable for audit, surfaced to FR-4 (field-authority). Off by default (zero cost); collections opt in.

**Architecture:** Mostly **hub** (envelope metadata + write path + read surface), plus a small **`@klum-db/lobby`** merge integration. New optional unencrypted envelope fields `_source?`/`_sourceTs?` written at the 3 envelope-construction sites when a collection has `provenance: true` AND a `source` is supplied to `put`. Read via a new public `collection.getMetadata(id)` and an opt-in `diffVault(..., {includeMetadata:true})` that populates `VaultDiffEntry.metadata`. `decryptExtractedPartition` surfaces the preserved `_source`/`_sourceTs`; `mergeCompartment` re-stamps the incoming source so a merge preserves provenance. Derived writes get a synthetic source. FR-5 epic #445; spec §7.

**Tech Stack:** TS strict, ESM `.js`, vitest. **collection.ts is at 4725/4730 kernel-ceiling** — Task 1 bumps `KERNEL_SURFACE_BUDGET`.

**Approved decisions:** read surface = **both** `getMetadata` + `diffVault` metadata; scope = **per-record + merge-preserves + derived-mark**; **per-field DEFERRED** (needs prior-record diffing per write; FR-4 revisits).

**⚠️ Lint discipline:** per-package `lint` + full `pnpm lint && pnpm typecheck` before the PR.

---

## File structure
- **Modify** `packages/hub/src/types.ts` — add `_source?`/`_sourceTs?` to `EncryptedEnvelope`; add `metadata?` to `VaultDiff` entry types (or in vault-diff.ts).
- **Modify** `packages/hub/src/collection.ts` — `provenance?` opt-in; `put` options `{reason?, source?}`; inject `_source`/`_sourceTs` at the 3 envelope sites; `getMetadata(id)`; derived-write source.
- **Modify** `scripts/check-architecture.mjs` — bump collection.ts kernel ceiling.
- **Modify** `packages/hub/src/vault-diff.ts` — `DiffOptions.includeMetadata`; populate `VaultDiffEntry.metadata` (receiver-side, opt-in).
- **Modify** `packages/hub/src/bundle/decrypt-partition.ts` — surface `_source`/`_sourceTs` on `DecryptedRecord`.
- **Modify** `packages/lobby/src/interchange/merge-compartment.ts` — stamp incoming source on writes.
- **Modify** `features.yaml` — register `record-provenance`.
- Tests alongside each.

---

## Task 1 — hub: envelope + collection opt-in + write-path source (TDD)

**Files:** `packages/hub/src/types.ts`, `packages/hub/src/collection.ts`, `scripts/check-architecture.mjs`; test `packages/hub/__tests__/provenance.test.ts`.

- [ ] **Step 1: Failing test** `packages/hub/__tests__/provenance.test.ts` (follow an existing collection test for createNoydb/openVault setup):
```typescript
import { describe, it, expect } from 'vitest'
// create an in-memory Noydb + vault
// provenance collection
const prov = vault.collection('clients', { provenance: true })
await prov.put('c1', { id: 'c1', name: 'A' }, { source: 'crm-sync' })
const meta = await prov.getMetadata('c1')          // (getMetadata is Task 2, but assert source written here via re-open/raw if needed)
expect(meta?.source).toBe('crm-sync')
expect(typeof meta?.sourceTs).toBe('string')
// default collection: no provenance, zero cost
const plain = vault.collection('plain')            // no provenance option
await plain.put('p1', { id: 'p1' }, { source: 'x' })  // source ignored (provenance off)
const pmeta = await plain.getMetadata('p1')
expect(pmeta?.source).toBeUndefined()
// provenance:true but no source supplied → no _source written
await prov.put('c2', { id: 'c2', name: 'B' })
expect((await prov.getMetadata('c2'))?.source).toBeUndefined()
```
(If you want Task 1 self-contained without getMetadata, assert via `vault._introspectState().adapter.get(vault.name,'clients','c1')._source`. Either way the assertion is: `_source`/`_sourceTs` present iff provenance:true AND source supplied.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.**
  - `types.ts` `EncryptedEnvelope`: add after `_by`:
    ```typescript
      /** Opaque provenance source id (which party/registry wrote this version). Unencrypted; present only when the collection opts into `provenance` and a source is supplied. */
      readonly _source?: string
      /** ISO-8601 timestamp the provenance source was recorded. */
      readonly _sourceTs?: string
    ```
  - `collection.ts` constructor opts (near `perRecordKeys`, ~754): add `provenance?: boolean | undefined`; in the body set `this.provenance = opts.provenance === true` (add the private field).
  - `put` signature (~1185): change options to `{ readonly reason?: string; readonly source?: string }`. Thread `options?.source` through `putInternal` → `encryptRecord`/`encryptJsonString` (add a `source?: string` param). At the 3 envelope-construction sites (`encryptJsonString` ~4125, `buildDebugEnvelope` ~4108, `putAtTier` ~4330): inject **only when `this.provenance && source !== undefined`**:
    ```typescript
      ...(this.provenance && source !== undefined ? { _source: source, _sourceTs: new Date().toISOString() } : {}),
    ```
    (For `buildDebugEnvelope`/`putAtTier`, thread `source` to them too. The history-snapshot encrypt of the PRIOR version must NOT receive source.)
  - `check-architecture.mjs`: bump the `collection.ts` entry in `KERNEL_SURFACE_BUDGET` from 4730 to **4800** (FR-5 adds ~50 lines; leave headroom). Add a one-line comment noting FR-5 provenance.

- [ ] **Step 4: Run → pass.** `pnpm --filter @noy-db/hub typecheck` + `pnpm --filter @noy-db/hub lint` + `pnpm check:architecture` (ceiling OK) + FULL `pnpm --filter @noy-db/hub test` (no regression — the new envelope fields are optional/additive).

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): record provenance — _source/_sourceTs envelope + collection opt-in + put source"`

---

## Task 2 — hub: read surface (`getMetadata` + `diffVault` metadata) (TDD)

**Files:** `packages/hub/src/collection.ts`, `packages/hub/src/vault-diff.ts`; tests.

- [ ] **Step 1: Failing tests** — (a) `getMetadata` returns `{version,timestamp,by?,source?,sourceTs?}` for a provenance record + `null` for missing; (b) `diffVault(receiver, candidate, {includeMetadata:true})` → `modified`/`added` entries carry `metadata.source` for the RECEIVER record; without the flag, `metadata` is undefined (zero cost).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.**
  - `collection.ts` — public method:
    ```typescript
    /** Read a record's unencrypted metadata (version, timestamps, provenance) without decrypting the body. Returns null if absent. */
    async getMetadata(id: string): Promise<{ readonly version: number; readonly timestamp: string; readonly by?: string; readonly source?: string; readonly sourceTs?: string } | null> {
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env) return null
      return { version: env._v, timestamp: env._ts, ...(env._by !== undefined ? { by: env._by } : {}), ...(env._source !== undefined ? { source: env._source } : {}), ...(env._sourceTs !== undefined ? { sourceTs: env._sourceTs } : {}) }
    }
    ```
    (Use the same `adapter`/`vault`/`name` fields the class already uses internally.)
  - `vault-diff.ts` — add `includeMetadata?: boolean` to `DiffOptions`; add optional `metadata?: { source?: string; sourceTs?: string; by?: string; version: number; timestamp: string }` to `VaultDiffEntry`. When `includeMetadata`, the receiver-side normalisation reads each record's envelope (via the vault's adapter) and attaches `metadata`. Keep it **receiver-side + opt-in** (default off = zero extra reads, no behavior change for existing callers). (The candidate/incoming side has no envelope; its provenance reaches FR-4 via `decryptExtractedPartition` in Task 3.)

- [ ] **Step 4: Run → pass.** typecheck + lint + full hub test.
- [ ] **Step 5: Commit** — `git commit -am "feat(hub): provenance read surface — collection.getMetadata + diffVault includeMetadata"`

---

## Task 3 — hub: derived-write source + `decryptExtractedPartition` surfacing (TDD)

**Files:** `packages/hub/src/collection.ts` (derived writes), `packages/hub/src/bundle/decrypt-partition.ts`; tests.

- [ ] **Step 1: Failing tests** — (a) a derived output record's `_source` is a synthetic marker (e.g. `'derived'` or `'derived:<spec>'`) when the output collection has `provenance:true`; (b) `decryptExtractedPartition` on a bundle extracted from a provenance collection returns `DecryptedRecord` carrying `source`/`sourceTs` (the extracted envelope preserved them via `extractPartition`'s `{...env}` spread).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.**
  - Derived writes (`collection.ts` ~1971/2026/2043, `dispatchDerivations`): pass `{ source: <synthetic> }` to the `outputCollection.put(...)` calls — synthetic = `'derived'` (or `derived:${spec.source}` if the spec names a source). Only matters when the output collection has provenance on.
  - `decrypt-partition.ts` `DecryptedRecord`: add `readonly source?: string` + `readonly sourceTs?: string`; populate from `env._source`/`env._sourceTs` in the decrypt loop (`...(env._source !== undefined ? { source: env._source } : {})`).

- [ ] **Step 4: Run → pass.** typecheck + lint + full hub test.
- [ ] **Step 5: Commit** — `git commit -am "feat(hub): mark derived-write provenance + surface _source on decryptExtractedPartition"`

---

## Task 4 — klum: `mergeCompartment` preserves provenance (TDD)

**Files:** `packages/lobby/src/interchange/merge-compartment.ts`; test.

- [ ] **Step 1: Failing test** — source vault has `clients` with `provenance:true`, c1 put with `{source:'firm-A'}`; extract → bundle; receiver has `clients` with `provenance:true`; `mergeCompartment(receiver, bundle, {transferKey, strategy:'take-incoming'})`; then `receiver.collection('clients').getMetadata('c1')` → `source === 'firm-A'` (the merge preserved the incoming provenance).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** `mergeCompartment` already decrypts incoming via `decryptExtractedPartition` (now carrying `source`/`sourceTs`, Task 3). When applying a write, pass the incoming record's source: `await receiver.collection(w.collection).put(w.id, w.record, { reason, ...(w.source !== undefined ? { source: w.source } : {}) })`. Thread `source` from the decrypted record into the `writes[]` entries (add `source?` to the write item, set from the matching `DecryptedRecord.source`). (Only effective if the receiver collection has provenance on — otherwise the source is silently ignored, which is correct.)

- [ ] **Step 4: Run → pass.** `pnpm --filter @noy-db/hub build` first; then lobby test + typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -am "feat(lobby): mergeCompartment preserves incoming provenance (_source)"`

---

## Task 5 — exports + features.yaml + full verification

**Files:** `packages/hub/src/index.ts` (if any new type needs exporting — `getMetadata` is a method, no export; `DiffOptions`/`VaultDiffEntry` already exported, just gained optional fields), `features.yaml`.

- [ ] **Step 1: Exports** — confirm `VaultDiffEntry`/`DiffOptions` (now with `metadata`/`includeMetadata`) are exported from `@noy-db/hub` (they were per the grounding). No new top-level symbol beyond the optional fields. `getMetadata` is a `Collection` method (auto-available). Add nothing unless typecheck shows a missing export.
- [ ] **Step 2: features.yaml** — add `record-provenance` entry, mirroring a recent hub feature entry; artefact `packages/hub/src/collection.ts` (+ note the envelope), spec the lobby-framework spec (FR-5), package `@noy-db/hub`, status `preview`. `node scripts/validate-features.mjs` must pass.
- [ ] **Step 3: Full verification (lint-gap killer):**
```bash
pnpm --filter @noy-db/hub build && pnpm --filter @klum-db/lobby build
pnpm --filter @noy-db/hub test && pnpm --filter @klum-db/lobby test
pnpm lint && pnpm typecheck          # full monorepo
node scripts/validate-features.mjs
pnpm check:architecture              # collection.ts under the bumped ceiling
```
All green.
- [ ] **Step 4: Commit** — `git commit -am "feat: register record-provenance feature + verify"`

---

## Self-Review

**Spec coverage (issue #445):**
- "a put records `_source`/`_sourceTs`" → Task 1 (write path, opt-in).
- "a merge preserves the winning field's provenance" → Task 4 (record-level: mergeCompartment stamps incoming source) + Task 3 (surfacing). (Per-FIELD provenance deferred per the approved scope.)
- "provenance is queryable for audit" → Task 2 (`getMetadata` + `diffVault` metadata).
- "disabled collections are unaffected" → Task 1 (zero injection unless `provenance:true` + source); Task 2 metadata is opt-in.

**Placeholder scan:** every step has concrete code/sites; verified line refs (envelope sites 4108/4125/4330, put 1185, derived 1971/2026/2043, VaultDiffEntry, decrypt-partition). The ceiling bump is explicit (4730→4800).

**Risk notes:** envelope fields are OPTIONAL + additive (no migration; old envelopes lack them → undefined). Write-path injection is guarded by `this.provenance && source!==undefined` (zero cost off). diffVault metadata is opt-in (`includeMetadata`) → no perf change for existing callers. collection.ts ceiling raised first (raise-first playbook). Per-field provenance explicitly out of scope. The history-snapshot encrypt of the prior version must NOT carry source (it's not a new write) — called out in Task 1.
