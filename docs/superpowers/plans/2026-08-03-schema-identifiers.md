# schema-identifiers (#946) Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development.

**Goal:** Stable per-field IDs (immutable across rename) + a generation↔content-hash binding on the persisted schema, so a reader can answer "generation N = schema content-hash H" and track a field across renames by identity. Closes #946 (milestone #46, L6). Companion to #941 (manifest engine consumes these).

**Architecture:** All data-model additions land in the un-ceilinged `with-shape/*` files (`persisted-schemas/types.ts`, `schema-update/fence.ts`, `schema-update/delta.ts`, `introspection/describe.ts`). Field IDs are opaque, minted once, persisted as a `name→id` map on `PersistedSchemaEnvelope`, preserved by name on re-derive, and carried across a rename by delta detection. Generation binds to content-hash via new optional fields on `FenceDoc` + `PersistedSchemaEnvelope`. `collection.ts`'s two `describe()` bodies must stay byte-neutral (2-line ceiling) — thread the id map inside `buildDescription`/helpers.

**Tech Stack:** TS ESM, `crypto.subtle`/`crypto.getRandomValues` (no npm crypto), vitest, pnpm.

## Global Constraints
- Branch `feat/946-schema-identifiers` (off main; has #942/#943). Commit per task. **NEVER add Claude/AI attribution.**
- All new fields OPTIONAL/append-only: a pre-#946 persisted schema + fence load unchanged (`isFenceDoc` stays back-compat tolerant; envelope reads tolerate missing `fieldIds`/`generation`).
- `collection.ts` ceiling 4329, actual 4327 (**2 lines**) — do NOT net-grow it; source the id map inside `buildDescription`/`describeAsync`. `vault.ts` 3728/3735. Don't touch `noydb.ts`.
- Envelope-access ratchets (`check-architecture.mjs` ~:2094-2107): `persisted-schemas/storage.ts`=2, `schema-update/fence.ts`=3 — if a new envelope write path is added, re-ratchet to the new actual (with a #946 comment), never above necessity.
- Goldens: adding a MEMBER to an already-exported interface (`PersistedSchemaEnvelope`, `FenceDoc`, `DescribedField`, `SchemaDelta`/`FieldChange`) does NOT move the root-barrel golden (it tracks names). Only a NEW exported name moves a golden. `cargo-surface` must not move.
- Gates after changes: `pnpm --filter @noy-db/hub build` → `check:types` (after build) → `test` → `pnpm check:architecture` → `lint` → `typecheck`.
- **#941 seam:** design the additions as record-shape fields on `persisted-schemas/types.ts` so #941 can lift them into its schema-manifest unchanged. #946 keeps using `_schemas/<collection>` via existing `storage.ts` — do NOT introduce a new reserved-collection scheme (that's #941).

## Locked maintainer decision (per AC bullet 5)
**Per-collection generation is REJECTED for #946; generation stays vault-wide** (the existing `_meta/schema-fence` single counter). Rationale: the content-hash binding — the actual requirement — works at vault granularity (generation N pins the vault's schema-set hash); per-collection generation is a larger migration of the fence model best folded into #941's engine consolidation. Document this in the design-note step + the fence doc comment.

## Field-ID model (decide once, here)
- `id` = opaque short random token: `crypto.getRandomValues(12 bytes)` → base32url (no timestamp, no name-derivation — a name-derived id would change on rename). Minted lazily at first persist.
- Persisted as `PersistedSchemaEnvelope.fieldIds?: Record<string,string>` (fieldName→id).
- **Preserved on re-derive**: when re-persisting, carry forward any existing `fieldIds[name]` for names still present (mirror the classified/satellite marker-preservation at `register.ts:96-98`); mint only for genuinely-new names.
- **Carried across rename**: `SchemaDelta`/`FieldChange` gains rename-awareness so a `{from,to}` rename copies the id from the old name to the new (identity survives rename — the L6 point).

---

### Task 1: Data model — fieldIds + generation↔hash binding + lazy minting

**Files:** `with-shape/persisted-schemas/types.ts` (envelope + `fieldIds?`, `generation?`), `with-shape/schema-update/fence.ts` (`FenceDoc.schemaHash?`, `isFenceDoc` tolerant), `with-shape/persisted-schemas/derive.ts` + `register.ts` (mint/preserve ids; stamp generation+hash). Test: `packages/hub/__tests__/schema-field-ids.test.ts` + extend `persisted-schemas/bundle-roundtrip.test.ts`.

**Produces:** `PersistedSchemaEnvelope.fieldIds?: Record<string,string>`, `PersistedSchemaEnvelope.generation?: number`; `FenceDoc.schemaHash?: string`; a `mintFieldId()` helper + an id-preservation path in the derive/register cycle; a helper binding generation↔hash readable from `schemaFenceState()` + `loadPersistedSchema`.

- [ ] **Step 1: failing tests** — (a) persist a collection schema → envelope carries `fieldIds` for every property, each a distinct base32url token; (b) re-derive the SAME schema → `fieldIds` unchanged (id stability, no re-mint); (c) add a new field → new id minted, existing ids untouched; (d) fence↔envelope: after a cutover, `schemaFenceState().currentSchemaVersion` and the persisted envelope's `generation` agree, and `FenceDoc.schemaHash` equals the envelope `hash` for that generation; (e) a legacy envelope/fence (no `fieldIds`/`generation`/`schemaHash`) loads without error. Use the `fence-state-accessor.test.ts` fixture pattern (`createNoydb` + `to-memory`, `persistJsonSchema:true`, `_drainPendingSchemaWrites`, `coordinatedCutover`).
- [ ] **Step 2: run red.**
- [ ] **Step 3: implement.** Keep envelope-access ratchets minimal; if `fence.ts` gains a write it re-ratchets with a `#946` comment. `mintFieldId` uses `crypto.getRandomValues`.
- [ ] **Step 4: run green** + regression (`persisted-schemas/*.test.ts`, `schema-update/fence*.test.ts`, `persistence.test.ts`, `carry-schemas.test.ts`) + typecheck + check:architecture.
- [ ] **Step 5: commit** — `feat(hub): stable field IDs + generation<->content-hash binding on persisted schema (#946)`

---

### Task 2: describe() surfaces the id + rename carries identity

**Files:** `with-shape/introspection/describe.ts` (`DescribedField.id`, `BuildDescriptionInput` gains the id map, `buildDescription` injects it), thread the id source from `collection.ts:928-999` **without net line growth** (source it inside the describe helpers / a resolver the helper calls, not new lines in the two `describe()` bodies — verify collection.ts line count unchanged), satellite `describe()` (`satellites/joined.ts`, `satellites/types.ts`) carries id through. `with-shape/schema-update/delta.ts` + `types.ts` — id-aware rename detection. Tests: `introspection/describe.test.ts` (id present + stable), `schema-update/delta.test.ts` (rename carries id).

**Produces:** `DescribedField.id?: string` (optional — absent for a schema with no persisted ids yet, e.g. sync `describe()` with no persisted schema); rename-aware `SchemaDelta` carrying the id from old→new name.

- [ ] **Step 1: failing tests** — `describe()` on a collection with a persisted schema exposes `id` per field, stable across two calls; a rename (schema change old-name→new-name) produces a delta that carries the SAME id to the new name; the sync `describe()` with no persisted schema returns fields with `id` undefined (no crash).
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** — MEASURE collection.ts before/after (`node -e "...split('\n').length"`) — must be unchanged (≤4329). If threading forces a line, offset it inside the same edit or move the resolver into describe.ts.
- [ ] **Step 4: green** + `introspection/*.test.ts` + `describe-contract.test.ts` regression + check:architecture (ceiling!).
- [ ] **Step 5: commit** — `feat(hub): describe() exposes stable field id; rename carries field identity (#946)`

---

### Task 3: design note, changeset, full gates

**Files:** design-note (a short `docs/subsystems/schema-identifiers.md` OR a section in an existing schema doc — check what exists; if none, a concise new subsystem doc), `.changeset/schema-identifiers.md`, plus any exports if a new type/helper must be public (likely none — members ride existing exported types; if `mintFieldId` or a binding helper needs export, add to root barrel + update goldens + `_FrozenTypes`).

- [ ] **Step 1: design note** — record: the field-id model (opaque, minted-once, preserved-by-name, carried-by-rename); the generation↔content-hash binding (vault-wide); the **per-collection-generation rejection** with rationale; the #941 seam (these fields lift into the schema manifest).
- [ ] **Step 2: exports/goldens** — only if a new public name was added; run root-barrel + cargo goldens, update JSON + `_FrozenTypes` for new names only, cargo untouched.
- [ ] **Step 3: changeset** `.changeset/schema-identifiers.md` (`'@noy-db/hub': minor`): stable field IDs (immutable across rename) + generation↔content-hash binding on persisted schema; back-compatible; feeds the manifest engine (#941).
- [ ] **Step 4: full gates** — build, check:types, test (full), check:architecture, lint, typecheck — all green.
- [ ] **Step 5: commit** — `docs(hub): schema-identifiers design note + changeset (#946)`

## Out of scope
- Reserved-collection layout / schema-manifest engine / open() read path (#941 — consumes these).
- Per-collection generation (rejected here; revisit in #941 if the engine needs it).
