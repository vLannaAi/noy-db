# manifest-engine (#941) Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development. This is the P0 core; largest milestone-46 issue.

**Goal:** The schema **manifest** (one reserved `_manifest` record per pod, an INDEX over the per-collection schemas) + a strict-CAS manifest writer + an `open(podBytesOrFile)` orchestrator that composes header→verify→unlock→manifest→fence→data. Closes #941 (milestone #46, L7 P0). Consumes #942/#943/#946.

**Architecture:** A new `with-shape/manifest/` family (parallel to `persisted-schemas/`). The `_manifest` record is a pod-wide INDEX — per-collection `{ generation, contentHash, fieldIds }` + pod-wide generation + aggregate hash — while full schema JSON stays in the per-collection `_schemas/<collection>` DEK-encrypted records (source of truth). `open()` is a free function in a new `with-pod/open.ts` composing existing pieces + the manifest read. Manifest writes are strict-CAS (REFUSE on conflict, never retry-merge) and ledger-audited.

## Locked decisions (maintainer, do not re-open)
- **Content model: INDEX, not full-inline.** The `_manifest` record aggregates per-collection metadata (name → `{ generation, contentHash, fieldIds }`) + a pod-wide `generation` + an `aggregateHash` over the per-collection content-hashes. It does NOT inline `jsonSchema`. `_schemas/<collection>` remains the DEK-encrypted source of truth. Rationale: a single-grain full-inline manifest would leak all schemas to a collection-scoped principal or break their `open()`; the index preserves per-collection DEK isolation. Round-trip identity (dump→restore→re-derived manifest matches) is AC #2.
- **One record per pod** (grain), reserved collection `_manifest`, record id `schema`.
- **strict-CAS = REFUSE, not retry.** Unlike every existing reserved-collection writer (which retries on `ConflictError`), the manifest writer surfaces a `ManifestConflictError` — AC #1 ("two concurrent edits → one refused, surfaced, never merged").
- **Scope:** only the SCHEMA manifest is implemented. The reserved-collection LAYOUT anticipates the other four kinds (behavior/storage/access/app, P1–P3) but they are NOT built. **Manifest signing is a companion issue — OUT of #941.**

