# FR-7 — Surface / Scoped Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Surface** — a persisted, bilaterally-agreed subset (`{collections, fields?, direction, conflictPolicy, cadence?}`) two parties sync. A surface syncs only its named collections/fields, in its direction, applying its conflict policy; **collections/fields outside the surface never leave the vault**.

**Architecture:** `@klum-db/lobby` orchestration over the StateManagementVault persistence pattern, reusing FR-2 `extractPartition` (the scoped slice) + FR-3/4 `mergeCompartment` (apply with conflict policy). One net-new `@noy-db/hub` primitive: **structural field projection** during extract (`fieldProjection` on `reKeyClosure`). Field scoping = structural redaction at the export boundary (excluded fields are dropped before re-encryption, so they're never in the transmitted slice — not cryptographic intra-vault hiding, which is irrelevant for sync). The raw SyncEngine is NOT used (it copies ciphertext and can't project fields).

**Tech stack:** TypeScript, vitest, pnpm. `@noy-db/hub` (extract projection), `@klum-db/lobby` (Surface).

**Design decisions (resolved at the FR-7 gate):**
- **Field scoping → structural field projection now** (drop non-surface fields before re-encryption).
- **Surface → persisted + scheduled** (a `surfaces` collection in the StateManagementVault; a propose/agree bilateral handshake; a host-driven cadence scheduler).
- Reuse FR-2 extract + FR-3/4 merge; SyncEngine not used; transfer key is per-run (out-of-band, like FR-2/3), not persisted.
- No row-level predicate (not in #447's Surface shape).

---

## Key existing surfaces (from recon)
- `extractPartition(vault, WalkClosureOptions & {compression?, carrySchemas?, carryLedger?})` (`packages/hub/src/bundle/extract-partition.ts:247`). `WalkClosureOptions{ seeds: Record<collection,(rec)=>boolean>, maxDepth? }`. The re-key loop is `reKeyClosure` (`:53-76`) with TWO branches (per-record CEK `:57-70` + standard DEK `:72-75`); `reKeySchemas` (`:89-108`) carries `_schemas/<collection>` when `carrySchemas`. No `collections` allowlist option — `seeds` keys ARE the starting collections; `maxDepth` bounds ref-following.
- `mergeCompartment(receiver, bundleBytes, {transferKey, strategy, dryRun?, reason?, fieldAuthority?})` → MergeReport (`packages/lobby/src/interchange/merge-compartment.ts:312`). `MergeStrategy = take-incoming|keep-local|lww-by-ts|manual-queue|field-authority`.
- `StateManagementVault.open(db)` (`packages/lobby/src/federation/state-vault.ts`) opens `STATE_VAULT_NAME`, binds typed `collection<T>()` handles (registry/manifest/events/migrationStatus); `appendEvent` uses `Date.now()`. Pattern: add a 5th `surfaces` collection.
- Two-party harness: two `createNoydb({store: sharedStore, ...})` over a SHARED store both `StateManagementVault.open()` the same `_state` vault (federation-fleet-migration.test.ts:178 "session 2 over same store"; tab-write-propagation.test.ts:65 twoTabs).
- Lobby files have NO kernel ceilings; extract-partition.ts has none either. Only the `no-outbound-klum-import` guard applies (FR-7 stays klum→noy clean).

---

## File structure
- **Modify** `packages/hub/src/bundle/extract-partition.ts` — `fieldProjection` on `extractPartition` + `reKeyClosure` + `reKeySchemas` skip. (Task 1)
- **Modify** `packages/lobby/src/federation/state-vault.ts` + `federation/types.ts` — `SurfaceRow` + `surfaces` collection + CRUD. (Task 2)
- **Create** `packages/lobby/src/interchange/surface.ts` — handshake + exportSurface/applySurface + cadence. (Tasks 3-5)
- **Modify** `packages/lobby/src/index.ts` — Lobby Surface methods + exports. (Task 4/5)
- **Modify** `features.yaml`. (Task 6)
- **Tests:** `packages/hub/__tests__/extract-field-projection.test.ts` (T1); `packages/lobby/__tests__/surface-*.test.ts` (T2-5).

---

## Task 1 — hub: `fieldProjection` in extract (structural redaction) (TDD) — RISKIEST

**Files:** `packages/hub/src/bundle/extract-partition.ts`. Test `packages/hub/__tests__/extract-field-projection.test.ts`.

**Context:** Add `fieldProjection?: Record<string, readonly string[]>` to `extractPartition` opts, threaded into `reKeyClosure`. In the re-key loop, between `decrypt` and `encrypt` (BOTH the CEK branch and the DEK branch), if the collection has a projection: `JSON.parse(plaintext)` → keep only listed fields + ALWAYS `id` → `JSON.stringify`. A projected collection must be SKIPPED in `reKeySchemas` (the narrowed shape ≠ the stored schema).

- [ ] **Step 1: Failing test** — create `extract-field-projection.test.ts`. Mirror an existing extract/adopt test harness (`memory()` + createNoydb + a collection with 3-field records `{id, name, phone}`). Extract with `fieldProjection: { clients: ['name'] }`; decrypt the bundle via `decryptExtractedPartition` (import from `@noy-db/hub/bundle`); assert each decrypted record has `id` + `name` ONLY (no `phone`); assert a NON-projected collection in the same extract keeps all fields; assert (per-record CEK path) the SAME holds when the collection was opened with `perRecordKeys:true`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.**
  1. `extractPartition` signature (`:247`): add `readonly fieldProjection?: Record<string, readonly string[]>` to the opts type; pass to `reKeyClosure(vault, closure, deks, opts.fieldProjection)` and to the `reKeySchemas` call.
  2. `reKeyClosure` (`:53`): add a `fieldProjection?` param. Inside the per-collection loop, compute `const proj = fieldProjection?.[collectionName]` (a Set for lookup). In BOTH branches, after `const plaintext = await decrypt(...)` and BEFORE `encrypt(...)`:
     ```ts
     let body = plaintext
     if (proj) {
       const rec = JSON.parse(plaintext) as Record<string, unknown>
       const kept: Record<string, unknown> = {}
       if ('id' in rec) kept['id'] = rec['id']           // id ALWAYS preserved
       for (const f of proj) if (f in rec) kept[f] = rec[f]
       body = JSON.stringify(kept)
     }
     const { iv, data } = await encrypt(body, <cek|destDek>)
     ```
     Apply identically in the CEK branch (encrypt under `cek`) and the DEK branch (encrypt under `destDek`). Keep the `_cek` re-wrap order EXACTLY as before — only the plaintext body changes.
  3. `reKeySchemas` (`:89`): skip any collection present in `fieldProjection` (don't carry a schema that contradicts the projected shape). Add a `fieldProjection?` param + `if (fieldProjection?.[name]) continue`.
- [ ] **Step 4: Run → pass.** Full `pnpm --filter @noy-db/hub test` (no regression — non-projected extracts byte-identical), typecheck, lint, `pnpm check:architecture`.
- [ ] **Step 5: Commit** (new test → `git add`): `git add packages/hub/__tests__/extract-field-projection.test.ts && git commit -am "feat(hub): fieldProjection in extract — structural field redaction (FR-7 Task 1)"`

---

## Task 2 — lobby: `SurfaceRow` + StateManagementVault persistence (TDD)

**Files:** `packages/lobby/src/federation/types.ts`, `packages/lobby/src/federation/state-vault.ts`. Test `packages/lobby/__tests__/surface-persistence.test.ts`.

- [ ] **Step 1: Failing test** — open a `StateManagementVault`, `createSurface(row)`, `getSurface(id)` round-trips, `listSurfaces()` returns it; assert the persisted shape.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.**
  - `types.ts`: 
    ```ts
    export type SurfaceDirection = 'push' | 'pull' | 'bidi'
    export type SurfaceStatus = 'proposed' | 'agreed' | 'suspended'
    export interface SurfaceConflictPolicy {
      readonly strategy: MergeStrategy | (Record<string, MergeStrategy> & { default?: MergeStrategy })
      readonly fieldAuthority?: Record<string, FieldAuthorityPolicy>
    }
    export interface SurfaceRow {
      readonly id: string
      readonly collections: readonly string[]
      readonly fields?: Record<string, readonly string[]>     // collection → kept fields
      readonly direction: SurfaceDirection
      readonly conflictPolicy: SurfaceConflictPolicy
      readonly cadenceMs?: number
      readonly status: SurfaceStatus
      readonly proposedBy: string
      readonly agreedBy?: string
      readonly createdAt: number
      readonly lastSyncAt?: number
      readonly nextSyncDueAt?: number
    }
    ```
    (Import `MergeStrategy`/`FieldAuthorityPolicy` types from the interchange modules — type-only; confirm no runtime cycle.)
  - `state-vault.ts`: add `SURFACES = 'surfaces'` const; bind `vault.collection<SurfaceRow>(SURFACES)` in `open()`; expose `readonly surfaces: Collection<SurfaceRow>`; add methods `createSurface(row)` (put), `getSurface(id)` (get), `listSurfaces()` (query/list), `updateSurface(id, patch)` (get→merge→put). Mirror the `migrationStatus` method pattern.
- [ ] **Step 4: Run → pass.** lobby test + typecheck + lint.
- [ ] **Step 5: Commit** (new test → `git add`): `git add packages/lobby/__tests__/surface-persistence.test.ts && git commit -am "feat(lobby): SurfaceRow + StateManagementVault persistence (FR-7 Task 2)"`

---

## Task 3 — lobby: propose / agree bilateral handshake (TDD)

**Files:** Create `packages/lobby/src/interchange/surface.ts`. Test `packages/lobby/__tests__/surface-handshake.test.ts`.

- [ ] **Step 1: Failing test** — TWO `Noydb` over a SHARED store (mirror federation-fleet-migration session-2 pattern). Party A `proposeSurface(smvA, def)` writes a `status:'proposed'` SurfaceRow; Party B opens the same SMV, `agreeSurface(smvB, id, 'partyB')` flips it to `status:'agreed'` (+ `agreedBy`); assert agree on a non-existent or already-agreed surface throws; assert export/apply (Task 4) refuse a non-agreed surface.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** in `surface.ts`:
  - `proposeSurface(smv, def: SurfaceDefinition, proposedBy: string, now: number): Promise<SurfaceRow>` — builds a SurfaceRow `{...def, id: def.id ?? generateULID(), status:'proposed', proposedBy, createdAt: now}`, `smv.createSurface(row)`, returns it. (`SurfaceDefinition` = the user-facing subset: collections/fields?/direction/conflictPolicy/cadenceMs?/id?.)
  - `agreeSurface(smv, surfaceId, agreedBy, now): Promise<SurfaceRow>` — `getSurface`; if null → `SurfaceNotFoundError`; if `status !== 'proposed'` → `SurfaceStateError`; `updateSurface(id, {status:'agreed', agreedBy})`; return.
  - `SurfaceNotFoundError`/`SurfaceStateError` classes.
  - Pass `now` in (no `Date.now()` inside the pure helpers — testability; the Lobby wrapper supplies `Date.now()`).
- [ ] **Step 4: Run → pass.** lobby test + typecheck + lint.
- [ ] **Step 5: Commit** (new files → `git add`): `git add packages/lobby/src/interchange/surface.ts packages/lobby/__tests__/surface-handshake.test.ts && git commit -am "feat(lobby): Surface propose/agree handshake (FR-7 Task 3)"`

---

## Task 4 — lobby: exportSurface + applySurface + Lobby wiring (TDD)

**Files:** `packages/lobby/src/interchange/surface.ts`, `packages/lobby/src/index.ts`. Test `packages/lobby/__tests__/surface-sync.test.ts`.

**Context:** Step 0 `pnpm --filter @noy-db/hub build` (Task 1's fieldProjection). The scoped slice = `extractPartition` restricted to surface.collections (seeds `() => true` per surface collection; **bound ref-following so ONLY surface.collections leave** — use `maxDepth: 0` if that means seeds-only, else filter the closure to surface.collections; the TEST must assert a non-surface collection is absent from the bundle) + `fieldProjection: surface.fields`. Apply = `mergeCompartment` with the conflict policy.

- [ ] **Step 1: Failing test** — agreed surface `{collections:['clients'], fields:{clients:['name']}, direction:'push', conflictPolicy:{strategy:'take-incoming'}}`; source vault has `clients`(id,name,phone) + a `secret` collection NOT in the surface. `exportSurface(sourceVault, surface)` → `{bundleBytes, transferKey}`; `applySurface(receiverVault, surface, bundleBytes, transferKey)` → MergeReport. Assert: receiver `clients` rows have `name` only (no `phone`); receiver has NO `secret` collection (outside surface never leaves); MergeReport counts correct. Assert `direction:'pull'` rejects `exportSurface` from this side (export is a push-side op) and vice versa; assert a non-`agreed` surface throws.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.**
  - `exportSurface(source: Vault, surface: SurfaceRow): Promise<{bundleBytes: Uint8Array; transferKey: Uint8Array}>` — guard `surface.status === 'agreed'` (else `SurfaceStateError`); guard `direction !== 'pull'` (push/bidi may export); build `seeds` = `Object.fromEntries(surface.collections.map(c => [c, () => true]))`; `const { bundleBytes, transferKey } = await extractPartition(source, { seeds, maxDepth: 0, fieldProjection: surface.fields, carrySchemas: false, carryLedger: false })`; **verify only surface.collections are present** (if extractPartition can include others, post-filter — see Step 0 note); return `{bundleBytes, transferKey}`.
  - `applySurface(receiver: Vault, surface: SurfaceRow, bundleBytes, transferKey): Promise<MergeReport>` — guard `status==='agreed'`; guard `direction !== 'push'` (pull/bidi may apply); `return mergeCompartment(receiver, bundleBytes, { transferKey, strategy: surface.conflictPolicy.strategy, ...(surface.conflictPolicy.fieldAuthority ? { fieldAuthority: surface.conflictPolicy.fieldAuthority } : {}), reason: \`sync:surface:${surface.id}\` })`.
  - `Lobby` methods (`index.ts`): `createSurface(def)`/`getSurface(id)`/`listSurfaces()`/`proposeSurface(def)`/`agreeSurface(id, agreedBy)`/`exportSurface(vaultName, surfaceId)`/`applySurface(vaultName, surfaceId, bundleBytes, transferKey)` — open the SMV via `StateManagementVault.open(this.noydb)`, resolve the surface, open the data vault via `this.noydb.openVault`, delegate to the surface.ts helpers (supplying `Date.now()` for `now`). Export `SurfaceRow`/`SurfaceDefinition`/`SurfaceDirection`/`SurfaceConflictPolicy` types + the error classes.
- [ ] **Step 4: Run → pass.** `pnpm --filter @klum-db/lobby test` + `pnpm --filter @noy-db/hub test`, typecheck, lint, `pnpm check:architecture` (klum→noy clean).
- [ ] **Step 5: Commit** (new test → `git add`): `git add packages/lobby/__tests__/surface-sync.test.ts && git commit -am "feat(lobby): exportSurface/applySurface + Lobby Surface API (FR-7 Task 4)"`

---

## Task 5 — lobby: cadence scheduler + two-party E2E (TDD)

**Files:** `packages/lobby/src/interchange/surface.ts`. Test `packages/lobby/__tests__/surface-cadence.test.ts` + `packages/lobby/__tests__/surface-e2e.test.ts`.

- [ ] **Step 1: Failing tests.**
  - cadence (pure): `isSurfaceDue(surface, now)` → true iff `surface.cadenceMs !== undefined && (surface.lastSyncAt === undefined || now >= (surface.nextSyncDueAt ?? 0))`; `listDueSurfaces(surfaces, now)` filters agreed + due. Deterministic (pass `now`).
  - scheduler driver: `SurfaceCadenceScheduler.start(surfaceId, intervalMs, fn)` / `stop(surfaceId)` fires `fn` on the interval (test with `vi.useFakeTimers()`); `markSynced(smv, id, now)` stamps `lastSyncAt`+`nextSyncDueAt = now + cadenceMs`.
  - E2E (`surface-e2e.test.ts`): two `Noydb` over a shared store; A proposes a push surface (`fields:{clients:['name']}`), B agrees; A `exportSurface` → B `applySurface`; assert projected + scoped result; then `markSynced` + assert `isSurfaceDue` flips false then true after advancing `now`; assert a `suspended` surface is not due.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the pure `isSurfaceDue`/`listDueSurfaces`, `markSynced(smv, id, now)` (updateSurface), and a thin `SurfaceCadenceScheduler` (a `Map<id, interval>`; `start` uses `setInterval`; `stop`/`stopAll` clear; accepts an injectable `nowFn` defaulting to `Date.now`). Keep the driver minimal — the pure due-check is the tested core; the host wires real timers.
- [ ] **Step 4: Run → pass.** Full lobby + hub test, typecheck, lint, architecture.
- [ ] **Step 5: Commit** (new tests → `git add`): `git add packages/lobby/__tests__/surface-cadence.test.ts packages/lobby/__tests__/surface-e2e.test.ts && git commit -am "feat(lobby): Surface cadence scheduler + two-party E2E (FR-7 Task 5)"`

---

## Task 6 — features.yaml + full verification

**Files:** `features.yaml`.
- [ ] **Step 1:** add a `scoped-sync-surface` entry mirroring sibling lobby features (`cross-vault-extraction`/`merge-compartment`): artefacts `packages/lobby/src/interchange/surface.ts` + `packages/lobby/src/federation/state-vault.ts` + the hub `extract-partition.ts` projection; spec `docs/superpowers/specs/2026-06-16-lobby-framework-design.md` (FR-7); package `@klum-db/lobby`; status `preview`; invariants: (1) syncs only named collections/fields in the named direction with its conflict policy; (2) collections/fields outside the surface never leave (structural projection at extract); (3) propose/agree bilateral handshake gates sync; (4) persisted in the StateManagementVault; (5) cadence-driven, host-scheduled. `node scripts/validate-features.mjs` passes.
- [ ] **Step 2: Full verification:**
```bash
pnpm --filter @noy-db/hub build && pnpm --filter @klum-db/lobby build
pnpm --filter @noy-db/hub test && pnpm --filter @klum-db/lobby test
pnpm lint && pnpm typecheck
node scripts/validate-features.mjs
pnpm check:architecture
```
All green.
- [ ] **Step 3: Commit** — `git commit -am "feat: register scoped-sync-surface feature + verify (FR-7)"`

---

## Self-Review

**Spec coverage (issue #447):**
- "a surface syncs only its named collections/fields, in the named direction, applying its conflict policy" → Task 4 (exportSurface restricts to surface.collections + fieldProjection; direction guards; conflictPolicy→mergeCompartment strategy).
- "collections/fields outside the surface never leave the vault" → Task 1 (structural field projection drops non-surface fields before re-encryption) + Task 4 (only surface.collections in the bundle — asserted by the `secret`-collection-absent test).
- Persisted + scheduled (the chosen scope) → Task 2 (SMV persistence) + Task 3 (handshake) + Task 5 (cadence).
- Builds on SyncEngine/SyncPolicy concept (reimagined as extract-project-merge — the only field-projecting path), broadcastJoin-style scoping, FR-2/3/4.

**Placeholder scan:** concrete line refs (extractPartition:247, reKeyClosure:53-76, reKeySchemas:89, StateManagementVault.open). The two implementer must-confirms: Task 1's per-record-CEK branch projection (apply identically, keep `_cek` re-wrap order); Task 4's "only surface.collections leave" (maxDepth:0 vs post-filter — the test is the gate).

**Risk notes:** Task 1 is riskiest — projecting in BOTH re-key branches without breaking the `_cek` re-wrap (a wrong key order → silently undecryptable at receiver; the existing comment at extract-partition.ts:62 flags this class). Field projection is STRUCTURAL (export-boundary redaction), NOT cryptographic intra-vault hiding — documented (sync only transmits the slice, so excluded fields simply aren't sent). No row-level predicate (not in #447). SyncEngine deliberately unused. transferKey is per-run, out-of-band (not persisted). Lobby files have no kernel ceilings. The `no-outbound-klum-import` guard (now scanning all noy packages, per FR-9) stays green — FR-7 is lobby-side + one hub primitive, no noy→klum import.
