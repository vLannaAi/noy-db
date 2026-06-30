# Surfaces & Contracts Map — the four outbound seams of `@noy-db/hub`

> Phase 3 analysis (READ-ONLY) of the microkernel refactoring. North-star:
> `noy-db/docs/superpowers/specs/2026-06-30-target-architecture-north-star.md` (the
> "Surfaces & contracts" layer — "the exchange layer is where cross-framework coupling
> is allowed to live, and *only* there"). Goal: make each cross-framework coupling an
> explicit, documented, versioned seam, and the ONLY place coupling crosses a repo boundary.

Repos (siblings under `/Users/vicio/lanna-db/`): `noy-db` (hub core), `klum-db`,
`noy-db-to`, `noy-db-ui`, `noy-db-docs`. Hub version line: `0.2.0-pre.31`.

---

## Cross-cutting finding (applies to all four)

**No seam has a golden/surface-snapshot test.** The kernel and adapter index files both carry
JSDoc that says "additive changes only; removals are breaking" — but that intent is enforced by
**nothing mechanical**. The `kernel-surface` guard is a *line-count ratchet on `collection.ts` /
`vault.ts` / `noydb.ts`* (it keeps the kernel lean), **not** a freeze of `kernel/index.ts`'s export
list. There is no test that diffs the exported symbol set of `/kernel` or `/adapter` against a
checked-in baseline. Precedent exists in the family: `nit-db` freezes `packages/hub/noy-surface.json`
via `parity.test.ts`. Adopting that pattern for `/kernel` + `/adapter` (+ a future `/describe`) is the
single highest-leverage Phase-3 mechanism to make "additive-only" load-bearing.

---

## Contract 1 — `@noy-db/hub/kernel` → klum-db

### (a) Current surface — `noy-db/packages/hub/src/kernel/index.ts`
A deliberate, hand-curated seam (named re-exports only, JSDoc declares it a contract — "additive
changes only; removals are breaking"). Exports:

- **Runtime helpers (6):** `readPath`, `reduceRecords`, `groupAndReduce`, `generateULID`, `sha256Hex`,
  plus the #469 coordination port `isQuorum` / `runDrainBarrier` and the #308 `fuseRetrieval`.
- **Error classes (8):** `CrossShardJoinError`, `DataResidencyError`, `NoAccessError`,
  `ReservedVaultNameError`, `ShardProvisioningError`, `UnknownShardError`, `ValidationError`,
  `VaultTemplateNotFoundError`.
- **Types only (~16):** `CollectionMeta`, `VaultMeta`, `ChangeEvent`, `Vault`, `Collection`, `Noydb`,
  `Operator`, `Query`, `JoinStrategy`, `LiveQuery`, `AggregateResult`, `AggregateSpec`,
  `LiveAggregation`, `IndexDef`, `FuseOptions`, `RetrieveHit`, `RetrieveOptions`, coordination types
  (`CoordinationProvider`, `WriterPresence`, `FenceState`, `DrainBarrierOptions`).
- **Documented caveat in the file:** `Vault`/`Collection`/`Noydb`/`Query` are runtime classes in hub
  but re-exported here as **types** — `instanceof` won't work through `/kernel`; consumers needing the
  runtime value import from `@noy-db/hub` directly. (This caveat is itself the seed of the leak below.)

### (b) Consumer + binding
`@klum-db/lobby` (single package). `@noy-db/hub` is a **peerDependency** `^0.2.0-pre.29`
(`klum-db/package.json:52`) + an exact devDependency pin `0.2.0-pre.30` for tests; required (not in
`peerDependenciesMeta.optional`). 14 source files import from `/kernel` — the full de-duplicated set
klum consumes: helpers `generateULID, sha256Hex, readPath, fuseRetrieval, reduceRecords,
groupAndReduce`; all 8 error classes; types `Vault, Collection, VaultMeta, Noydb, Query, Operator,
IndexDef, JoinStrategy, RetrieveHit, LiveQuery, LiveAggregation, ChangeEvent, AggregateResult,
AggregateSpec`. `klum-db/CLAUDE.md` documents `/kernel` as the binding contract in two sections.

### (c) Versioning / guards
- **`no-outbound-klum-import`** (noy-db `check-architecture.mjs` Check 8): enforces the ONE-WAY law —
  no `@noy-db/*` package may `import`/`export … from '@klum-db/…'` (static or dynamic). Protects the
  *direction*.
- **`kernel-surface`** (Check 6): line ceiling on `collection.ts`/`vault.ts`/`noydb.ts` — keeps the
  kernel lean; **does not** freeze `kernel/index.ts`'s exports.
- Peer-dep **range** model (`^0.2.0-pre.29`) means a noy-db release only forces klum action when the
  caret floor is crossed.

### (d) Gaps / risks
1. **The seam is NOT exclusive — klum binds three hub surfaces.** Despite klum-db CLAUDE.md's strict
   "binds **only** to `@noy-db/hub/kernel`," the code also imports from:
   - **the bare `@noy-db/hub` root barrel** — `Vault` (type), `STATE_VAULT_NAME`, `diffVault`, custody
     API (`CustodyApi`, `liberateVault`, `createDeedOwner`, `loadDeedMarker`, `isDeedVault`,
     `DeedMarker`, `LiberateOptions`, `LiberateResult`, `GrantCustodianOptions`), and devtools-ish
     types (`WriteHook`, `WriteConflict`, `WriteQueue`, `Unsubscribe`, `AccessibleVault`,
     `SealingKeyProvider`). Files: `src/index.ts`, `interchange/*.ts`, `dock/graduate.ts`,
     `federation/{constants,group-inspector}.ts`.
   - **`@noy-db/hub/bundle`** — `extractPartition`, `decryptExtractedPartition`, `DecryptedRecord`,
     used across `interchange/*` + `bundle/multi-bundle.ts` + `dock/graduate.ts`.
   `Vault` is imported inconsistently from all three of `/kernel`, root, and `/bundle` across files.
   klum-db CLAUDE.md's "Separation" section partly admits this ("`/kernel` and `/bundle`"), directly
   contradicting its own "only `/kernel`" claim. **The real coupling surface is `/kernel` + `/bundle`
   + the root barrel.** This is the largest seam-leak in the four contracts.
2. **No surface-freeze test** — additive-only is JSDoc prose, not enforced (see cross-cutting finding).
3. **Stale doc floors** — klum-db CLAUDE.md cites peer floors `^0.2.0-pre.24` / `^0.2.0-pre.26`; the
   actual manifest floor is `^0.2.0-pre.29`. Documentation drift in the contract description.

### (e) Recommendation (make first-class)
- **Decide the seam's true shape and make it match reality.** Either (i) *widen the documented contract*
  to "`/kernel` + `/bundle`" and migrate the root-barrel symbols klum legitimately needs (custody API,
  `diffVault`, `STATE_VAULT_NAME`, the write-hook types) into `/kernel` (or a new `/orchestration`
  subpath); or (ii) keep `/kernel` narrow but explicitly bless `/bundle` as a second orchestration
  seam. Pick one; eliminate the bare-root-barrel imports either way.
- **Add a golden surface test** (`kernel-surface.json` + a `parity`-style test) freezing the export
  list → makes "additive-only" enforceable.
- **Add a guard** (mirror of `adapter-only`) that scans klum-db `src/` and allows hub imports **only**
  from the blessed subpaths — turning the "only /kernel" prose into a mechanical check. (Lives in
  klum-db's repo, the consumer side, like noy-db-to's `adapter-only`.)
- Fix the stale version floors in klum-db CLAUDE.md.

---

## Contract 2 — `@noy-db/hub/adapter` → noy-db-to

### (a) Current surface — `noy-db/packages/hub/src/adapter/index.ts`
The ciphertext-facing slice. Named re-exports only (JSDoc: "Mirrors the `/kernel` seam… additive").
- **Types (8):** `NoydbStore`, `NoydbBundleStore`, `EncryptedEnvelope`, `VaultSnapshot`, `TxOp`,
  `StoreCapabilities`, `StoreTime`, `ListPageResult`.
- **Error classes (4):** `ConflictError`, `NetworkError`, `StoreCapabilityError`,
  `BundleVersionConflictError`.

### (b) Consumer + binding
The 16 extended `to-*` stores in `noy-db-to` (aws-s3, aws-dynamo, postgres, mysql, sqlite, turso,
supabase, cloudflare-d1/r2, smb, ssh, webdav, nfs, drive, icloud, browser-local). Each store's `src/`
imports **only** through `@noy-db/hub/adapter` — record stores pull `NoydbStore, EncryptedEnvelope,
VaultSnapshot, TxOp, ListPageResult` + `ConflictError`; bundle stores (drive, icloud, s3-bundle) pull
`NoydbBundleStore` + `BundleVersionConflictError`. `@noy-db/hub` is a **peerDependency** at a published
caret range (`^0.2.0-pre.31`), mirrored in devDependencies for tests; never `workspace:*`, never in
`dependencies`.

### (c) Versioning / guards — `noy-db-to/scripts/check-architecture.mjs` (3 rules)
- **`hub-peer-range`**: `@noy-db/hub` must be a `peerDependency` declared as a real semver RANGE.
  Fails if present in `dependencies`, missing from `peerDependencies`, value `startsWith('workspace:')`,
  or fails `/^[\^~]?\d/`. Does not pin one string — any caret/tilde/bare range passes.
- **`adapter-only`**: walks each store `src/` (`.ts`, skipping `.d.ts`/`dist`/`node_modules`); regex
  matches static `import`/`from`, dynamic `import()`, `require()`, bare side-effect imports of
  `@noy-db/hub(/…)`. Any captured subpath that is **not exactly `/adapter`** fails — including the bare
  barrel.
- **`no-crypto-deps`**: bans `crypto-js, node-forge, tweetnacl, bcryptjs, bcrypt` and any `@noble/*` /
  `@scure/*` across all dep sections (stores see ciphertext only).
Plus noy-db side enforces direction via `no-outbound-klum-import` (any `@noy-db` pkg, incl. would-be
edge adapters). noy-db-to CLAUDE.md documents the seam ("ONE WAY, via the published seam").

### (d) Gaps / risks
- **Cleanest of the four.** No production `src/` code imports outside `/adapter`. The only non-`/adapter`
  hub imports are in **test files** (bare barrel — the guard only scans `src/`), doc-comment prose, and
  built `dist/*.d.ts` (which correctly re-import `/adapter`). Not a shipping leak.
- **Same surface-freeze gap** as `/kernel`: no golden test on the hub side freezing the adapter export
  list; "additive-only" is JSDoc only.
- Contract is otherwise complete + stable; the peer-range model is the family template.

### (e) Recommendation
- **Doc-only + one test.** This seam is already first-class on the consumer side (3 mechanical guards
  in the consumer repo). The only addition needed: a **golden surface test on the hub side** freezing
  `/adapter`'s export list (pair with the `/kernel` one). Treat this contract as the **reference model**
  the other three should converge toward.

---

## Contract 3 — `collection.describe()` + `--nui-*` design tokens → noy-db-ui

### (a) Current surface
Two *distinct* things the north-star bundles together — and only one is actually a hub seam:

**describe() (a real hub→ui contract):** `collection.describe()` (sync) /
`collection.describe(opts)` (async) → `CollectionDescription { collection, fields: DescribedField[],
meta: CollectionMeta }`. Defined in `hub/src/with-shape/introspection/describe.ts`. `DescribedField` is
a rich per-field shape: `key, type, optional, constraints?, label, description?, semanticType?, unit?,
sensitivity?, aggregate?, aliases?, ref?, displayFor?, money?, dict?, computed?, i18n?, widget,
editable`. **Exported from the main `@noy-db/hub` barrel** (`hub/src/index.ts:200`:
`CollectionDescription, DescribedField, DescribeOptions`) — there is **NO dedicated subpath**. (A
separate, older introspection surface, `Vault.dumpSchema()` → `VaultSchemaSnapshot` from
`with-shape/introspection/index.ts`, feeds the `noydb describe` CLI — not what ui consumes.)

**`--nui-*` tokens (NOT a hub contract):** the design tokens live in **`@noy-db/ui` itself**
(`noy-db-ui/packages/ui/src/style/tokens.css`, 8 base tokens + a dark set), exported as
`@noy-db/ui/tokens.css`. The hub has no `--nui-*` anything. So this half of the north-star "contract"
is **internal to noy-db-ui**, not an outbound hub seam at all — a correction to the framing.

### (b) Consumer + binding
`@noy-db/ui` (framework-agnostic) + `@noy-db/ui-nuxt`. `@noy-db/hub` is a declared **peerDependency**
`^0.2.0-pre.30` in both `packages/ui` and `packages/ui-nuxt`. The seam is a **nominal shared type
import**: `import type { DescribedField } from '@noy-db/hub'` in `schema-from-describe.ts`, `detail.ts`,
`form.ts`, and the Nuxt `RecordDetail.vue` / `RecordForm.vue`. The UI calls `collection.describe().fields`
and passes the `DescribedField[]` into `schemaFromDescribe(name, described, …)`. Note: it imports the
**element type `DescribedField`**, never the `CollectionDescription` wrapper (that name appears nowhere
in ui) — the `.fields` envelope is consumed structurally/positionally. `packages/ui/src/core.test.ts`
is a real end-to-end seam test: it spins up a live hub vault (`createNoydb({ store: memory() })`) and
feeds **actual** `describe().fields` into the engine.

### (c) Versioning / guards
- describe() type contract: enforced only by **TypeScript typecheck** against the pinned `^0.2.0-pre.30`
  peer + the ui-side `core.test.ts` integration test. **No architecture guard, no subpath, no golden
  snapshot.**
- tokens: **no machine-checkable manifest** — just the `--nui-*` list in `tokens.css` +
  `docs/ui/4.design-tokens.md`.

### (d) Gaps / risks
- **Better than the "implicit/duplicated" hypothesis** (the type is shared nominally + hub is a declared
  peer), **but still the weakest of the three live code seams:**
  1. **No dedicated subpath** — ui binds the **entire root barrel** of `@noy-db/hub` just to get one
     type (`DescribedField`). The describe() output contract is not isolated; it rides the giant `.`
     export. A breaking change anywhere in the barrel's *type graph* can ripple.
  2. **No guard** verifying the describe()↔ui contract (vs `/adapter`'s 3 guards). Drift is caught only
     by the consumer's own typecheck/test, never on the producer side.
  3. **The `CollectionDescription` envelope is consumed structurally** (`.fields`), so a change to the
     wrapper shape (e.g. renaming `fields`) is invisible to the shared-type check.
  4. **Tokens are mis-attributed in the north-star** — they're ui-owned, not a hub seam; the "contract"
     there is a doc-only convention internal to ui.
- Output stability: describe() has grown organically (money/dict/i18n/computed/ref/widget/editable
  blocks added incrementally per issue #). No versioned "describe output contract" doc exists.

### (e) Recommendation (this is the **primary Phase-3 formalization target**)
- **Add a dedicated hub subpath** `@noy-db/hub/describe` (or reuse/rename `/introspection`) that
  re-exports `CollectionDescription`, `DescribedField`, `DescribeOptions`, `CollectionMeta`,
  `FieldMeta`, `SemanticType` — so ui binds a **narrow seam, not the root barrel**. Mirrors `/adapter`.
- **Document the `CollectionDescription` output as a versioned contract** (a doc page enumerating every
  `DescribedField` field + the widget/semanticType derivation table — most of this already exists in
  `noy-db-ui/docs/ui/2.schema-driven.md`, but it should be owned/versioned on the **hub** side).
- **Add a golden snapshot test** of `describe()` output for a representative schema (producer-side
  parity), so the output shape can't drift silently.
- **Optionally a consumer-side `adapter-only`-style guard** in noy-db-ui restricting hub imports to the
  `/describe` subpath.
- **Tokens:** explicitly document that `--nui-*` are **ui-owned**, not a hub contract; if a token
  contract is wanted it's a **doc-only manifest in noy-db-ui** (list + override rules), not a hub seam.
  This de-scopes half of the north-star's "contract 3" to a doc note.

---

## Contract 4 — published `@noy-db/*` package surface → noy-db-docs

### (a) Current "surface"
Not a code seam — the **published npm packages** (`@noy-db/hub` + the satellites) consumed at peer
ranges, plus the **docs-source mapping** (the `doc-sync.md` runbook: which repo/file feeds which of the
5 content partitions — core, adapters, ui, subsystems, demos). Ref:
`noy-db/docs/superpowers/reviews/2026-06-30-noy-db-docs-extraction.md`.

### (b) Consumer + binding
`noy-db-docs` (a Nuxt 4 + Content v3 site, scaffolded, ~90% designed / ~10% populated). Root
`package.json` is `private`, `0.0.0`, "Consumes published `@noy-db/*` — publishes nothing." Binds the
**same model** as klum/to/ui: published packages at **ranged peerDependencies** (`^0.2.x`), never
`workspace:*`. Two channels (`latest`/`next`) mirror npm dist-tags; `docs.manifest.json` records the
per-channel/per-partition last-synced family version → idempotent re-sync. Moved runnable assets
(showcases/recipes/playground) convert `workspace:*` → peer ranges on the way out.

### (c) Versioning / guards
- The peer-range + dist-tag-channel model **is** the versioning. **No architecture guard, and none is
  warranted** — it's a consumption-only, one-way relationship (docs depend on noy; noy never imports
  docs). The natural "docs lag noy-db `main` by a release" is a feature (the `latest`/`next` split).

### (d) Gaps / risks (light — the loosest seam)
- **Source-of-truth ambiguity (the single open question):** after `docs/` physically leaves noy-db,
  what is canonical for the `core` + `subsystems` partitions? The runbook says they're *generated from*
  noy-db's `docs/core/*`, `docs/subsystems/*`, `SPEC.md`, `SUBSYSTEMS.md` — but the migration note says
  `docs/` *moves out*. Both can't hold. Must be resolved before files move (options (a) docs stay as
  source / (b) docs repo becomes canonical home).
- **Stale gate pointer:** the migration gate points at PR #498, which is actually the family-folder
  reorg, not a doc-extraction PR. Re-point it.
- **Link rot:** ~100+ relative `../../` links break on move (needs a link-check gate).
- `docs/superpowers/` (4 MB internal SDD specs) must be **deliberately excluded** from the public site.

### (e) Recommendation
- **Doc-only / process.** Keep the published-peer-range consumption model (it's correct and matches the
  family). Phase-3 actions are all documentation/decision, no code seam: (1) resolve the
  source-of-truth question; (2) re-point the stale gate; (3) add a link-check gate at sync time;
  (4) explicitly exclude `docs/superpowers/`. No subpath, no guard needed.

---

## Summary table

| # | Contract (surface → consumer) | Surface kind | Hub dep / range | Guarded? | Seam leak? | Biggest gap |
|---|---|---|---|---|---|---|
| 1 | `@noy-db/hub/kernel` → klum-db | curated subpath (6 helpers + 8 errors + ~16 types) | peer `^0.2.0-pre.29` | **Partial** — `no-outbound-klum-import` (direction) + `kernel-surface` (leanness, not export-freeze) | **Yes** — also binds root barrel + `/bundle` | seam is not exclusive; no surface-freeze test |
| 2 | `@noy-db/hub/adapter` → noy-db-to | curated subpath (8 types + 4 errors) | peer `^0.2.0-pre.31` | **Yes** — consumer-side `hub-peer-range` / `adapter-only` / `no-crypto-deps` | No (shipping) | no producer-side surface-freeze test |
| 3 | `collection.describe()` (`CollectionDescription`/`DescribedField`) → noy-db-ui; `--nui-*` tokens | **root-barrel type** (no subpath); tokens ui-owned | peer `^0.2.0-pre.30` | **No** — typecheck + 1 ui test only | partial — binds whole root barrel for 1 type | **no subpath, no guard, no output contract** (tokens aren't even a hub seam) |
| 4 | published `@noy-db/*` → noy-db-docs | published packages + doc-source map | peer `^0.2.x` | No (n/a — consume-only) | No | source-of-truth ambiguity + stale gate (doc-only) |

### Which existing guards enforce which contract
- **`no-outbound-klum-import`** → Contract 1 (and structurally protects all — bans any `@noy-db`→`@klum-db` import).
- **`kernel-surface`** (line ratchet) → keeps Contract 1's *producer* lean; does **not** freeze the kernel export list.
- **`peer-deps`** (noy-db Check 1) → governs *in-repo* satellites (`workspace:*`); klum/to/ui/docs use *published ranges* instead, so this check doesn't cover them.
- **`hub-peer-range` + `adapter-only` + `no-crypto-deps`** (noy-db-to's own script) → Contract 2.
- **NO guard:** Contract 3 (ui describe/tokens — the gap), Contract 4 (docs — acceptable, consume-only).
- **NO guard for ANY contract:** export-surface additive-only (no golden/snapshot test on hub side for `/kernel` or `/adapter`).

---

## Prioritized Phase-3 formalization plan

**Tier 1 — needs a subpath + guard + doc (the real gap): Contract 3 (ui)**
1. Add `@noy-db/hub/describe` subpath re-exporting the describe()-output types (stop ui binding the root barrel).
2. Author the `CollectionDescription` **output contract doc** on the hub side (versioned), absorbing the existing ui mapping table.
3. Add a producer-side **golden snapshot test** of `describe()` output.
4. (Optional) consumer-side import-restriction guard in noy-db-ui.
5. Re-classify `--nui-*` tokens as **ui-owned**; document as a doc-only token manifest in noy-db-ui (de-scope from the hub-seam framing).

**Tier 2 — needs a decision + guard + test (the seam-leak): Contract 1 (kernel)**
6. Resolve the true seam shape: migrate klum's root-barrel/`/bundle` symbols into `/kernel` (or bless `/kernel` + `/bundle` as the documented pair) and kill the bare-root-barrel imports.
7. Add a consumer-side `adapter-only`-style guard in klum-db (hub imports only from blessed subpaths).
8. Fix stale peer-floor docs in klum-db CLAUDE.md.

**Tier 3 — needs one test (already first-class): Contract 2 (adapter)**
9. Add the producer-side **golden surface-freeze test** for `/adapter` (pair it with one for `/kernel`) — the one cross-cutting mechanism that makes "additive-only" enforceable for both curated subpaths.

**Tier 4 — doc-only / process: Contract 4 (docs)**
10. Resolve the source-of-truth question; re-point the stale #498 gate; add a link-check gate; exclude `docs/superpowers/` from the public site.

**The single highest-leverage item across all four:** the **golden export-surface test** (Tier 3 #9,
reused for `/kernel`), because every curated seam currently claims "additive-only" in prose with zero
enforcement — `nit-db`'s `noy-surface.json` + `parity.test.ts` is the in-family precedent to copy.
