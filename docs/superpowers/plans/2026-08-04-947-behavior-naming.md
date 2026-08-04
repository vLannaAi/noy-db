# #947 behavior-naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Give guards and derivations an optional developer-provided `name` (unique per vault, validated at registration), fix the `dumpSchema` derivation-keying collision, and add a public read-only enumeration of the behavior registries — so the (future) behavior manifest can reference behaviors by stable name. Closes #947 (milestone 46). Builds on #948 (merged).

**Architecture:** Behaviors don't carry names today. Add a `name?` slot to `GuardSpec`/`DerivationSpec`, enforce per-vault name uniqueness inside the registries (which are not line-ceilinged) driven from the vault's `_initGuards`/`_initDerivations`, fix the derivation-descriptor keying in `walk.ts` to use names (collision-safe fallback when unnamed), and expose a typed `Vault.listBehaviors()` whose builder lives in a NEW `with-shape/introspection/behaviors.ts` (keeping vault.ts a thin delegator — it has only 1 line of ceiling headroom).

**Tech Stack:** TS ESM, `crypto.subtle` only, vitest, pnpm. Package: `@noy-db/hub`.

## Global Constraints
- Branch `fix/947-behavior-naming` (off main, AFTER #948/#972 merges). Commit per task. **NEVER add Claude/AI attribution.** Grep the diff for any private-client name before each commit.
- Kernel-surface ceilings (post-#948, `scripts/check-architecture.mjs`): `vault.ts` 3703 (1 line), `collection.ts` 4311 (1 line — do NOT touch), `noydb.ts` 2161 (28). Registries (`with-audit/guards/registry.ts`, `with-formula/derivations/registry.ts`), `walk.ts`, and the new `behaviors.ts` are NOT ceilinged — push logic there. Any vault.ts addition must be a thin delegator; if it would exceed 3703, extract more or tell me. Never raise a ceiling.
- Hub portability: no Node built-ins, crypto.subtle only.
- The kernel-API golden (`kernel-api.golden.json`) is hand-edited — adding `Vault.listBehaviors` requires adding it (sorted). New exported types go in `root-barrel-surface.golden.json` (its test sorts both sides, so placement is hygiene only).
- Gates: `pnpm --filter @noy-db/hub build && test` + `pnpm --filter @noy-db/hub typecheck` + `pnpm check:architecture` + `pnpm lint`. All green.

## Locked decisions (maintainer)
- **`name` is OPTIONAL.** Unnamed guards/derivations remain valid; only a DUPLICATE name within one vault throws (at registration).
- **Satellites:** the AC says "all five registries." Include satellites in `listBehaviors`, but surface only what the `SatelliteRegistry` already exposes (a read-only accessor + whatever identifier/spec-half it carries). Do NOT invent a naming/uniqueness model for satellite pairings in this issue — if they carry no natural name, surface their existing identifier and note it. (Guards/derivations get the full name+uniqueness treatment; MVs/overlays already carry `name`.)
- **Collision fallback (unnamed derivations):** named → `name`; unnamed → a collision-safe deterministic fallback (the current `[...outputs].sort().join('+')` suffixed with an occurrence index when it would collide). The fixture: two derivations with the same output set must both appear.

## Verified source facts (from recon — .superpowers/sdd/scratch-947-recon.md)
- `GuardSpec` `with-audit/guards/types.ts:84-144` (no name); `DerivationSpec` `with-formula/derivations/types.ts:128` (no name). MVs/overlays already carry `name`.
- Factories: `withGuard()` `with-audit/guards/with-guard.ts:17`; `withDerivation()` `with-formula/derivations/with-derivation.ts:12`.
- Registries: `GuardRegistry` `with-audit/guards/registry.ts:30` (`register()` :36 indexes `_byCollection`; `summary()` :48 → `{collection,count}[]`); `DerivationRegistry` `with-formula/derivations/registry.ts:42` (`register()` :47 indexes `_bySource`/`_byOutput`; `all()` :116 → `RegisteredStrategy{spec,strategyHash}`). Neither has a name map. Both are unceilinged.
- Vault wiring: `_initGuards` vault.ts:2378-2388, `_initDerivations` vault.ts:2408-2428 (loops calling `registry.register(...)` over handles — add uniqueness here or in register()). `@internal` `_getGuardRegistry` :2395 / `_getDerivationRegistry` :2434. `SatelliteRegistry` field vault.ts:283 (private, no accessor).
- Snapshot: `VaultSchemaSnapshot` `with-shape/introspection/types.ts:123-135`; `DerivationDescriptor` `{source,outputs}` :113-116. Collision bug: `walk.ts` `describeDerivations` :305-332 keys by `[...outputCollections].sort().join('+')` :323-324 (two same-output derivations overwrite). walk.ts regions here are DISJOINT from #948's (refs 143-147, indexes 208, subsystems). Route enumeration through a SEPARATE `Vault.listBehaviors()` — do NOT widen the `_introspectState` literal (vault.ts:3247, which #948 rewrote).
- Golden: root-barrel already exports `GuardSpec`/`DerivationSpec`/`DerivationDescriptor`/`SchemaIntrospection`/`VaultSchemaSnapshot`. Consumers `in-devtools/src/snapshot.ts:10` + `cli/src/commands/describe.ts:125/154` read `snapshot.derivations` (benefit automatically).

---

### Task 1: `name?` on GuardSpec/DerivationSpec + register-time uniqueness

**Files:** `packages/hub/src/with-audit/guards/types.ts` (add `name?: string`); `packages/hub/src/with-formula/derivations/types.ts` (add `name?: string`); `packages/hub/src/with-audit/guards/registry.ts` + `packages/hub/src/with-formula/derivations/registry.ts` (name map + duplicate-throw); tests in `__tests__/guards/` + `__tests__/derivations/`.

**Behavior:** add optional `name?: string` to both specs (doc it: "stable per-vault identifier the behavior manifest references"). In each registry's `register()`, if a spec has a `name` and that name is already registered in this vault, throw a typed error (e.g. `DuplicateBehaviorNameError` with the name + kind) BEFORE indexing. Maintain a `_byName` map. Unnamed specs register as today (no uniqueness constraint). Adding `name?` to existing interfaces does NOT change the exported-name set (no root-barrel golden change), but confirm the type-surface tests pass.

- [ ] **Step 1: failing tests** — register two guards with the same `name` in one vault → throws the typed error; two with different names or unnamed → fine. Same for derivations. Assert the error type/message. (Read `with-guard.test.ts`/`with-derivation.test.ts` fixtures.)
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** the `name?` slots + `_byName` maps + duplicate-throw. Export the error type from the same module the other guard/derivation errors use; if that module is re-exported by the barrel, add the error name to `root-barrel-surface.golden.json`.
- [ ] **Step 4: green** + typecheck + `check:architecture` (registries unceilinged; confirm vault.ts untouched or ≤3703).
- [ ] **Step 5: commit** — `feat(hub): optional name slots on guards/derivations with per-vault uniqueness (#947)`

---

### Task 2: collision-safe dumpSchema derivation keying (LOW-RISK, standalone)

**Files:** `packages/hub/src/with-shape/introspection/walk.ts` (`describeDerivations` :305-332); `packages/hub/src/with-shape/introspection/types.ts` (`DerivationDescriptor` — add `name?: string`); new test `packages/hub/__tests__/introspection/dump-schema-derivation-collision.test.ts`.

**Behavior:** in `describeDerivations`, key each derivation by its `name` when present; when unnamed, use the current `[...outputCollections].sort().join('+')` but make it collision-safe (append an occurrence index — e.g. `key`, `key#1`, `key#2` — when the same key recurs) so two same-output derivations both appear. Add `name?: string` to `DerivationDescriptor` and populate it from the spec's `name`. walk.ts is unceilinged.

- [ ] **Step 1: failing test** — a vault with TWO derivations producing the SAME output set (one named, one unnamed, or both unnamed) → `dumpSchema().<derivations>` contains BOTH entries (today one overwrites the other). Assert both present, named one keyed by name, `DerivationDescriptor.name` reflects the spec name. Model on `dump-schema-views.test.ts`.
- [ ] **Step 2: red** (confirm today only one entry appears).
- [ ] **Step 3: implement** the keying + `DerivationDescriptor.name`.
- [ ] **Step 4: green** + typecheck. Confirm `in-devtools`/`cli` consumers still typecheck (`pnpm --filter @noy-db/in-devtools typecheck`).
- [ ] **Step 5: commit** — `fix(hub): collision-safe derivation keying in dumpSchema; surface derivation name (#947)`

---

### Task 3: public `Vault.listBehaviors()` over the five registries

**Files:** new `packages/hub/src/with-shape/introspection/behaviors.ts` (the builder + `BehaviorSummary` type); `packages/hub/src/kernel/vault.ts` (thin `listBehaviors()` delegator + a read-only `SatelliteRegistry` accessor if needed); `packages/hub/src/kernel/types.ts` or the introspection types (export `BehaviorSummary`); `packages/hub/__tests__/kernel-api.golden.json` (+`listBehaviors`); `root-barrel-surface.golden.json` (+`BehaviorSummary`); tests.

**Behavior:** `Vault.listBehaviors(): BehaviorSummary` returns a typed, read-only enumeration of all five behavior registries — guards, derivations, materialized views, overlays, satellites — each entry carrying its `name` (guards/derivations: the new optional name or a deterministic fallback; MVs/overlays: their existing name; satellites: whatever identifier the registry exposes) plus the SERIALIZABLE half of its spec (never a function body — omit `check`/`derive`/etc.). The BUILDER lives in `behaviors.ts` taking the registries as params; `Vault.listBehaviors` is a thin delegator (vault.ts has 1 line of headroom — the method must be ~2-3 lines calling the builder). Add a read-only accessor for `SatelliteRegistry` (currently private, no accessor) — minimal, mirror the MV/overlay registry access. `dumpSchema` MAY be refactored to consume the same door instead of duck-typing, but only if net-neutral on vault.ts; otherwise leave dumpSchema as-is.

- [ ] **Step 1: failing tests** — a vault with a named guard, a named derivation, an MV, an overlay (and a satellite if easily wired) → `db.openVault(v).listBehaviors()` returns all of them with names + serializable spec halves, and NO function fields. Assert the shape per registry. (`listBehaviors` is public → the kernel-api golden test will fail until you add it — do that in step 3.)
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** `behaviors.ts` builder + `BehaviorSummary` type + the thin vault.ts delegator + satellite accessor. Add `listBehaviors` (sorted) to `kernel-api.golden.json` and `BehaviorSummary` to `root-barrel-surface.golden.json`. Confirm `wc -l vault.ts` ≤ 3703 measured (the delegator + accessor must fit the 1-line budget — if not, extract the satellite accessor logic too, or tell me).
- [ ] **Step 4: green** + typecheck + `check:architecture` (vault.ts ≤ ceiling) + kernel-api golden + root-barrel golden.
- [ ] **Step 5: commit** — `feat(hub): Vault.listBehaviors() — read-only enumeration of the five behavior registries (#947)`

---

### Task 4: docs + changeset + full gates

**Files:** doc (naming-convention note — extend an existing behavior/introspection doc or add a short section); `.changeset/behavior-naming.md`.

- [ ] **Step 1: doc** — the naming convention: guards/derivations accept an optional per-vault-unique `name`; the behavior manifest (future) references behaviors by name; `listBehaviors()` enumerates all five registries read-only.
- [ ] **Step 2: changeset** `.changeset/behavior-naming.md` (`'@noy-db/hub': minor`): guards and derivations accept an optional `name` (unique per vault, enforced at registration); `dumpSchema` derivation keying is now collision-safe and surfaces the name; new `Vault.listBehaviors()` enumerates the five behavior registries (names + serializable spec halves).
- [ ] **Step 3: full gates** — `pnpm --filter @noy-db/hub build && test`, typecheck, `pnpm check:architecture`, `pnpm --filter @noy-db/in-devtools typecheck`, `pnpm lint`. All green; kernel-api + root-barrel goldens pass.
- [ ] **Step 4: commit** — `docs: behavior-naming convention + changeset (#947)`

## Out of scope
- The behavior manifest itself (a later manifest-set issue).
- Any change to how behaviors execute; serializing function bodies.
- A naming/uniqueness model for satellite pairings (surface existing identifiers only).
- #945 (store-locator) — separate branch.