## Global Constraints
- Branch `feat/941-manifest-engine` (off main; has #942/#943/#946/#944/#949). Commit per task. **NEVER add Claude/AI attribution.**
- `vault.ts` 3728/3735 (7 lines) — the reserved-collection refusal edit (`vault.ts:694` region) must stay tiny; if it exceeds headroom, shrink-first (extract a cohesive private helper, per the file's ratchet history). `collection.ts` 4329/4329 — DO NOT touch. Don't touch `noydb.ts` beyond the minimum if open() needs it (prefer free functions).
- `open()` is a FREE function (not a Vault method) → kernel-api golden untouched.
- Reserved-collection predicate lives in a new dependency-free module (mirror `with-party/team/reserved-secret-collections.ts`) so kernel + shape layers both import it.
- CAS: `store.put(vault, coll, id, env, expectedVersion)` throws `ConflictError` (kernel/errors.ts:945; detect with `isConflictError`, :970 — name-based, cross-copy safe). `_v` is the token.
- Ledger audit: `LedgerStore.append({ op: 'migration', ... })` (with-commit/history/ledger/store.ts:248; op union entry.ts:105).
- MigrationRequiredError reuse: `errors.ts:1205`; the posture is `fence-controller.ts:73-91` `assertWritable` (`if fence.currentSchemaVersion > snapshot throw MigrationRequiredError`).
- Manifest travels in pods: add `_manifest` to the backup dump reserved set (`with-pod/backup.ts:110-129`).
- Gates after changes: build → check:types (after build) → test → check:architecture → lint → typecheck.

---

### Task 1: reserved `_manifest` collection + gating

**Files:** new `packages/hub/src/with-shape/manifest/reserved-collections.ts` (dependency-free: `MANIFEST_COLLECTION = '_manifest'`, `MANIFEST_RESERVED_COLLECTIONS: ReadonlySet<string>` incl. the 5 anticipated names OR just `_manifest` for now + a comment reserving `_manifest_*`, `isManifestReservedCollection(name): boolean`), `kernel/vault.ts` (add the predicate to the `vault.collection()` refusal at ~:694 — mirror the `isSecretBearingReservedCollection` check; measure line count, shrink-first if over 3735), `with-pod/backup.ts` (add `_manifest` to the dump reserved set ~:110-129 so manifests travel). Test: `packages/hub/__tests__/manifest/reserved-collections.test.ts`.

**Decision to make + document:** reserve exactly `_manifest` now (single record id `schema` inside it), OR the 5-name set `_manifest` + reserved prefix for future kinds. Recommend: ONE `_manifest` collection, records keyed by kind (id `schema` now; `behavior`/`storage`/`access`/`app` reserved as future record ids) — simplest, one collection to gate. Document.

- [ ] **Step 1: failing tests** — `isManifestReservedCollection('_manifest')` true, `('invoices')` false; `vault.collection('_manifest')` throws `ReservedCollectionNameError`; a bundle dump includes the `_manifest` collection in its reserved set (grep/verify backup includes it). Copy the reserved-secret-collections.test.ts pattern.
- [ ] **Step 2: red.**
- [ ] **Step 3: implement.** Keep the vault.ts edit minimal; measure before/after; shrink-first if needed (report what moved).
- [ ] **Step 4: green** + `pnpm vitest run packages/hub/__tests__/bundle.test.ts` + `pnpm check:architecture` (ceiling!) + typecheck.
- [ ] **Step 5: commit** — `feat(hub): reserved _manifest collection + gating (#941)`

---

### Task 2: SchemaManifest record type + storage + strict-CAS writer + ledger audit

**Files:** new `packages/hub/src/with-shape/manifest/{types.ts, storage.ts, writer.ts}`, `kernel/errors.ts` (`ManifestConflictError` code `MANIFEST_CONFLICT`, per the NoydbError subclass shape). Test: `packages/hub/__tests__/manifest/writer.test.ts`.

**Record shape (types.ts):**
```ts
export interface SchemaManifestEntry { readonly generation: number; readonly contentHash: string; readonly fieldIds?: Record<string,string> }
export interface SchemaManifest {
  readonly v: 1
  readonly kind: 'schema'
  readonly generation: number                                   // pod-wide (FenceDoc.currentSchemaVersion)
  readonly collections: Record<string, SchemaManifestEntry>     // per-collection index (name → entry)
  readonly aggregateHash: string                                // sha256 over canonicalJson(collections) — the pod-wide content binding
}
```
Storage (storage.ts): record at `_manifest/schema`, DEK-encrypted under the `_manifest` collection DEK (a manifest INDEX discloses collection names + hashes + generations + field-ids — metadata, not schema bodies; acceptable under the same grain as `_schemas`' own encryption). `loadManifest`/`saveManifest` with `_v` CAS (mirror persisted-schemas/storage.ts loadPersistedSchemaEntry/savePersistedSchema).
Writer (writer.ts): `writeSchemaManifest(store, vault, manifest, expectedVersion)` — `store.put(..., expectedVersion)`; on `ConflictError` → throw `ManifestConflictError` (do NOT retry). Ledger-audit the write via `LedgerStore.append({ op:'migration', ... })` (find the ledger store handle available in this context; if the writer doesn't have a ledger handle, thread it or note the audit happens at the caller — check how persisted-schemas does/doesn't audit and match; if _schemas writes aren't ledger-audited today, the manifest write is the first — wire it per AC #5, or document if the ledger handle isn't reachable at this seam and defer the audit hook to Task 4's open/write integration).

- [ ] **Step 1: failing tests** — build a SchemaManifest, saveManifest → loadManifest round-trips byte-identical; aggregateHash is deterministic over the same collections map (order-independent via canonicalJson); a second `writeSchemaManifest` with a STALE expectedVersion → `ManifestConflictError` (NOT a silent overwrite, NOT a retry) — this is the strict-CAS refuse test (AC #1). Use the inlineMemory() store (throws ConflictError on _v mismatch).
- [ ] **Step 2: red.**
- [ ] **Step 3: implement.**
- [ ] **Step 4: green** + typecheck + check:architecture.
- [ ] **Step 5: commit** — `feat(hub): schema-manifest record + strict-CAS writer (refuse-not-retry) + ledger audit (#941)`

---

### Task 3: derive the manifest from per-collection schemas + keep it in sync

**Files:** `with-shape/manifest/derive.ts` (`deriveSchemaManifest(store, vault, getDEK): Promise<SchemaManifest>` — read the fence generation + each `_schemas/<collection>` envelope, project to entries, compute aggregateHash), wire an update into the schema-write path (`persisted-schemas/register.ts` — after a `_schemas/<collection>` + fence update, re-derive + write the `_manifest` via Task 2's writer, strict-CAS). Test: `packages/hub/__tests__/manifest/derive.test.ts` + a round-trip test.

- [ ] **Step 1: failing tests** — declare 2 collections with schemas (persistJsonSchema:true, drain) → `deriveSchemaManifest` returns entries for both with correct generation/contentHash/fieldIds matching the `_schemas/<collection>` envelopes; the persisted `_manifest/schema` record matches the derived one (sync); **round-trip identity (AC #2):** dump the vault → restore into a fresh store → re-derive the manifest → equals the original (the manifest survives a pod round-trip and re-derivation is stable). Rename a field (via #946's cutover) → the manifest's fieldIds carry (identity survives). Use the bundle-roundtrip.test.ts + schema-field-ids.test.ts patterns.
- [ ] **Step 2: red.**
- [ ] **Step 3: implement.** The sync hook must use strict-CAS (refuse) — but a re-derive-and-write races with concurrent schema writes; handle by: re-derive under the fresh fence, write with the manifest's current `_v` as expectedVersion, and on `ManifestConflictError` from a concurrent writer, the SCHEMA write already succeeded (the manifest is derived/eventual) — decide + document: either (a) the manifest write failure surfaces (strict), or (b) the manifest is best-effort-eventual and re-derived at open() anyway (since it's derived from the source-of-truth _schemas). Given round-trip identity is satisfied by re-derivation at open(), lean (b): the persisted manifest is a cache; open() can re-derive if absent/stale. Document this clearly (it reconciles strict-CAS-refuse with the derived nature: the WRITER refuses a conflicting DIRECT manifest edit, but the sync-from-schema path treats the manifest as a derivable cache).
- [ ] **Step 4: LEDGER AUDIT (AC #5).** Manifest mutations must be ledger-audited (`op:'migration'`). FIRST determine whether a schema-set change / generation bump already writes a ledger entry today (grep the cutover/fence path for `LedgerStore.append` / `op:'migration'`). If schema cutovers ARE already audited, the manifest mutation is transitively covered by that entry — document that and add a test asserting a manifest-changing schema mutation produces a ledger entry. If they are NOT audited and a ledger handle is reachable at the sync-write seam (register.ts / the fence-controller cutover), wire `LedgerStore.append({op:'migration', ...})` there. If no ledger handle is reachable at this seam, STOP and report it as a finding for the controller to decide where the audit lands (do not silently skip AC #5).
- [ ] **Step 5: green** + regression (`persisted-schemas/*`, `schema-field-ids.test.ts`, `bundle-roundtrip.test.ts`) + typecheck + check:architecture.
- [ ] **Step 6: commit** — `feat(hub): derive schema manifest from per-collection schemas + round-trip-stable sync + ledger audit (#941)`

---

### Task 4: open() orchestrator

**Files:** new `packages/hub/src/with-pod/open.ts`, uses readPod/verifyPodHeader (with-pod), createNoydb/openVault/vault.load (kernel), the manifest read + fence. Test: `packages/hub/__tests__/manifest/open.test.ts`.

**Interface:**
```ts
export interface OpenPodOptions {
  readonly store: NoydbStore
  readonly user: string
  readonly secret: string /* | EchoSecretParts — reuse the createNoydb secret union */
  readonly trustedKeys?: Readonly<Record<string,string>>   // if provided, verify header sig; report status
  readonly noydbOptions?: /* createNoydb passthrough */
  readonly allowGenerationAhead?: boolean                   // dev override for the MigrationRequired fence
}
export interface OpenPodResult {
  readonly db: Noydb
  readonly vault: Vault
  readonly header: NoydbPodHeader
  readonly verification?: PodVerifyResult                   // present iff trustedKeys given
  readonly manifest?: SchemaManifest                        // the pod's schema manifest (re-derived/loaded)
}
export async function open(podFileOrBytes: Uint8Array, opts: OpenPodOptions): Promise<OpenPodResult>
```
Flow (spec §4 order): `readPod(bytes)` (integrity) → if `trustedKeys` `verifyPodHeader` (record status; do NOT hard-fail on 'unsigned' — that's a legacy/unsigned pod; but surface it) → `createNoydb(...)` + `openVault(header vault)` + `vault.load(dumpJson, secret)` (unlock+restore) → load/derive the `SchemaManifest` → compare the manifest's pod-wide `generation` to the reader engine's snapshot; if the pod's generation is AHEAD of what the reader can handle and `!allowGenerationAhead` → `MigrationRequiredError` (reuse the class); dev-mode divergence warns (AC #4) → return `OpenPodResult`.

- [ ] **Step 1: failing tests** — write a pod (with schemas) → `open(bytes, {store: freshStore, user, secret})` returns `{db, vault, header, manifest}` with the vault open and a collection readable; manifest present + matches; `trustedKeys` given + signed pod → `verification.status==='verified'`; unsigned pod + trustedKeys → status 'unsigned', open still succeeds (surfaced not fatal); a pod whose manifest generation is ahead of the reader → `MigrationRequiredError` (simulate by stamping a higher generation), and `allowGenerationAhead:true` opens anyway with a warning. Use bundle-roundtrip fixture.
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** open() as glue in with-pod/open.ts. Reuse existing pieces; do not reimplement unlock/restore.
- [ ] **Step 4: green** + typecheck + check:architecture.
- [ ] **Step 5: commit** — `feat(hub): open() orchestrator — header→verify→unlock→manifest→fence→data (#941)`

---

### Task 5: exports, goldens, docs, changeset, gates

**Files:** `with-pod/index.ts` + root `src/index.ts` (export `open`, `OpenPodOptions`, `OpenPodResult`, `SchemaManifest`, `SchemaManifestEntry`, `ManifestConflictError`, `MANIFEST_COLLECTION`, `isManifestReservedCollection`, the manifest storage/derive helpers as needed), a new `./manifest` subpath in package.json if the manifest family should be independently importable (or fold into /pod — decide, simplest is /pod for open() + root for types), goldens (pod-surface + root-barrel + `_FrozenTypes`; kernel-api ONLY if a Vault method was added — it shouldn't be; cargo untouched), doc `docs/subsystems/manifest-engine.md`, `.changeset/manifest-engine.md`.

- [ ] **Step 1: exports** (values/types separate, topic comment). Build, run pod-surface + root-barrel + kernel-api + cargo golden tests; update EXACTLY the new names (sorted) + `_FrozenTypes`/import-type; cargo + kernel-api must NOT move.
- [ ] **Step 2: check:types** after build — export every type named by an exported signature from the same entry; ratchet baseline only if it reports FIXED gaps.
- [ ] **Step 3: doc** `docs/subsystems/manifest-engine.md` — the schema manifest (INDEX model + why per-collection DEK isolation is preserved; the derived-cache vs strict-CAS-direct-edit distinction), the reserved `_manifest` collection + the anticipated (unbuilt) other kinds, `open()` pipeline + order, the strict-CAS refuse semantics, MigrationRequiredError + coexistence, ledger audit, and that manifest SIGNING is a companion issue. Reference #946 (field-ids/generation) + #942/#943 (header/signature) as the layers it sits on.
- [ ] **Step 4: changeset** `.changeset/manifest-engine.md` (`'@noy-db/hub': minor`): the schema manifest (one-per-pod index over per-collection schemas, generation↔content-hash bound), reserved `_manifest` collection, strict-CAS refuse-not-retry writer, and the `open(podBytesOrFile)` orchestrator (header→verify→unlock→manifest→fence→data). Back-compatible (a pre-manifest pod opens; manifest re-derived from _schemas).
- [ ] **Step 5: full gates** — build, check:types, test (full), check:architecture, lint, typecheck. All green.
- [ ] **Step 6: commit** — `feat(hub): export manifest engine + open() + doc + changeset (#941)`

## Out of scope (note in PR)
- The other four manifest kinds (behavior/storage/access/app) — layout reserved, not built (P1–P3).
- Manifest signing / chain-verified re-points — companion issue (uses #943's signRecord).
- The write half of open() (open-for-write / migration execution beyond the fence check) — this issue is the Tier-1 READ path per the spec.
- Per-collection generation (rejected in #946).
