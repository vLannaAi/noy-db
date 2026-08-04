# #948 introspection seams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fill the remaining read-only introspection seams on the vault schema snapshot (`dumpSchema`) and the kernel API — declared indexes, snapshot-level `ref.isArray`, the subsystem matrix, a public store accessor, and sync-target listing — plus resolve the dead `aclRoles` field. Closes #948 (milestone 46). Seam 4 (auth-method registration) stays deferred.

**Architecture:** These are additive, read-only surfaces. Most land in `with-shape/introspection/walk.ts` + `types.ts` (the snapshot assembler) and on `Noydb`/`Collection` accessors; `vault.ts` is at its ceiling, so we shrink it first (extract `getBundleHandle`) and implement the one vault-touching seam (subsystem matrix) net-neutral. The kernel-API golden is hand-edited to admit the new public accessors.

**Tech Stack:** TS ESM, `crypto.subtle` only, vitest, pnpm. Package: `@noy-db/hub`.

## Global Constraints
- Branch `fix/948-introspection-seams` (off main, AFTER #971 merges). Commit per task. **NEVER add Claude/AI attribution.** Grep the diff for any private-client name before each commit.
- Kernel-surface ceilings (`scripts/check-architecture.mjs`): `vault.ts` 3735 (1 slack — Task 1 lowers it), `noydb.ts` 2161 (56 slack), `collection.ts` 4311 (0 slack — Task 2 adds a small accessor; if it would exceed 4311, extract or tell me, do NOT bump). Never raise a ceiling.
- Hub portability: no Node built-ins, crypto.subtle only.
- The kernel-API golden (`packages/hub/__tests__/kernel-api.golden.json`) is HAND-EDITED (no regen script) — every task that adds a public (non-`_`) Noydb/Vault/Collection method/getter MUST add the sorted name to the golden in the same task, or `kernel-api-surface-golden.test.ts` fails.
- Gates: `pnpm --filter @noy-db/hub build && test` + `pnpm --filter @noy-db/hub typecheck` + `pnpm check:architecture` + `pnpm lint`. All green.

## Locked decisions (maintainer)
- **Seam 2 (listSyncTargets):** surface `{ label, role, policy: { push: { mode }, pull: { mode } } }`. The preset NAME does not exist in the data model (a `SyncTarget` carries an anonymous `SyncPolicy`) → DEFER preset-name (a follow-up, like seam 4). Recover the policy by adding a `readonly policy?: SyncPolicy` field to `SyncEngine`.
- **Seam 6b (aclRoles):** the `VaultSchemaSnapshot.aclRoles` field is declared but NEVER populated (dead), and the only cheaply-reachable datum is the caller's own single role — a true grant-role set needs an O(users) keyring-decrypt walk (out of scope). DECISION: **delete the dead `aclRoles` field**; proper multi-user role introspection is a deferred follow-up. (Do NOT ship a mislabeled caller-role.)

## Verified source facts (from recon — .superpowers/sdd/scratch-948-recon.md)
- Snapshot: `Vault.dumpSchema` (vault.ts:3190) → `with-shape/introspection/walk.ts` `dumpVaultSchema` (72-123), object literal walk.ts:110-121; types `with-shape/introspection/types.ts` (`VaultSchemaSnapshot` 123-136, `CollectionDescriptor` 87-98); `Vault._introspectState` (vault.ts:3246-3274) feeds the walker.
- Seam 1: `Collection` keeps declared `IndexDef[]` at collection.ts:825 (`IndexDef = string | {fields:string[];unique?:boolean} | string[]`, eager-indexes.ts:34-37); `getConfig()` omits them; the private `get indexes()` returns the BUILT index (null under NO_INDEXING), NOT the declared defs. `CollectionDescriptor.indexes` type exists; walk.ts:208 currently hardcodes `indexes: []`.
- Seam 6a: `RefDescriptor.isArray?:true` (refs.ts:70); walk.ts:143-147 projects only `{target,mode}`; `CollectionDescriptor.refs` value type at types.ts:90. Already surfaced+tested on `collection.describe()` (describe.ts:487, describe.test.ts:177-188).
- Seam 5: `StrategyBag` 27 keys (strategies.ts:92-120), `STRATEGY_DEFAULTS` (130-158), `STRATEGY_KEYS` (161); reachable from Vault via `this.noydb.strategies`. Current `subsystems` = a 4-key inline literal at vault.ts:3255-3260 (guards/derivations/materializedViews/overlayViews — registry-presence booleans). `dump-schema.test.ts:115-125` asserts those 4 keys (keep them).
- Seam 3: `noydb.ts:1364` already has `get _store(): NoydbStore`; add a PUBLIC accessor.
- Seam 2: engines in `Noydb.syncEngines: Map<string,SyncEngine>` (noydb.ts:146), key `name` or `${name}::${label??role}` (noydb.ts:573,593); `SyncEngine` retains `role`+`label` (engine.ts:46-47) but consumes `opts.syncPolicy` into the scheduler (engine.ts:153-177) without keeping it; `SyncTarget`/`SyncPolicy` types at kernel/types.ts:1450.
- Golden: `kernel-api.golden.json` + `kernel-api-surface-golden.test.ts` (freezes public prototype names; hand-edited). Snapshot tests in `__tests__/introspection/`. Consumer `in-devtools/src/snapshot.ts` reads `desc.indexes` (currently always `[]`) — flows through untouched.

---

### Task 1: shrink-first — extract `getBundleHandle` from vault.ts (pure refactor)

**Files:** Create `packages/hub/src/with-pod/bundle-handle.ts`; modify `packages/hub/src/kernel/vault.ts` (:3311-3345 → delegator); modify `scripts/check-architecture.mjs` (:1254 vault.ts ceiling).

**Behavior: NONE changes.** Extract the body of `getBundleHandle` (vault.ts:3311-3345, ~35 lines; it references only `this.adapter`, `this.name`, `EncryptedEnvelope`, `NOYDB_FORMAT_VERSION`, and dynamic-imports `../with-pod/ulid.js`) into `export async function buildBundleHandle(adapter, name, ...)` in bundle-handle.ts. `Vault.getBundleHandle` becomes a ~2-line delegator with the SAME name (so the kernel-api golden — which lists `getBundleHandle` on Vault — is UNCHANGED). Read the method first to get its exact params/return.

- [ ] **Step 1: extract** — new module + delegator; convert `this.X`→params. No logic change.
- [ ] **Step 2: green (no test edits)** — `pnpm --filter @noy-db/hub test` (all green, unchanged) + typecheck.
- [ ] **Step 3: ratchet ceiling** — `wc -l vault.ts`; set check-architecture.mjs:1254 to that new (lower) actual+1 (match the existing convention: ceiling = `split('\n').length`). `pnpm check:architecture` green.
- [ ] **Step 4: commit** — `refactor(hub): extract buildBundleHandle out of vault.ts (shrink-first for #948)`

---

### Task 2: seam 1 (declared indexes) + seam 6a (ref.isArray in snapshot)

**Files:** `packages/hub/src/kernel/collection.ts` (new `getDeclaredIndexes()` accessor); `packages/hub/src/with-shape/introspection/walk.ts` (:208 indexes, :146 refs); `packages/hub/src/with-shape/introspection/types.ts` (:90 refs value type — add `isArray?: true`; `indexes` type already present); `packages/hub/__tests__/kernel-api.golden.json` (add `Collection.getDeclaredIndexes`); tests in `packages/hub/__tests__/introspection/`.

**Behavior:**
- `Collection.getDeclaredIndexes(): ReadonlyArray<{ fields: string[]; unique?: boolean }>` — normalizes the raw declared `IndexDef[]` (string → `{fields:[s]}`, string[] → `{fields}`, object passthrough). Read collection.ts:825 for the storage shape. This is a PUBLIC accessor → add to the golden.
- walk.ts:208 — `indexes: liveColl?.getDeclaredIndexes() ?? []` (confirm how the walker reaches the live `Collection` — the `VaultIntrospectState`/liveColl handle; mirror how fields/refs are pulled).
- walk.ts:146 — include `isArray` when set: `refs[name] = { target: desc.target, mode: desc.mode, ...(desc.isArray ? { isArray: true } : {}) }`; add `isArray?: true` to the refs value type at types.ts:90.

- [ ] **Step 1: failing tests** — in `__tests__/introspection/` (extend dump-schema.test.ts or a new file): declare a collection with indexes + an array ref; assert the snapshot's `indexes` reflects the declared defs (normalized) and a ref's `isArray:true` appears. Both fail today (`indexes:[]`, no isArray). Add a golden-surface expectation is NOT needed here (the golden test will fail until you edit the JSON — do that in step 3).
- [ ] **Step 2: run red.**
- [ ] **Step 3: implement** the accessor + walk.ts projections + types; add `Collection.getDeclaredIndexes` to kernel-api.golden.json (sorted). Confirm collection.ts stays ≤ 4311 (the accessor is small; if it would exceed, tell me — do NOT bump the ceiling).
- [ ] **Step 4: green** + typecheck + `check:architecture` (golden + ceilings).
- [ ] **Step 5: commit** — `feat(hub): surface declared indexes + ref.isArray in the schema snapshot (#948)`

---

### Task 3: seam 5 (subsystem matrix) + seam 6b (delete dead aclRoles)

**Files:** `packages/hub/src/with-shape/introspection/` (new helper e.g. `subsystem-matrix.ts`); `packages/hub/src/kernel/vault.ts` (:3255-3260 subsystems block — NET-NEUTRAL rewrite); `types.ts` (delete `aclRoles` from `VaultSchemaSnapshot` :128; `subsystems` type already `Record<string,boolean>`); tests.

**Behavior:**
- **Seam 5:** build a subsystem matrix = the 4 existing registry-presence keys (guards/derivations/materializedViews/overlayViews) UNION the 27 strategy-derived booleans computed by reference-compare `strategies[k] !== STRATEGY_DEFAULTS[k]` over `STRATEGY_KEYS` (import from `port/with/strategies.ts`). Put the computation in a new helper `buildSubsystemMatrix(strategies, registries): Record<string,boolean>`. In vault.ts:3255-3260, REPLACE the 6-line inline block with a single `subsystems: buildSubsystemMatrix(this.noydb.strategies, { guards: …, derivations: …, materializedViews: …, overlayViews: … })` call — this must be NET-NEUTRAL or NET-NEGATIVE on vault.ts line count (do not exceed the Task-1-lowered ceiling). Keep the 4 original keys present (dump-schema.test.ts:115-125 asserts them).
- **Seam 6b:** delete the `aclRoles?` field from `VaultSchemaSnapshot` (types.ts:128). It is never populated, so nothing regresses. If any test references `aclRoles`, remove that assertion.

- [ ] **Step 1: failing test** — assert `subsystems` now contains representative strategy keys (e.g. a `with*()`-enabled subsystem shows `true`, a disabled one `false`) AND still contains the original 4 registry keys. Fails today (only 4 keys).
- [ ] **Step 2: run red.**
- [ ] **Step 3: implement** the helper + net-neutral vault.ts rewrite; delete `aclRoles`. Verify `wc -l vault.ts` ≤ the Task-1 ceiling.
- [ ] **Step 4: green** (incl. dump-schema.test.ts:115-125 still passing) + typecheck + `check:architecture`.
- [ ] **Step 5: commit** — `feat(hub): full subsystem matrix in the schema snapshot; drop dead aclRoles (#948)`

---

### Task 4: seam 3 (public store accessor) + seam 2 (listSyncTargets)

**Files:** `packages/hub/src/kernel/noydb.ts` (public `store` getter; `listSyncTargets` method); `packages/hub/src/with-commit/sync/engine.ts` (add `readonly policy?` field); `packages/hub/src/kernel/types.ts` (new `SyncTargetInfo` type); `packages/hub/__tests__/kernel-api.golden.json` (add `Noydb.store`, `Noydb.listSyncTargets`); tests.

**Behavior:**
- **Seam 3:** add a PUBLIC `get store(): NoydbStore` on Noydb returning the default store (there is already a private `get _store()` at noydb.ts:1364 — expose publicly, or return `this.options.store`). Add `store` to the golden.
- **Seam 2:** add `readonly policy?: SyncPolicy` to `SyncEngine`, assigned in its constructor from `opts.syncPolicy` (engine.ts ~:153, BEFORE it's consumed into the scheduler). Add `Noydb.listSyncTargets(vault: string): SyncTargetInfo[]` iterating `this.syncEngines` where `key === vault || key.startsWith(vault + '::')`, emitting `{ label: engine.label, role: engine.role, policy: engine.policy ? { push: { mode: engine.policy.push?.mode }, pull: { mode: engine.policy.pull?.mode } } : undefined }`. `SyncTargetInfo` type in kernel/types.ts. Add `listSyncTargets` to the golden. (Confirm noydb.ts stays ≤ 2161 — 56 slack, ample.)

- [ ] **Step 1: failing tests** — (a) `db.store` returns the store instance; (b) after wiring a sync target with a manual policy, `db.listSyncTargets(vault)` returns one entry with the right label/role and the policy push/pull modes. Both fail today.
- [ ] **Step 2: run red.**
- [ ] **Step 3: implement** the accessor + the SyncEngine field + listSyncTargets + type; add both names to kernel-api.golden.json (sorted).
- [ ] **Step 4: green** + typecheck + `check:architecture`.
- [ ] **Step 5: commit** — `feat(hub): public store accessor + listSyncTargets on Noydb (#948)`

---

### Task 5: docs + changeset + full gates + golden/consumer verify

**Files:** `docs/subsystems/` (introspection doc if one exists — else extend the describe/snapshot doc); `.changeset/introspection-seams.md`; verify `packages/in-devtools/src/snapshot.ts` still typechecks against the enriched surface.

- [ ] **Step 1: doc** — document the new snapshot fields (`indexes`, `refs[].isArray`, the full `subsystems` matrix), `Noydb.store`, `Noydb.listSyncTargets` (noting preset-name is not surfaced), and that `aclRoles` was removed pending proper multi-user role introspection.
- [ ] **Step 2: changeset** `.changeset/introspection-seams.md` (`'@noy-db/hub': minor` — additive surface; note `aclRoles` removal as a snapshot-type change): the vault schema snapshot now carries declared indexes, `ref.isArray`, and the full subsystem matrix; `Noydb` gains `store` and `listSyncTargets`; the never-populated `aclRoles` field was removed (proper multi-user role introspection deferred).
- [ ] **Step 3: full gates** — `pnpm --filter @noy-db/hub build && test`, typecheck, `pnpm check:architecture`, `pnpm --filter @noy-db/in-devtools typecheck` (consumer), `pnpm lint`. All green. Confirm `kernel-api-surface-golden.test.ts` passes with the three added names.
- [ ] **Step 4: commit** — `docs: introspection seams doc + changeset (#948)`

## Out of scope
- Seam 4 (auth-method registration) — deferred follow-up.
- Seam 2 preset-NAME — deferred (no data model).
- Seam 6b multi-user grant-role set — deferred (needs an O(users) keyring walk).
- #947 (behavior-naming — rebases on this) and #945 (store-locator) — separate branches.
