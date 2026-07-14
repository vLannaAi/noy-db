# Milestone #22 — Satellites v1 follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close milestone #22 — #596 (failed-leg no-op revert drops a pre-existing dirty entry — a data-loss bug), #595 (R-S1 label double-use), #597 (stale persisted marker on reused collection name — latent), #599 (R-S7 retro-coverage has no satellite-CEK migration path), the shared-revert-helper consolidation (the user-ratified bounded slice of #588), and closing #588's kernel-primitive question with documented evidence (descoped — user decision).

**Architecture:** Ground truth is `.superpowers/sdd/m22-seam-map.md`. Feature home: `packages/hub/src/with-shape/satellites/` (archetype-③ schema feature, NOT a `with*()`-gated service — always compiled in). Design of record: `docs/superpowers/specs/2026-07-05-satellite-collections-design.md` (the R-S1..R-S9 refusal matrix). All fixes land in `with-shape/satellites/*` (+ `with-commit/tx/transaction.ts` for the helper, + marker types) — mostly outside the kernel-surface ceiling files.

**Tech Stack:** TypeScript ESM, vitest, packages/hub.

## Global Constraints

- **Ceilings (metric = `split('\n').length`):** collection.ts 4472 (1 line headroom), vault.ts 3939 (2), noydb.ts 2385 (2). Only #599 might need a thin `vault.ts` call-site (budgetable per the `#591 satellites thin call-sites` precedent — bump `KERNEL_SURFACE_BUDGET` in `check-architecture.mjs` with justification IF needed, prefer keeping the driver in `with-shape/satellites/`). #595/#596/#597 touch zero kernel-ceiling files.
- **Behavior lock:** full existing suite green except tests a task deliberately updates. TDD per task; the data-loss (#596) and CEK-migration (#599) tasks especially need reproduction-first tests. No Claude attribution; changeset LOCAL only; conventional commits ending with the issue ref.
- **Zero-knowledge invariant:** #599 re-encrypts satellite records under fresh per-record CEKs — the migration must go through the enclave/`Collection` CEK machinery (`_applyCutoverTransform`'s mint-CEK logic or a purpose-built sibling), never hand-roll crypto; satellite records must never be written as plaintext or under a shared DEK when `perRecordKeys` is the target.

---

### Task 1: #596 — failed-leg no-op revert must not drop a pre-existing dirty entry (DATA LOSS)

**Seam map:** §#596. Surgical fix in `packages/hub/src/with-shape/satellites/fanout.ts`'s `run` closure.

**Files:**
- Modify: `packages/hub/src/with-shape/satellites/fanout.ts` (the `run` closure + `revertAndCompensate`)
- Test: `packages/hub/__tests__/satellites-fanout-revert.test.ts` (new, or extend an existing satellites test file)

**The bug:** `run` pushes a leg onto `executed` BEFORE `await handle.put(id, rec)` — so a leg whose write THREW is still in `executed` and gets `_compensateRevertedWrite(id)` → `removeDirty(coll, id)`, which keys only on `(collection, id)` and drops ANY pre-existing dirty entry for that id (e.g. a legitimate unsynced prior write to the same id).

**The fix (seam map direction):** split "snapshot prior for revert" (needed even on failure, to know what state existed) from "this leg's write landed and needs dirty compensation on revert" (true only for legs whose `put`/`delete` actually completed). Concretely: snapshot the prior BEFORE the write (keep that), but only mark the leg as dirty-compensation-eligible AFTER `await handle.put(id, rec)` returns; `revertAndCompensate` calls `_compensateRevertedWrite` only for legs that actually wrote (the raw-envelope revert still runs for all snapshotted legs — reverting a no-op prior is harmless; the harm is the unconditional dirty-removal).

- [ ] **Step 1: reproduction test (RED).** The seam map's pinned repro: `msgs_text/x` has a legitimate unsynced dirty entry (direct `msgs_text.put('x', …)`). A joined write `msgs_full.put('x', …)` runs base-leg-succeeds → satellite-leg-THROWS (inject a satellite-schema/adapter error). Assert AFTER the failed fan-out: the pre-existing `msgs_text/x` dirty entry SURVIVES (still queued for sync — inspect the SyncEngine dirty log / the sync-participation surface the existing satellites tests use). Today it's silently dropped → test fails.
- [ ] **Step 2: fix** per above. Run → green. Add a companion: a fan-out where BOTH legs succeed then a LATER leg throws still compensates the legs that DID write (no regression to the legitimate revert path).
- [ ] **Step 3:** run the new test + the existing satellites suites (`pnpm vitest run packages/hub/__tests__/satellites-*.test.ts`) + `pnpm check:architecture` + typecheck. Green.
- [ ] **Step 4: commit** — `fix(hub): satellite fan-out revert only drops dirty entries for legs that actually wrote (#596)`.

---

### Task 2: #595 — retire the R-S1 label double-use

**Seam map:** §#595. Mechanical relabel.

**Files:**
- Modify: `packages/hub/src/with-shape/satellites/registry.ts` (the `register()` one-per-base guard's thrown id at :13)
- Modify: `packages/hub/__tests__/satellites-registry.test.ts` (the `/R-S1/` regex at :19) — and any other test asserting on the one-per-base message
- Modify: `docs/superpowers/specs/2026-07-05-satellite-collections-design.md` (§ Refusal matrix — add a row for the new id)

**The fix:** the one-satellite-per-base guard (`registry.ts:13`) borrowed `R-S1`, but the design doc's real R-S1 is the fields-overlap rule (`post-register.ts:27`). Rename the registry guard's id to a fresh id that "can retire cleanly" when the N-satellites-per-base extension deletes this v1 scope limit — e.g. `R-S10` (or `R-S1b`; pick one, be consistent). Add its refusal-matrix row documented as "v1 scope limit, not a routing-ambiguity rule." Keep `post-register.ts`'s R-S1 (the real one) untouched.

- [ ] **Step 1:** update `registry.ts:13`'s thrown id + message; update the test regex (the test at :16 already hedged the name to `R-S1(v1)` — align it to the new id); add the design-doc refusal-matrix row. **Grep the whole repo for the one-per-base message / `R-S1` to find every assertion** — the seam map lists 3 test sites (`satellites-registry.test.ts:16-19,39-40`, `satellites-registration.test.ts:98-103`); confirm which assert the one-per-base guard vs the real R-S1 and update only the one-per-base ones.
- [ ] **Step 2:** run `pnpm vitest run packages/hub/__tests__/satellites-registry.test.ts packages/hub/__tests__/satellites-registration.test.ts` + typecheck. Green.
- [ ] **Step 3: commit** — `refactor(hub): the one-satellite-per-base v1 scope limit gets its own refusal id, freeing R-S1 for the fields-overlap rule (#595)`.

---

### Task 3: #597 — epoch stamp on persisted markers (latent-reuse guard)

**Seam map:** §#597. Add an epoch/generation field to both marker types; latent today (no delete-collection API), landed preemptively.

**Files:**
- Modify: `packages/hub/src/with-shape/satellites/types.ts` (`PairingMarker` +epoch) and `packages/hub/src/kernel/types.ts` (`ClassifiedMarker` +epoch — same shape)
- Modify: `packages/hub/src/with-shape/persisted-schemas/register.ts` (write the epoch on persist; `satelliteMarkersEqual`/classified twin comparison) + `marker.ts` (`ensureSatelliteMarker` reads/compares epoch)
- Test: extend the persisted-marker tests (grep `__tests__` for `PairingMarker`/`persistSatelliteMarker`/`ensureSatelliteMarker`)

**The fix:** add an `epoch` (or `createdAt`-generation) field to `PairingMarker` and `ClassifiedMarker`, stamped at declaration/collection-creation time and carried on read. Since there's no delete-collection API, there's no live reuse path to break TODAY — so the epoch is additive metadata now, with the reuse-liveness CHECK a documented follow-up for whenever collection-deletion ships (a marker whose epoch predates the collection's current lifetime is stale). Keep it minimal: land the field + persist/read it + a test that the field round-trips; document (code comment + design doc) that the epoch-mismatch REJECTION is deferred until a delete-collection API exists to make reuse reachable.

- [ ] **Step 1: failing test.** Assert the epoch field is written into `_schemas/<name>` on satellite (and classified) marker persist, and read back by `ensureSatelliteMarker`. RED (field doesn't exist yet).
- [ ] **Step 2: implement** the additive field + persist/read + `*MarkersEqual` treats epoch as metadata (does NOT break the existing "same marker" fast-path for a live collection re-opening itself — an unchanged collection re-declares with the SAME epoch, so equality still holds). Comment the deferred-rejection intent.
- [ ] **Step 3:** run the persisted-marker + satellites + classified suites (`pnpm vitest run packages/hub/__tests__ -t marker` and the satellites/classified files) + typecheck + check:architecture. Green (no behavior change for live collections).
- [ ] **Step 4: commit** — `feat(hub): persisted satellite/classified markers carry a lifetime epoch (latent reuse-staleness guard, #597)`.

---

### Task 4: #599 — satellite-CEK migration path for R-S7 retro-coverage

**Seam map:** §#599. The largest buildable item. Self-contained to `with-shape/satellites/` + a possible thin `vault.ts` call-site. **Do AFTER Task 3** (the migration writes a fresh marker; an epoch-aware marker shape avoids a second touch).

**Files:**
- Create: `packages/hub/src/with-shape/satellites/migrate-cek.ts` (the migration driver)
- Modify: `packages/hub/src/with-shape/satellites/declare.ts` (the R-S7 gate — expose the migration entry point / a way to run it that precedes or bypasses the gate for the migration pass)
- Possibly Modify: `packages/hub/src/kernel/vault.ts` (a thin `vault.migrateSatellitePerRecordKeys(...)`-style call-site IF the public entry point needs to live there — budget the ceiling; prefer routing through the existing satellites declaration surface)
- Reuse (do NOT duplicate crypto): `Collection._applyCutoverTransform`'s mint-CEK-for-legacy-records logic (`collection.ts:2537-2545`) or a purpose-built sibling that goes through the same enclave CEK path
- Test: `packages/hub/__tests__/satellites-cek-migration.test.ts` (new, spy-store)

**The gap (seam map):** R-S7 correctly refuses declaring a satellite of a newly-forget-covered base without `perRecordKeys`, but there's NO way to get past it: `perRecordKeys` is construction-only, and the only per-record re-encrypt primitive (`_applyCutoverTransform`) is wired only to the generic schema-update cutover, which itself needs the collection already constructed with the target mode — chicken-and-egg.

**The deliverable (seam map, confirmed missing):** a satellite-CEK migration, invocable at/before declaration time, that (a) constructs/re-opens the satellite forcing `perRecordKeys: true` for the migration pass (preceding the R-S7 gate for that pass), (b) walks every existing satellite record and re-encrypts it under a fresh per-record CEK (reuse `_applyCutoverTransform`'s mint-CEK logic), (c) is resumable (reuse or mirror the `schema-update/fence*.ts` quiesce/fencing story, or a standalone equivalent), (d) is spy-store tested.

- [ ] **Step 1: design-confirm in the report FIRST.** Before coding, read `_applyCutoverTransform` (`collection.ts:2524-2557`), `runSchemaCutover` (`vault.ts:1251-1264`), and `schema-update/fence*.ts`; decide in the report: reuse the generic cutover with a satellite-specific pre-construction step, OR a purpose-built driver. State the chicken-and-egg break (how the migration pass legally constructs the satellite with `perRecordKeys:true` past R-S7). This is a genuine design decision — record it before implementing.
- [ ] **Step 2: failing test (RED).** Spy-store scenario: app v1 declares `msgs_text satelliteOf msgs` WITHOUT perRecordKeys, writes records; app v2 adds `withForgetCascade({ subjects: { msgs: 'ownerId' } })`; re-open → today R-S7 refuses with no way forward. Assert the NEW migration entry point (a) completes, (b) every prior satellite record is now re-encrypted under a distinct per-record CEK (spy the enclave/CEK resolution — assert distinct CEKs per record, not a shared DEK), (c) after migration the satellite declares cleanly (R-S7 satisfied), (d) resumability: interrupt mid-migration (spy-store throws on the Nth record) → re-run resumes and completes without double-encrypting already-migrated records. RED before the driver exists.
- [ ] **Step 3: implement** the driver per the Step-1 decision. Zero-knowledge: every re-encrypt goes through the enclave CEK path; assert no plaintext/shared-DEK write.
- [ ] **Step 4:** run the new test + full satellites suite + the forget/classified suites (perRecordKeys interactions) + check:architecture (+ ceiling if a vault.ts call-site was added — report the bump + justification) + typecheck. Green.
- [ ] **Step 5: commit** — `feat(hub): satellite per-record-CEK migration unblocks R-S7 retro-coverage (#599)`.

---

### Task 5: shared-revert-helper consolidation (bounded #588 — user-ratified)

**Seam map:** §#588 (the "recommended near-term action"). **Do AFTER Task 1** so the helper captures #596's fixed fan-out revert.

**Files:**
- Create: a shared helper (location: a neutral home both consumers can import — e.g. `packages/hub/src/kernel/best-effort-revert.ts` if both `with-commit` and `with-shape/satellites` may import it, OR `with-shape/` if layering permits; CHECK the import direction against check-architecture before placing it — `with-commit` and `with-shape` must both be allowed to import it, and it must not create a `with-* → with-*` illegal edge)
- Modify: `packages/hub/src/with-shape/satellites/fanout.ts` (`revertAndCompensate` calls the helper with its `_compensateRevertedWrite` compensation callback)
- Modify: `packages/hub/src/with-commit/tx/transaction.ts` (`revertExecuted` calls the helper with NO compensation callback)
- Test: a focused helper unit test + confirm both consumers' existing tests stay green

**The consolidation:** extract the common shape — reverse-order, best-effort (try/catch per leg), raw-adapter revert (`put(prior)` or `delete` when prior is null) — into one helper taking `(executed, adapter, vaultName, perLegCompensate?)`. `fanout.ts` passes its post-#596 compensation callback (only for legs that wrote); `transaction.ts` passes none. Do NOT fold in `putManyAtomic` (single-collection, lower priority — seam map). The helper must preserve BOTH consumers' exact current semantics (fanout's #596-fixed dirty-compensation; transaction's compensation-free raw revert) — this is a refactor, behavior-neutral, pinned by the existing tests of both.

- [ ] **Step 1:** place the helper legally (verify import direction with a dry `pnpm check:architecture` after a stub). Write a helper unit test (reverse order, best-effort continues past a throwing leg, compensation callback fires only when supplied and per-leg).
- [ ] **Step 2:** route `revertAndCompensate` and `revertExecuted` through it; delete the duplicated loops. Run BOTH consumers' full test suites (`satellites-*`, `with-commit`/`tx` tests) — all green, behavior-neutral.
- [ ] **Step 3:** check:architecture (no illegal with-*→with-* edge) + typecheck. Commit — `refactor(hub): extract the best-effort reverse-revert helper shared by satellite fan-out and tx (bounded #588 consolidation)`.

---

### Task 6: docs, changeset, gauntlet, and the #588 descope close

- [ ] **Step 1: #588 descope close.** Post a comment on #588 (via `gh issue comment 588`) recording: (i) the fourth-family observation (with-formula derivations/MVs also hand-roll fan-out/revert) as new exit-criterion evidence; (ii) that the bounded shared-revert-helper consolidation LANDED (Task 5, this arc) — the DRY win without the kernel primitive; (iii) the kernel cross-collection-atomic-write primitive stays PARKED (adapter-contract-breaking, cross-repo to noy-db-to + adapter-conformance, design-spec-first) pending a real torn-pair report or scheduled cross-repo adapter work. Then close #588 as not-planned/deferred with `state_reason`. (Do this in Task 6, not at PR merge, since #588 is a descope not a code-close — `Closes #588` in the PR would wrongly imply a build.)
- [ ] **Step 2: docs sweep.** Update the satellites design doc / any `docs/subsystems` satellite page for the #595 refusal-id, the #597 epoch field, the #599 migration path. Ensure the R-S7 doc now points at the migration as the way forward.
- [ ] **Step 3: changeset** LOCAL `.changeset/m22-satellites-followups.md` — `@noy-db/hub: minor` (#599 adds a public migration entry point; #597 adds marker fields). Body: one line per shipped issue (#595/#596/#597/#599 + the shared-revert consolidation); note #588 descoped.
- [ ] **Step 4: full gauntlet** — `pnpm --filter @noy-db/hub test`, typecheck, lint, `pnpm check:architecture`, build + bundle-check. Report ceilings + counts. Grep the diff for attribution/client-name (zero hits).
- [ ] **Step 5: commit** — `docs(hub): satellites v1 follow-up docs (#595 #596 #597 #599)`.

## Self-review notes
- #596→T1 (data-loss, repro-first); #595→T2 (relabel); #597→T3 (epoch, before T4); #599→T4 (CEK migration, design-confirm-first, zero-knowledge); #588→T5 (bounded helper) + T6 Step 1 (descope close with evidence); docs/changeset→T6.
- The PR closes #595/#596/#597/#599 (plain `Closes #NNN`); #588 is closed separately in T6 Step 1 as a descope (NOT via the PR).
- Ceiling exposure is #599-only (a possible thin vault.ts call-site) — budget with justification per the #591 precedent; keep the driver in with-shape/satellites otherwise.
- Zero-knowledge (T4): every re-encrypt through the enclave CEK path, distinct per-record CEKs asserted, no plaintext/shared-DEK write.
