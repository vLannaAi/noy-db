# Changelog — hub

## 0.1.0-pre.14

Two related strands shipped together: **Guards/Derivations v1.5** fast-follows from the pre.11 surface, then **Dim 14 v2 — `withMaterializedView`** built on top. 12 issues closed across 7 merged PRs; ~3000 LOC added across `src/`; 1573 hub tests pass on the tip.

### Guards/Derivations v1.5 ([#148](https://github.com/vLannaAi/noy-db/pull/148))

Four fast-follow refinements that landed first to give the MV v2 work a hardened `ReadOnlyVaultFacade` foundation:

- **`withGuard.onDelete`** ([#145](https://github.com/vLannaAi/noy-db/issues/145)) — guards can now reject deletes based on record state. Mirrors the `check` hook's shape but fires on `Collection.delete`. Used by the v2 MV tombstoning path: a `receipts.onDelete: throw` rule no longer deadlocks the system's own housekeeping deletes (see § Tombstone bypass below).
- **`withDerivation` optional outputs** ([#144](https://github.com/vLannaAi/noy-db/issues/144)) — declare an output as `optional: true` and return `null` to skip emission. If a prior derivation emitted at this id, it's tombstoned via `Collection._internalDelete` (system-internal bypass of user `onDelete` guards). Returning `null` for a non-optional output still throws `DerivationOutputShapeError`.
- **`derive(source, ctx)` gets the `ReadOnlyVaultFacade`** ([#147](https://github.com/vLannaAi/noy-db/issues/147)) — same facade guards have. `ctx.vault.collection<T>('siblings').get(id)` works inside `derive`. Strategy hash incorporates `derive.toString()` so the function body pins inputs; sibling reads must be deterministic given the same source row (consumer responsibility).
- **`.query()` on `ReadOnlyVaultFacade`** ([#146](https://github.com/vLannaAi/noy-db/issues/146)) — aggregating checks can now express set-level invariants (`vault.collection('invoices').query().where(...).count()`) inside guard `check` callbacks. Closes the "I can't enforce 'no two open invoices for the same client' without sweeping list()s" gap.

### Dim 14 v2 — `withMaterializedView` ([#149](https://github.com/vLannaAi/noy-db/issues/142) spec + [#143](https://github.com/vLannaAi/noy-db/issues/143) implementation epic)

Query-level materialized views. Where `withDerivation` v1 projects one source row into N typed outputs, `withMaterializedView` materializes the result of an entire `Query<T>` — filter, groupBy, aggregate, join — into a queryable collection kept fresh on source writes. Six sub-issues across foundation, lifecycles, correctness, predicates, overlays, and showcases:

- **Foundation** ([#150](https://github.com/vLannaAi/noy-db/issues/150), PR [#156](https://github.com/vLannaAi/noy-db/pull/156)) — `withMaterializedView({ name, query, rowKey, refresh })` factory; `MaterializedViewRegistry`; `MaterializedViewExecutor`; `Collection.put` source-write hook for eager refresh. `_materializedFrom` payload metadata (lives inside encrypted `_data`, opaque to the store — matches `_derivedFrom` precedent). `MaterializedViewCycleError` + `MaterializedViewSourceUnknownError`. New `@noy-db/hub/materialized-views` subpath.
- **Lazy + manual lifecycles** ([#151](https://github.com/vLannaAi/noy-db/issues/151), PR [#157](https://github.com/vLannaAi/noy-db/pull/157)) — `refresh: 'lazy'` marks the MV stale on source writes; the next read of the MV output collection resolves on demand. `refresh: 'manual'` opts out of the source-write hook entirely; `vault.refreshView(name)` is the only refresh path. Returns `{ written, deleted, failed }` — niwat-review caught the original "deleted: 0 hardcode" pre-merge.
- **Correctness — partition / onEmpty / ceiling / strict / aggregate** ([#152](https://github.com/vLannaAi/noy-db/issues/152), PR [#158](https://github.com/vLannaAi/noy-db/pull/158)) — five strategy fields:
  - `output.partition: { field, value }` — same-collection edges are allowed when a where-clause provably excludes `partition.value` (`==` against a different value, `!=` against the value, `in` lists that exclude it). Cycle detector resolves these as non-cycles.
  - `onEmpty: 'delete' | 'keep'` (default `'delete'`) — when a key that previously emitted rows yields zero rows, tombstone via `Collection._internalDelete`. User `onDelete` guards on the output collection are bypassed for housekeeping (the composition fix that makes #145 + MV refresh coherent).
  - `maxRows` (default `100_000`) — row-count ceiling; throws `MaterializedViewTooLargeError` **before** any writes (clean rollback).
  - `strict: true` re-throws row-write failures → composes with `withTransactions` to roll back the source-write atomically via `revertExecuted` (the orphan-window fix from pre.12 #133).
  - **Aggregate / groupBy queries** — executor branches on the terminal shape (`Query<T>.toArray()` / `Aggregation.run()` / `GroupedAggregation.run()`). `groupBy().aggregate()` closes over its source so the dep analyzer can't introspect; aggregate MVs require explicit `sources?: string[]`.
- **Declared deterministic predicates** ([#153](https://github.com/vLannaAi/noy-db/issues/153), PR [#159](https://github.com/vLannaAi/noy-db/pull/159)) — `MaterializedViewStrategy.predicates: { [name]: { hash, fn } }` registers named functions callable from inside the MV's `query()` callback via `.wherePredicate(name, ctx?)`. The predicate's `hash` **and** a canonical-JSON hash of the `ctx` argument both fold into `queryHash` — bumping `hash` or changing `ctx` forces refresh. Canonical use: `isOverdue` against an `asOf` date that moves externally. Niwat-review caught the original "predicates dropped through chain methods" pre-merge: every chain operator (`where`, `or`, `and`, `filter`, `orderBy`, `limit`, `offset`, `join`) now threads the predicates map.
- **Overlay views — `withOverlayedView`** ([#154](https://github.com/vLannaAi/noy-db/issues/154), PR [#160](https://github.com/vLannaAi/noy-db/pull/160)) — read-shadow primitive. Declares a virtual collection that merges a `base` (typically an MV output) with a user-writable `overlay` via a single-field shadow predicate (`overlay[shadowField] === shadowValue`). Writes through the virtual proxy route to the overlay. Constraints: `base` must be concrete (no overlay-on-overlay stacking — v3 non-goal); `overlay` must not be an MV output; virtual name must not collide with concrete collections or MV outputs. Four error classes (`OverlayBaseIsVirtualError`, `OverlayCollectionUnavailableError`, `OverlayNameCollisionError`, `OverlayIdMismatchError`).
- **Showcases + reader-facing docs** ([#155](https://github.com/vLannaAi/noy-db/issues/155), PR [#161](https://github.com/vLannaAi/noy-db/pull/161)) — four new showcases (`81-with-mv-eager`, `82-with-mv-lazy`, `83-with-overlay`, `84-with-mv-predicates`) totaling 19 tests; `docs/subsystems/derivations.md` extended with Materialized Views + Overlay views sections; `features.yaml` entries for `materialized-views` and `overlay-views`.

### Composition story

The pre.14 release closes the loop on the write-path primitive composition:

- **Guards** ([#123](https://github.com/vLannaAi/noy-db/issues/123), pre.11) — block writes before encryption.
- **Derivations** ([#129](https://github.com/vLannaAi/noy-db/issues/129), pre.11) — eager / lazy record-level projections, post-write.
- **`withGuard.onDelete`** ([#145](https://github.com/vLannaAi/noy-db/issues/145), pre.14) — symmetric delete-side gate.
- **Materialized views** ([#143](https://github.com/vLannaAi/noy-db/issues/143), pre.14) — query-level derivations; same encryption / opacity guarantees.
- **Overlay views** ([#154](https://github.com/vLannaAi/noy-db/issues/154), pre.14) — operator-editable override layer over MV outputs.

The `Collection._internalDelete` housekeeping bypass (introduced in #148 for #144's tombstoning) is the load-bearing primitive that keeps `withGuard.onDelete: throw` rules coherent with system-driven tombstones from optional derivations and MV `onEmpty: 'delete'` flows.

### Process notes for niwat integration

- All five MV PRs (#156–#160) plus #161 passed niwat-review with "No issues found" verdicts after pre-merge fixes. The niwat-review pattern that worked: surface composition issues (e.g. "list/query/scan don't trigger lazy resolve", "chain methods drop predicates map") before the PR landed on main.
- Stacked-PR rebase pattern documented in [project memory](https://github.com/vLannaAi/noy-db/blob/main/) after this cycle: when squash-merging a stack of N PRs, the canonical recovery for the (N+1)th descendant is `reset --hard origin/main && cherry-pick <descendant-only-commits>` rather than re-rebasing the original branch. Re-rebasing leaks conflict markers when the parent's content has been merged with reviewer-fix tweaks.

### Files of interest

- `packages/hub/src/materialized-views/{executor,registry,stale,dependency-analyzer,query-hash,with-materialized-view}.ts`
- `packages/hub/src/overlay-views/{registry,virtual-collection,with-overlayed-view,types}.ts`
- `packages/hub/src/query/builder.ts` (predicates threading + `serializeClause` for `wherePredicate`)
- `showcases/src/8{1,2,3,4}-*.showcase.test.ts`
- `docs/subsystems/derivations.md` (extended)
- `docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md` (the spec)

## 0.1.0-pre.12

Three follow-ups from pre.11's guards + derivation work: bundle regression plugged ([#130](https://github.com/vLannaAi/noy-db/issues/130)), strict-mode multi-output orphan window closed ([#133](https://github.com/vLannaAi/noy-db/issues/133)), and user-list visibility flags shipped ([#122](https://github.com/vLannaAi/noy-db/issues/122)). Plus [#132](https://github.com/vLannaAi/noy-db/issues/132) closed as superseded by #130.

### Bundle regression fix (#130)

Root cause: `Vault` and `Collection` had **static value imports** of `GuardRegistry`, `DerivationRegistry`, `ReadOnlyVaultFacade`, `GuardExecutor`, and `DerivationExecutor` — forcing the classes into `dist/index.js` even when consumers only imported `createNoydb`. Verified by inspecting the generated dist artefacts: the 5 class names all appeared in the floor bundle's top-level imports.

- **Fix** — converted all 5 to type-only imports + lazy `await import(...)` at construction / dispatch time. Mirrors the deferred-load approach already used by some other subsystems.
- **Bundle measurement** — floor dropped from **45,238 gz → 39,524 gz (−12.6%)**. Not all the way to the v0.25 baseline because of intervening features unrelated to the regression — the baseline has been reset on a methodology that now uses `splitting: true` (matches what real consumer bundlers emit).
- **Leak canaries** — 5 new symbol-presence assertions added to `check-bundle.mjs`, plus a new `eagerImports` field that catches splitting-aware regressions. The prior leak would have silently passed CI without these.
- PR [#138](https://github.com/vLannaAi/noy-db/pull/138), follow-up fixups in commit `03544b3` per code review.

### Strict-mode derivation orphan (#133)

When a strict-mode derivation produced multiple outputs and a later strategy threw, the first M outputs were already written via the `dispatchDerivations` `Collection.put` recursion. Those nested writes were **not** visible to the outer transaction's revert plan, so `revertExecuted` rolled back the source but left orphans on disk.

- **Fix** — `Noydb` now tracks the active transaction context (set by `runTransaction` at Phase 2 start, cleared in `finally`). `Collection.dispatchDerivations` checks the active context and registers each derived put as a side-effect op in `ctx._executed` before the write fires. `revertExecuted` already walks `_executed` in reverse — side-effect entries get reverted naturally.
- **Adjacent site fixed in flight** — same treatment applied to `Collection.putManyAtomic`, which has its own bespoke commit loop and would have had the identical orphan window otherwise (caught in code review).
- **Reproduction scope** — the orphan was only reproducible with **two strategies on the same source**; single-strategy multi-output never partially writes because `DerivationExecutor.run` validates all output shapes upfront before any persistence call.
- PR [#139](https://github.com/vLannaAi/noy-db/pull/139).

### User-list visibility flags (#122)

Two new visibility controls on top of the per-vault user envelope (pre.6 work):

- **Per-user `hidden` flag** — stored at `_meta/visibility/<keyringId>` (sidecar, plaintext bypass — mirrors `_meta/policy` and `_meta/handle`). Set via `vault.user.setMyVisibility({ hidden: true })` (own-only). `listUsersWithEnvelopes` filters hidden envelopes by default; admin / owner callers pass `{ includeHidden: true }` to see them.
- **Vault-level `directory.enabled` flag** — stored at `_meta/directory`. Toggled via `Noydb.setDirectoryEnabled(vault, enabled)` (owner-only). When false, `listUsersWithEnvelopes` throws the new `DirectoryDisabledError` for non-admin / non-owner callers.
- **Breaking API change** — `listUsersWithEnvelopes` gained a required `callerRole: Role` parameter. Consumers using the function directly must update; the hub-internal wrappers source `callerRole` from the unlocked keyring (signed-by-construction, no bypass). Documented as a minor-version surface change.
- **Design adaptation** — the issue proposed adding `hidden` to `PublicUserEnvelope.data`, but `UserEnvelope.data: T` is opaque-to-hub by contract (apps own the schema). Used the sidecar pattern instead, preserving the existing invariant.
- **New error** — `DirectoryDisabledError`, exported from `@noy-db/hub` and the `team/` subpath barrel for `instanceof` checks.
- **Honest caveat documented** — visibility is a **UX flag, not a privacy guarantee**. The keyring count and envelope ciphertext are still observable to anyone with store-read access; hidden hides only the joined plaintext from the directory enumeration.
- **Lifecycle** — `revoke()` also deletes the visibility sidecar (commit `6f5543c`, caught by code review). Without this, a re-granted same-userId would silently inherit the old flag.
- PR [#140](https://github.com/vLannaAi/noy-db/pull/140), follow-up fixup `6f5543c`.

### Closed without code (#132)

The original premise — "pre-hash the `withDerivation` handle so `register()` becomes sync so the `Vault` constructor can own derivation init" — was broken by #130. To plug the bundle regression, `DerivationRegistry` is now dynamically imported via `await import(...)` — the constructor can no longer reference `new DerivationRegistry()` directly. Pre-hashing alone has independent minor value (debugging) but doesn't move the needle on the original goal (plugging the `Noydb.vault()` sync fallback accessor gap). Closed with rationale; revisit if anyone hits the fallback gap in practice.

### Test count growth

1485 → **1494** hub tests (9 new across the three fixes / features). 124 test files total.

### Known follow-ups (pre.13 milestone)

- Remaining real-provider showcase batch (Apple / Google / LINE): [#64](https://github.com/vLannaAi/noy-db/issues/64), [#65](https://github.com/vLannaAi/noy-db/issues/65), [#73](https://github.com/vLannaAi/noy-db/issues/73), [#74](https://github.com/vLannaAi/noy-db/issues/74), [#75](https://github.com/vLannaAi/noy-db/issues/75), [#76](https://github.com/vLannaAi/noy-db/issues/76).

### Issues closed

#122, #130, #132, #133

## 0.1.0-pre.11

Two new subsystems land in the same release: **`withGuard`** (record lock + field freeze + role-gated amendment invariant) and **`withDerivation`** (deterministic derived data, Dim 14 v1). Closes the pre.11 milestone — 8 substantive issues, 2 PRs, plus 4 reviewer-caught side-fixes and 2 tier-2 auth showcases.

### Guards subsystem (#123 epic)

`withGuard` plumbs a uniform three-axis guard primitive — record-level lock, field-level freeze, and role-gated amendment invariant — into the `Collection.put` / `.delete` write path. Strategies register against (collection, fieldOrLock) pairs; the executor runs synchronously inside the put pipeline with full plaintext access. Cross-collection invariants get a `ReadOnlyVaultFacade` so the strategy can read sibling collections without re-entering the write lock.

- **`withGuard` factory + `GuardStrategy` types** ([#123](https://github.com/vLannaAi/noy-db/issues/123)) — `withGuard(spec)` returns a strategy handle; the spec declares `collection`, `kind: 'lock' | 'freeze' | 'invariant'`, target field(s) or lock condition, and an optional `amendable` clause (role list + invariant predicate). New `@noy-db/hub/guards` subpath barrel (sibling of `@noy-db/hub/periods` in the `time-and-audit` cluster).
- **`GuardRegistry` + `GuardExecutor`** ([#124](https://github.com/vLannaAi/noy-db/issues/124)) — registration at vault open, dispatch on every put/delete, frozen-field diff (`fieldChanged(prev, next, path)` deep-equality with array-aware semantics), amendment change collection, invariant runner. Strategies that throw are surfaced as one of the four typed errors below.
- **`LedgerEntry` extension with `op: 'amendment'` + audit-aware skip** ([#125](https://github.com/vLannaAi/noy-db/issues/125)) — every successful amendment writes an extra ledger entry carrying the changed-fields diff + invocation factors. `verifyBackupIntegrity` and `reconstructAtVersion` skip `op: 'amendment'` entries when reconstructing the canonical record stream (these are audit overlays, not state transitions). **Side-fix during review**: pre-fix, both helpers would have falsely failed integrity on any vault with amendment entries — the bug existed in latent form because no amendment entries existed yet. Fixed in this release before any user could hit it.
- **`Collection.put` / `.delete` guard hook + `ReadOnlyVaultFacade`** ([#126](https://github.com/vLannaAi/noy-db/issues/126)) — guard executor runs after permission check, before encryption + ledger commit. `ReadOnlyVaultFacade` exposes a frozen vault snapshot to amendment invariants so cross-collection rules (e.g. "amendment of `invoices` requires open `period` in `periods`") can read sibling state. **Side-fix during review**: the initial PR stubbed the facade as `null` / `[]`, blinding cross-collection reads; caught in code review and replaced with a real read-only proxy over the in-memory plaintext layer.
- **Four error classes** ([#127](https://github.com/vLannaAi/noy-db/issues/127)) — `RecordLockedError`, `FieldFrozenError`, `InvariantError`, `AmendmentForbiddenError`. All carry `collection`, `id`, and rule context; `InvariantError` and `AmendmentForbiddenError` additionally carry the changed-fields list and the invariant's name. Exported from the `@noy-db/hub/guards` subpath barrel + root for `instanceof` checks.
- **Showcase 79 — accounting end-to-end** ([#128](https://github.com/vLannaAi/noy-db/issues/128)) — invoice lock after issue, frozen `amount` / `clientId` post-finalization, period-aware amendment invariant requiring open accounting period + audit-trail role. Full round-trip including ledger replay verification.
- **Side-fix during review** — cache-invalidation in `putManyAtomic` revert path. The transaction-revert pass touched the canonical record but not the cached plaintext, leaving a stale entry. Caught while verifying guard rollback semantics; fix benefits any future `putManyAtomic` revert scenario.

### Derivations subsystem (#129 epic, Dim 14 v1)

`withDerivation` plumbs deterministic derived data — every put on the source collection eagerly recomputes outputs and stamps `_derivedFrom` metadata on each output record. Lazy lifecycle (stale tracking + on-read resolution in `Collection.get`) provides the read-path resolution when the source mutates outside a put (sync replay, batch import).

- **`withDerivation` factory + types** — `DerivationStrategy`, `OutputSpec`, `DerivedFromMeta`. New `@noy-db/hub/derivations` subpath barrel (sibling of `@noy-db/hub/tx` in the `write-and-mutate` cluster).
- **`DerivationRegistry` with DFS cycle detection** — runs at vault open. Builds a strategy DAG; rejects open with `DerivationCycleError` if the cycle wouldn't terminate (carries the offending strategy chain). Max-depth ceiling enforced via `DerivationDepthError`.
- **`DerivationExecutor`** — runs `derive(record)` on plaintext under the same in-memory snapshot the put sees, validates output shape against the registered `OutputSpec` (`DerivationOutputShapeError`), rejects unknown output collections (`DerivationOutputUnknownError`), stamps `_derivedFrom: { source, sourceId, sourceVersion, strategyHash }` on each output record.
- **`computeStrategyHash`** — SHA-256 over `source-collection-name + sorted(output-keys) + derive.toString()`. Stable across runs; lets the lazy path detect drift when the strategy redeploys against existing output records.
- **Four error classes** — `DerivationCycleError`, `DerivationDepthError`, `DerivationOutputUnknownError`, `DerivationOutputShapeError`. Exported from the `@noy-db/hub/derivations` subpath barrel + root.
- **Eager dispatch in `Collection.put`** — after store + ledger commit, the registry's `derivationSource(collection, id)` callback fires, executor walks the strategies, writes outputs. Strict mode rethrows; soft mode marks stale.
- **Lazy lifecycle** — stale tracking via `WeakMap<DerivationRegistry, Set<string>>`. `Collection.get` checks staleness, resolves on read, writes-through. Bulk recompute via `vault.deriveAll(collection)` for cold-cache scenarios.
- **Side-fix during review** — `runTransaction` revert-plan reorder. Pre-fix, `executed.push(...)` ran AFTER the put/delete call, so a mid-put throw (including strict-mode derivation failures) bypassed rollback registration and corrupted the transaction's exit state. Now `executed.push(...)` runs BEFORE the call. The fix benefits any future mid-`Collection.put` throw scenario, not just derivation strict-mode.
- **Showcase 80 — PDF source → meta + text outputs** — round-trip exercising eager + lazy paths, cycle-detection at open, strategy-hash drift recognition.

### Tier-2 auth showcase coverage (#77, #78)

Closes the two `priority: high` real-provider gaps from the 2026-05-09 audit — the only tier-2 packages that hold wrap-key material on their own (`on-password` derives a wrap-DEKs key via PBKDF2; `on-webauthn` releases a PRF fragment to wrap KEK).

- **Showcase 71 — `on-password` tier-2 capability matrix** ([#78](https://github.com/vLannaAi/noy-db/issues/78)) — 16 scenarios pinning the `kek: null` keyring security contract: cold-start unlock via `(vault, userId, password)` triple; capability matrix on tier-1-gated ops (✅ read/write/query, ❌ enrollAuthenticator/rotatePassphrase/grant); re-elevation back to tier 1 restores full capability; password-vs-phrase policy split (password strength is `PasswordPolicy`, phrase strength is `PassphrasePolicy` — they cannot bleed); `@noy-db/on-threat` lockout integration; username-binding regression (slot id `password:<userId>` prevents cross-user replay). Uses `@vitest-environment node` to dodge happy-dom's partial `subtle.exportKey` polyfill.
- **Showcase 72 — `on-webauthn` Playwright virtual authenticator** ([#77](https://github.com/vLannaAi/noy-db/issues/77)) — gated behind `NOYDB_SHOWCASE_WEBAUTHN_VIRTUAL=1` + one-shot `pnpm exec playwright install chromium`. Drives a real Chromium CDP virtual authenticator with PRF support; covers register + assert + PRF determinism (same salt → same fragment) + salt sensitivity (different salt → different fragment) + cross-device rejection (different credential id → assert fails).

### Known follow-ups (pre.12 milestone)

- **[#130](https://github.com/vLannaAi/noy-db/issues/130) — bundle-size regression (~30–48% gz)** introduced by the guards `index.ts` re-export. Under investigation; likely a subpath-barrel-only fix once we trace the exact transitive pull.
- **[#131](https://github.com/vLannaAi/noy-db/issues/131) — `GuardStrategyHandle<any>` type variance refactor** (backlog) — the registry currently widens to `any` at the dispatch boundary; can tighten with a discriminated-union handle once the public surface settles.
- **[#132](https://github.com/vLannaAi/noy-db/issues/132) — `withDerivation` pre-hashed register** — make the factory hash the strategy at construction time so `register()` becomes sync. Plugs the `Noydb.vault()` fallback gap where async-register currently forces a single-tick boundary at vault open.
- **[#133](https://github.com/vLannaAi/noy-db/issues/133) — strict-mode multi-output orphan window** — if a strict-mode derivation produces N outputs and output K throws shape validation, outputs 0..K-1 are already written. Fix is a two-pass write (validate all → commit all) but needs design for the cycle-aware case.

### Issues closed

#77, #78, #123, #124, #125, #126, #127, #128, #129

## 0.1.0-pre.10

### Audit-and-cleanup batch

A 2026-05-09 deep-review of the pre.9 surface (security + API consistency) filed 15 issues; iterative code review of the resulting fixes filed 4 more; one in-flight symmetry close. **20 PRs land in this release**, addressing 18 issues.

#### Security (P0)

- **STRICT_POLICY enroll-user / revoke-user gates are no longer dead-coded** ([#79](https://github.com/vLannaAi/noy-db/issues/79)) — `db.grant` and `db.revoke` now invoke `checkGate('enroll-user', factors)` and `checkGate('revoke-user', factors)` on top of the legacy `checkPolicyOperation`. Adds optional `factors?: FactorProofBundle` parameter to both methods. **Behavior change for STRICT_POLICY consumers**: grants and revokes without a factor proof now correctly throw `PolicyDeniedError` (the documented contract). PERSONAL_POLICY (default) is unchanged — its gates are `minTier: 1` with no factor requirement.

- **`db.changeSecret` validates passphrase strength by default** ([#80](https://github.com/vLannaAi/noy-db/issues/80)) — `assertStrongPassphrase` fires unconditionally unless `allowWeakPassphrase: true` is passed. Pre-fix, `changeSecret` was opt-in (`validate: true`) and the public `db.changeSecret` never opted in — bypassable from the consumer surface even after pre.5 #7 shipped phrase strength validation. **Breaking change**: existing consumers passing weak passphrases through `db.changeSecret` will throw `WeakPassphraseError`. Pass `{ allowWeakPassphrase: true }` to preserve old behavior; for fresh code, use `db.rotatePassphrase` which has the same validation contract end-to-end. The `db.changeSecret` signature gains an optional options argument: `changeSecret(vault, newPassphrase, options?: PassphrasePolicy & { allowWeakPassphrase? })`.

- **`grant()` rejects when caller's kek is null** ([#81](https://github.com/vLannaAi/noy-db/issues/81)) — closes the tier-2 capability matrix violation. Pre-fix, `grant()` iterated `callerKeyring.deks` and wrapped under the new user's `newKek` without ever reading `callerKeyring.kek`, so a tier-2 wrap-DEKs session (`@noy-db/on-password`) or tier-3 PIN-resume session (`@noy-db/on-pin`) could create new user keyrings. The documented contract (per `auth-landscape.md`) is that those tiers cannot perform privileged admin operations. Now mirrors `persistKeyring`'s null-`kek` guard at the head of `grant()`. Same fix applied to `buildRecipientKeyringFile` ([#112](https://github.com/vLannaAi/noy-db/issues/112), bundle-recipient mint) — adjacent site flagged by code review of the original fix.

- **`onInvalidKey: 'reset'` no longer destroys valid keyrings on partial corruption** ([#82](https://github.com/vLannaAi/noy-db/issues/82)) — the audit's highest-impact P0 (silent data loss). Pre-fix, `loadKeyring` walked the wrapped-DEK set in a bare `for...of`; the first corrupted byte killed the load with `InvalidKeyError`, and `onInvalidKey: 'reset'` (#6, pre.7) destroyed the keyring even when the KEK was correct. Now each DEK unwraps independently — mixed success ⇒ corruption (new `KeyringCorruptError`, reset does NOT fire); all-fail ⇒ wrong key (reset fires as documented). New `KeyringCorruptError` class carries `failedCollections: readonly string[]` and `intactCount: number` for targeted recovery UI. Exported from `@noy-db/hub` for `instanceof` checks. `listAccessibleVaults` updated to skip `KeyringCorruptError` like the other expected-failure modes (single corrupt vault no longer poisons the enumeration).

- **Passphrase canary closes the single-DEK + all-DEKs-corrupt ambiguity from #82** ([#113](https://github.com/vLannaAi/noy-db/issues/113)) — additive `KeyringFile.canary?: string` field. The canary is a fixed 256-bit AES-GCM key wrapped under the keyring's KEK with AES-KW. AES-KW is deterministic, so each write site mints fresh on persist without round-tripping a `canary` field through `UnlockedKeyring`. `loadKeyring` verifies the canary first; combined with each-DEK try/catch, this distinguishes wrong-passphrase from corruption even when ALL DEKs (including a single-DEK keyring's sole DEK) are corrupted. Pre-#113 keyrings without the field load via the legacy multi-DEK heuristic from #99 — backward compatible, no migration required.

#### Atomicity / contract holes (P1)

- **`rotatePassphrase` slot ceremony validates `wrapKind`** ([#83](https://github.com/vLannaAi/noy-db/issues/83)) — extends pre.8 #29's anti-slot-swap guard with a third equality check on `wrapKind` alongside `id` and `method`. Closes the hole where a buggy or hostile ceremony could change the slot's session-tier contract under cover of rotation: `'kek' → 'deks'` downgrade silently produces `kek: null` at unlock; `'deks' → 'kek'` upgrade bricks the slot via an AES-KW failure.

- **`recoverPassphrase` burns the paper recovery code BEFORE rewriting the keyring** ([#84](https://github.com/vLannaAi/noy-db/issues/84)) — atomicity reordering. Pre-fix, a store error after the keyring write left the user on the new passphrase but the consumed paper code remained valid (anyone with the same paper sheet could reuse it — security regression). Post-fix, the failure mode flips from security to usability: code burned + keyring not rewritten ⇒ user keeps old passphrase, loses one code (recoverable via admin / another code).

- **`UpdateUserOptions.displayName` accepts `null` to clear the field** ([#85](https://github.com/vLannaAi/noy-db/issues/85)) — aligns `db.updateUser` with the `null`-as-clear convention pre.9 #57 shipped for `UserApi.updateMe`. Type widens from `string | undefined` to `string | null | undefined`. `null` clears (stored as the empty string; UI consumers typically render the empty case by falling back to the user id). `permissions` stays full-replacement at the map level (documented invariant).

- **`RecoverPassphraseInput.recoveryProof` TS-narrowed to `'paper'`** ([#86](https://github.com/vLannaAi/noy-db/issues/86)) — matches `db.enrollRecovery`'s TS-narrow discipline. Pre-fix, the type accepted a 4-variant union (`paper | shamir | multi-channel | admin-mediated`) and three of the four threw `RecoveryProfileNotImplementedError` at runtime. The runtime guard remains — `as unknown as RecoveryProof` bypasses the type but still hits the error. **Breaking-but-narrowing**: a consumer with `recoveryProof` typed as the wide union (e.g. ferrying through helper code) will get a TS error after this lands.

#### DX / surface coherence (P2)

- **`docs/subsystems/plaintext-bypass.md` invariant catalog** ([#87](https://github.com/vLannaAi/noy-db/issues/87)) — every collection that stores JSON in cleartext (`_keyring/<userId>`, `_meta/policy`, `_meta/recovery-paper`, `_meta/handle`, `_meta/public-envelope`, `_meta/invite-audit-<id>`, `_meta/sync-credentials`, ledger, consent, blob index) listed with rationale, plus a threat-model surface ("what an attacker with store-only access can learn"), plus an explicit checklist for adding or removing a bypass.

- **`db.getKeyring()` returns a defensive copy** ([#88](https://github.com/vLannaAi/noy-db/issues/88), [#114](https://github.com/vLannaAi/noy-db/issues/114)) — pre-fix, the returned `UnlockedKeyring`'s `deks` Map (typed `readonly`, but the Map itself isn't) was the live cached reference. A consumer calling `.deks.set()` corrupted the hub's internal state. Now returns a defensive shallow copy with fresh `Map`, fresh `authenticators` array, and per-element clones of `meta`. Hub-internal callers use a new `private getKeyringInternal` that returns the live ref so mutations from `ensureCollectionDEK` still land on the cache. CryptoKey handles inside `deks` stay shared (opaque references; encrypt/decrypt opaque). 14 internal call sites switched.

- **`FactorProofBundle` unifies the gate-method param shape** ([#89](https://github.com/vLannaAi/noy-db/issues/89)) — same shape `{ factors?, sharedDevice? }` was inlined at 12 sites with the parameter name alternating `factors` / `presented`. Now exported as a named type from `@noy-db/hub` (re-exported from the `policy` subpath); param name converges to `factors` everywhere.

- **Subpath barrels (`team/`, `i18n/`, `query/`, `session/`, `bundle/`, `store/`) populated** ([#90](https://github.com/vLannaAi/noy-db/issues/90)) — pre-fix, `@noy-db/hub/team` exported only `UnlockedKeyring` + sync helpers; the rest of the team API (rotate/recover, authenticator family, paper recovery primitives, magic-link grant, peer-recover, listUsers) was reachable only through the root barrel. Per-domain errors (`SessionExpiredError`, `JoinTooLargeError`, `BundleIntegrityError`, `StoreCapabilityError`, the i18n trio) couldn't be `instanceof`-checked from a subpath import. All subpaths now own their domain's full export set.

- **`KeyringAuthenticator` variant types re-exported from index.ts** ([#91](https://github.com/vLannaAi/noy-db/issues/91)) — `KeyringAuthenticatorWrappingKEK`, `KeyringAuthenticatorWrappingDEKs`, `EnrollAuthenticatorWrappingKEKOptions`, `EnrollAuthenticatorWrappingDEKsOptions`. `@noy-db/on-*` package authors writing variant-specific helpers can now name the type directly instead of reconstructing via `Extract<KeyringAuthenticator, { wrapKind: 'deks' }>`.

- **Adapter/Compartment naming residue cleaned up** ([#92](https://github.com/vLannaAi/noy-db/issues/92)) — user-visible strings (`session/dev-unlock.ts`, `collection.ts`), JSDoc in `types.ts`, and three sed-truncation artefacts (`team/index.ts`, `index.ts`, `errors.ts`). The internal `syncAdapter` field name on Collection / Vault / PresenceHandle is intentionally NOT renamed in this release — internal-only but touches multiple constructors and their tests.

- **Leftover `null as unknown as CryptoKey` casts in showcases** ([#93](https://github.com/vLannaAi/noy-db/issues/93)) — pre.8 #41 tightened `UnlockedKeyring.kek` to `CryptoKey | null`. The hub source was correctly migrated; three showcase fixtures (`23-on-webauthn`, `24-on-oidc`, `30-on-pin`) still carried casts. Replaced with literal `null`.

#### Documentation

- **`docs/subsystems/auth-landscape.md` § Package boundaries** ([#43](https://github.com/vLannaAi/noy-db/issues/43)) — names the layering between `@noy-db/hub` (cryptosystem) and the `@noy-db/on-*` packages (user-facing input format) explicitly. Closes #43 as wontfix-by-design — folding `on-recovery` into a `@noy-db/hub/recovery-codes` subpath would anchor Base32 as the canonical format and break consumer swap-ability for no real bundle saving.

#### Issues closed

#43 (wontfix-by-design), #79, #80, #81, #82, #83, #84, #85, #86, #87, #88, #89, #90, #91, #92, #93, #112, #113, #114

## 0.1.0-pre.9

### Consumer-iteration cycle on pre.8 APIs

Closes the 5-issue follow-up batch surfaced after Niwat (first production consumer) shipped pre.8 to production. No new subsystems; surgical extensions to APIs that landed in pre.8.

#### New public APIs

- **`db.updateUser(vault, options, factors?)`** ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — post-grant identity mutation for `role`, `displayName`, and `permissions`. Pure plaintext-header rewrite — no DEK rewrap, no KEK required, no authenticator slots touched. Tier-2 enrollments and recovery codes survive. New `update-user` policy gate (PERSONAL: `minTier: 1`; STRICT: `minTier: 1, factors: ['totp','email-otp']` — admin-shaped, mirrors `enroll-user`/`revoke-user` rather than recovery). Two-sided role-elevation guard mirrors `db.grant`'s hierarchy: BOTH old and new role must satisfy `canUpdateRole(callerRole, _)`, blocking admin self-promote, admin promote-to-owner, admin demote-from-owner, and non-admin self-edit. `permissions` is full-replacement at the map level (consumers wanting partial merge construct `{ ...current, ... }`); top-level fields are partial-merge.

- **`db.updateAuthenticator(vault, slotId, options, factors?)`** ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — meta-only mutation on an existing tier-2 authenticator slot (slot rename, label change). The slot's `id`, `method`, and wrap material (`wrapped_kek` / `wrapped_deks` + `iv`) are immutable through this entry point — anti-slot-swap is **structural**: `UpdateAuthenticatorOptions` only carries `meta`, so the wrap material is unreachable regardless of the gate's settings. New `update-authenticator` policy gate (same shape as enroll/remove). `meta` patch follows #57's null-as-delete semantics at the top level.

- **`UserApi.updateMe<T>(patch)` accepts `null` to clear fields** ([#57](https://github.com/vLannaAi/noy-db/issues/57)) — `null` in the patch deletes the targeted key; `undefined` continues to skip (preserves the pre-feature merge behavior). Matches lodash `_.merge` and Firestore `FieldValue.delete()` semantics. New `DeepPartialOrNull<T>` type exported alongside the existing `DeepPartial<T>` (kept for backward compat); `updateMe<T>`'s patch parameter loosened to `DeepPartialOrNull<T>`. Bug fix found in flight: nested `null` patches against missing source keys now resolve consistently (recurse through synthetic `{}` source) — pre-fix, `{ app: { signature: null } }` against missing `app` produced `{ app: { signature: null } }` instead of `{ app: {} }`.

#### New exported types

- **`UpdateUserOptions`** ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — payload for `db.updateUser`.
- **`UpdateAuthenticatorOptions`** ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — payload for `db.updateAuthenticator`.
- **`DeepPartialOrNull<T>`** ([#57](https://github.com/vLannaAi/noy-db/issues/57)) — recursive partial with `| null` at every level.
- **`SlotRewrapContext`** + **`SlotRewrapCeremony`** ([#56](https://github.com/vLannaAi/noy-db/issues/56)) — previously package-internal, now public so `@noy-db/on-webauthn` (and future on-* packages) can type their `slotCeremonies` helpers without re-declaring the shapes.

#### Policy DSL extensions

- **`update-user`** built-in gate ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — PERSONAL: `{ minTier: 1 }`; STRICT: `{ minTier: 1, factors: [{ anyOf: ['totp', 'email-otp'] }] }`.
- **`update-authenticator`** built-in gate ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — symmetric with `enroll-authenticator` / `remove-authenticator`. STRICT requires TOTP/email-OTP because a malicious slot rename on a shared workstation can mislead the user about which device a slot corresponds to.

### Issues closed

#54, #55, #56 (hub-side type export), #57

## 0.1.0-pre.8

### Authentication surface — major auth-review batch

Closes the 12-issue auth-review filed at the start of this milestone. Driven by feedback from the first production consumer (Niwat); the pre.8 surface is what they need to drop ~250 LOC of vendored workarounds.

#### New public APIs

- **`db.getKeyring(vault)`** ([#28](https://github.com/vLannaAi/noy-db/issues/28)) — public accessor for the live `UnlockedKeyring`. Required by `@noy-db/on-*` ceremonies that need the DEK set (paper-recovery mint, tier-3 PIN enrol, custom on-* primitives). Previously private; consumers reached in via `(db as unknown as ...).getKeyring`.

- **`db.recoverUser(vault, options, factors?)`** ([#33](https://github.com/vLannaAi/noy-db/issues/33), [#34](https://github.com/vLannaAi/noy-db/issues/34)) — atomic peer-recovery primitive. Single `store.put` rewraps a target user's keyring under a fresh temp passphrase. Owner→owner natively allowed (closes #33's hard block on the two-co-owner case); gated by new `peer-recover-user` policy gate (`STRICT_POLICY` requires recovery / TOTP / email-OTP / roaming WebAuthn factor proof). No key rotation, identity preserved, tier-2 slots dropped. Closes the partial-failure window of the previous `revoke + grant` compose-from-primitives pattern.

- **`db.recoverPassphrase` auto-rotates remaining recovery codes** ([#36](https://github.com/vLannaAi/noy-db/issues/36)) — defaults to `rotateRemainingCodes: true`. After a successful paper-recovery, the matched code is burned AND the remaining N-1 entries are replaced with N-1 freshly-minted ones. Returns `{ newCodes: readonly string[] }` for the UI to show once. Optional `codeGenerator` callback overrides the default ULID format; `newCodeCount` controls the mint count.

- **`db.rotatePassphrase` preserves tier-2 slots via per-slot ceremonies** ([#29](https://github.com/vLannaAi/noy-db/issues/29)) — opt-in `slotCeremonies?: { [slotId]: SlotRewrapCeremony }`. Each ceremony receives `{ newKek, newDeks, oldSlot }` and returns `EnrollAuthenticatorOptions` with the same `id` + `method` (anti-slot-swap guard). Slots without a ceremony are dropped (pre-pre.8 behavior preserved as default). `enrolled_at` carries through (rotation is rewrapping, not re-enrollment). Closes the "yearly rotation wipes my biometric" UX cliff.

- **Public `mintPaperRecoveryEntry` / `unwrapDeksFromPaperEntry`** ([#39](https://github.com/vLannaAi/noy-db/issues/39)) — native paper-recovery enrollment path. Consumers were inlining ~70 LOC; `db.enrollRecovery` docstring fixed to point here instead of the broken `@noy-db/on-recovery@<=pre.7` example.

- **`mintWrappedDeksBlob` / `unwrapDeksFromBlob` / `WrappedDeksBlob` interface** ([#44](https://github.com/vLannaAi/noy-db/issues/44)) — the canonical wrap-DEKs primitive used by tier-0 (paper recovery) and tier-2 wrap-DEKs (password). `mintPaperRecoveryEntry` and `enrollPasswordAuthenticator` both delegate to this single helper. Tier-3 (`@noy-db/on-pin`) intentionally uses a parallel implementation at 100k PBKDF2 iterations (vs 600k here) because the PIN protection window is short — wire formats are deliberately incompatible.

#### Breaking type changes (pre-1.0; runtime behavior unchanged)

- **`KeyringAuthenticator` is now a discriminated union** ([#26](https://github.com/vLannaAi/noy-db/issues/26)) — `wrapKind: 'kek' | 'deks'` discriminator. WebAuthn / OIDC slots stay wrap-KEK; password slots are wrap-DEKs. Backward-compat: pre-pre.8 slots without `wrapKind` are treated as wrap-KEK at unlock time.

- **`UnlockedKeyring.kek` tightened to `CryptoKey | null`** ([#41](https://github.com/vLannaAi/noy-db/issues/41)) — the runtime always allowed null (tier-3 PIN resume, wrap-DEKs unlock, session restore, dev-unlock); the type now matches reality. Three call sites (`persistKeyring`, `vault.issueDelegation`, delegation-token unwrap) added explicit null-throws with a "re-authenticate at tier 1 first" message. Consumers reading `keyring.kek` directly should add a null-check.

#### Policy DSL extensions

- **`FactorKind` extended** ([#30](https://github.com/vLannaAi/noy-db/issues/30)) — adds `webauthn-platform` (Touch ID / Face ID / Hello), `password` (`@noy-db/on-password` tier-2), `pin` (`@noy-db/on-pin` tier-3). PERSONAL_POLICY rotate-passphrase gate now accepts ALL kinds; STRICT_POLICY peer-recover-user accepts off-device kinds only.

- **`PassphrasePolicy` escape hatches** ([#31](https://github.com/vLannaAi/noy-db/issues/31)) — `pattern?: RegExp` overrides the default lowercase-letters-and-spaces character class; `customValidator?: (phrase) => PassphraseValidationResult` replaces the entire decision tree. Unblocks Thai/EN-mixed phrases (`/^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u`), digit-rich phrases, BIP-39-style domain-specific formats.

#### Documentation + housekeeping

- **`docs/subsystems/auth-landscape.md`** — reference map of every authentication, unlock, and sealing-key primitive commonly adopted in 2026, scored on dimensions that matter for a zero-knowledge offline-first vault. 247 lines covering 12 dimensional sections plus coverage assessment, gaps table, decision rules, and Q&A appendix.

- **on-oidc README + auth-landscape §6 polish** ([#37](https://github.com/vLannaAi/noy-db/issues/37)) — reframes "self-host the key-connector server" from docstring footnote to top-level ⚠️ section. Closes #37 as wontfix: noy-db is offline-first by philosophy and intentionally does not ship server infrastructure for OIDC unlock; consumers without server infrastructure should use `@noy-db/on-webauthn` (platform passkey) instead.

- **Perf-bench DoD test stabilized** — added `{ retry: 2 }` and renamed from "5×" to "materially faster" (assertion is `> 2`). Handles transient parallel-CI noise without lowering the signal-to-noise ratio.

### Issues closed

#26, #28, #29, #30, #31, #33, #34, #36, #37, #38, #39, #41, #44

### Issues filed as follow-ups

- [#43](https://github.com/vLannaAi/noy-db/issues/43) — fold `@noy-db/on-recovery` into `@noy-db/hub/recovery-codes` subpath (deferred, breaking change)
- Earlier follow-ups (#14 managed-passphrase mode, #15 per-keyring policy override) remain in the post-1.0 backlog.

## 0.1.0-pre.7

### Patch Changes

- fix(hub): onInvalidKey: 'reset' — recover a stale keyring when the data store is partially cleared (#6)

  When the IndexedDB data records are cleared via DevTools (or the user's browser evicts storage) while the `_keyring` row survives, and the user's credentials have since changed (e.g. a WebAuthn PRF credential was rotated or synced to a new device), `openVault` now offers an opt-in recovery path instead of throwing `InvalidKeyError`.

  Set `onInvalidKey: 'reset'` in `createNoydb` options to delete the stale keyring and re-initialize the vault from scratch with the current credentials. Default is `'error'` (unchanged — wrong credentials still throw).

## 0.1.0-pre.6

### Features

- **Per-principal user envelope (`vault.user.*`)** ([#18](https://github.com/vLannaAi/noy-db/issues/18), [#19](https://github.com/vLannaAi/noy-db/issues/19), [#20](https://github.com/vLannaAi/noy-db/issues/20), [#22](https://github.com/vLannaAi/noy-db/issues/22), [#23](https://github.com/vLannaAi/noy-db/issues/23), [#24](https://github.com/vLannaAi/noy-db/issues/24), [#25](https://github.com/vLannaAi/noy-db/issues/25)) — every keyring in a vault now gets its own `_users/<keyringId>` envelope, encrypted under a vault-shared `_users` DEK. Hub owns the plumbing (storage, sync, history, lifecycle, encryption, policy gates); apps own the schema. Three method families on `vault.user.*`:

  - **Write-self** — `me() / updateMe(patch) / setMe(payload)`. Always target the writer's own keyringId; the **own-only write rule is structural** (no API method exists to write someone else's envelope). Gated by `edit-own-profile` (default `minTier: 3`).
  - **Read-anyone** — `get(keyringId) / list()`. Gated by `view-team-profiles` (default `minTier: 2`); `enabled: false` is the privacy-strict opt-out (`list()` returns only self).
  - **Reactive** — `subscribe(keyringId, cb) / live(keyringId)`. In-process event emission on local writes.

  New `db.grant({ initialProfile: T })` admin pre-fill at invite time (bootstrap-only — once the user activates, the own-only rule prevents further admin edits). New `listUsersWithEnvelopes()` joined enumeration for admin UIs. `_users` DEK is eager-provisioned at owner creation; cascade-revoke deletes envelopes alongside keyrings; tier-1 rotation re-encrypts envelopes via the existing rotation path. The `UserProfileProvider` interface (managed-mode IdP integration) is documented but not exported in v1; lands post-1.0 alongside managed-passphrase mode (#14).

  See `docs/subsystems/user-envelope.md`, `docs/recipes/user-preferences.md`, `showcases/src/70-user-envelope.showcase.test.ts`, and `showcases/src/recipe-user-preferences.recipe.test.ts`.

- **`db.enrollWebAuthn(vault, ceremony, presented?)`** ([#16](https://github.com/vLannaAi/noy-db/issues/16)) — native WebAuthn enrollment using the **real** internal keyring. Unblocks `vLannaAi/niwat#31`. The ceremony callback receives the live `UnlockedKeyring` so the `wrapped_kek` references the live KEK (not the synthetic-keyring workaround that broke unlock). Hub does not import `@noy-db/on-webauthn` (would invert dep graph); consumers wire the on-webauthn `enrollWebAuthn` function in via the ceremony callback. Companion `db.listWebAuthnSlots(vault)` returns webauthn-method slots only.

- **`db.lockVault(vault)`** ([#17](https://github.com/vLannaAi/noy-db/issues/17)) — soft lock that scrubs `keyringCache`, `vaultCache`, `activeTier`, `syncEngines`, `policyEnforcers` for the vault, but **preserves `quickUnlock`** (PIN resume after lock-screen UX) and `policyCache` (on-disk policy survives lock). Idempotent; the `Noydb` instance remains usable. Unblocks `vLannaAi/niwat#33`.

- **New built-in policy gates** — `edit-own-profile` and `view-team-profiles` registered in `PERSONAL_POLICY` and `STRICT_POLICY`. Apps can tighten (e.g. require TOTP for profile edits) but cannot relax the own-only write rule (structural, not policy-controlled).

### No breaking changes

All additions are additive. Pre-existing vaults work unchanged — the `_users` collection is reserved on grant; envelopes start empty until first `updateMe()`. Pre-existing vaults predating this feature have a documented one-time DEK-rotate workflow when adopting `vault.user.*` for multi-principal reads (see "Edge cases & limits" in `docs/subsystems/user-envelope.md`).

## 0.1.0-pre.4

### Features

- **`NoydbOptions.getKeyring` callback** ([#5](https://github.com/vLannaAi/noy-db/issues/5)) — added an optional `getKeyring?: (vault: string) => Promise<UnlockedKeyring>` callback to `NoydbOptions`. Lets biometric (WebAuthn), OIDC split-key, Shamir, and any other unlock path that produces an `UnlockedKeyring` plug into `createNoydb` directly, without a passphrase bridge. `secret` and `getKeyring` are mutually exclusive; the callback is invoked lazily on the first vault open and the keyring is cached per `(instance, vault)`. Errors propagate from `openVault(name)`. Full backward compatibility — passphrase consumers see no change.

## 0.1.0-pre.1 — Initial pre-release
