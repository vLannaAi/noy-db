# Hub `src/` reorganization — `with-*` dimension folders

> **Status:** design, for review (2026-06-30). Reconstructed from the original brainstorm + the verified prototype commit `f6127e62` ("refactor(hub): group optional subsystems into 7 dimension folders", on `feat/family-folders`, gate-green when committed). That prototype used bare folder names (`lookup/`); this spec finalizes the naming as a `with-` prefix and re-derives the move on current `main`. Pairs with the edge-crypto kernel-optimization spec (`2026-06-30-edge-crypto-kernel-optimization-design.md`); the two are independent but reference the same folder layout.

## Problem

`packages/hub/src/` is **flat** — ~45 sibling folders + ~20 top-level files, with no structural signal separating the always-on **kernel** from the opt-in, tree-shakeable **subsystems**. `SUBSYSTEMS.md` declares "a minimalist core + 24 opt-in subsystems," but the source layout doesn't show it: `crypto.ts` (core) and `materialized-views/` (a 1,600-LOC optional subsystem) sit at the same level. A new reader can't see the trust boundary or the core/optional split by looking at the tree, and the catalog's central claim isn't reflected in the code's shape.

## Goal

Group the optional subsystems into **7 dimension folders**, each prefixed `with-`, leaving the kernel + plumbing at `src/` top level. Make the catalog's core/optional split **visible in the filesystem**, with **zero change to the public API** (subpath exports and `dist/` layout stay byte-identical).

## Design

### The 7 dimension folders

Each folder is a **dimension of capability the kernel deliberately lacks** — a coherent group of subsystems a developer opts into.

| folder | the power it adds | subsystems inside |
|---|---|---|
| `with-lookup/` | find by content, not id | aggregate · embeddings · indexing · search |
| `with-commit/` | safe, recorded, ordered change | crdt · history · numbering · sequence · tx |
| `with-formula/` | spreadsheet-style derived data | computed · derivations · materialized-views · overlay-views |
| `with-shape/` | how data is typed & formed | blobs · i18n · introspection · links · money · persisted-schemas · schema-update |
| `with-audit/` | provable history of truth | attestation · consent · forget · guards · periods · sealed-record |
| `with-fork/` | copies that leave the timeline | archive · bundle · shadow · snapshots |
| `with-party/` | many principals, one vault | auth-introspection · custody · directory · session · sync · team |

**36 subsystems** across 7 dimensions. (The catalog headline of "24 subsystems" counts developer-facing *features*; several share a source folder or split into eager/lazy arms, so the folder count is higher. The reorg does not change the catalog count — only where the source lives.)

### What stays at `src/` top level — the kernel + plumbing

What a developer must read to trust the core:

- **dirs:** `kernel/` · `query/` · `meta/` · `record-keys/` (kernel-side crypto/CEK) · `adapter/` · `store/` · `cache/` · `coordination/` · `policy/` · `util/`
- **files:** `collection.ts` · `vault.ts` · `noydb.ts` · `crypto.ts` · `schema.ts` · `refs.ts` · `types.ts` · `errors.ts` · `events.ts` · `validation.ts` · `subsystem-bus.ts` · `write-hooks.ts` · `write-queue.ts` · `debug.ts` · `env-check.ts` · `constants.ts` · `index.ts` · `vault-diff.ts` · `tab-coordination.ts` · `tab-write-relay.ts` (~20)

> The **reorg-readiness inventory** (overnight review) re-validates this mapping against current `main` and flags any folder added since `f6127e62` (e.g., #306 work) that needs a target. Treat the inventory's output as the authoritative file list for the plan.

### Naming rationale — why `with-`

1. **The prefix mirrors the opt-in API.** Every subsystem is enabled by a `with<Name>()` strategy factory passed to `createNoydb(...)`. A folder named `with-lookup/` holds exactly the things you turn on with a `with…()` call — the layout *teaches* the mental model instead of just storing files.
2. **It extends the family's grammar inward.** The whole product is built on prefix grammar — `to-`, `in-`, `on-`, `as-`, `by-`, `at-` for the satellite packages (CLAUDE.md: "the central mental model for the whole family"). `with-*` applies the same convention to hub-internal optional subsystems — one consistent naming story, outside and inside.
3. **Flat but grouped, minimal churn.** A prefix keeps today's directory depth (one segment, like the `f6127e62` prototype) so it does **not** deepen every import path or re-trigger the codemod over `tsconfig` `extends` depths. All `with-*` folders sort together in the tree, giving the visual grouping of a wrapper without the path cost of a nested `subsystems/` level. (Alternatives considered: nested `subsystems/` — most self-documenting but deeper paths; `ext-`/`opt-` — fine but don't connect to the API. `with-` was chosen for the API mirror.)

### The invariant: invisible to consumers

The reorg moves **source paths only**. It must preserve, byte-for-byte:

- **All 28 `package.json` `exports` subpath targets.** `@noy-db/hub/indexing`, `@noy-db/hub/aggregate`, etc. resolve to the same built output. The export *keys* are per-subsystem, not per-dimension, so they never reference a dimension folder name.
- **The `dist/` top-level layout stays flat** — no `dist/with-lookup/`. The `tsup` multi-entry config names entry *keys* (`indexing`, `aggregate`, …); only the entry *source paths* change (`src/indexing/index.ts` → `src/with-lookup/indexing/index.ts`).
- **The `kernel-surface` ratchet is untouched** — `collection.ts`/`vault.ts` do not move and are not decomposed here.

This is the same property `f6127e62` verified: typecheck ✓ · build ✓ · full test suite ✓ · `check:architecture` ✓, with every subpath present and `dist/` unchanged.

## Non-goals (explicitly out of scope)

- **No file renames** beyond the dimension-folder move. Subsystem folder names (`indexing`, `materialized-views`) are preserved *inside* their dimension.
- **No `collection.ts`/`vault.ts` decomposition.** Kernel-surface reduction is the edge-crypto spec's concern + a separate refactor; this spec only relocates optional subsystems.
- **No `exports`/subpath restructure.** The public surface is frozen.
- **No behavior change.** Pure source relocation + import rewrite.

## Risks & landmines (from the prototype run)

- **R1 — `git mv` under zsh word-splitting.** The first prototype `git mv` loop fired once on a space/word-split list and mis-placed `auth-introspection`. The plan must use a split-safe loop (explicit array / `while read`) and verify with a post-move inventory diff.
- **R2 — test imports need a second codemod pass.** The src-only import rewrite missed `__tests__` files importing via `../src/<subsystem>/` (438 refs across 224 files in the prototype). The plan runs the codemod over **both** `src/` and `__tests__/`, verified by typecheck (the `.test.ts` ratchet now compile-checks every test file, so a missed import fails the gate — a safety net the prototype didn't have).
- **R3 — cross-dimension imports.** Subsystems that import siblings now in a different dimension (e.g. `materialized-views` → `derivations`, both `with-formula` — fine; but `guards` (`with-audit`) → `history` (`with-commit`) crosses dimensions) must have those imports rewritten to `../with-X/...`. The reorg-readiness inventory enumerates these.
- **R4 — staleness.** `f6127e62` is 21 commits behind `main` and conflicts; do **not** rebase it. Re-derive the move on current `main` from the mapping. Commit into a worktree immediately so the work is durable (the prior attempt was lost as uncommitted worktree state).

## Verification

All gates from `/Users/vicio/lanna-db/noy-db`, after the move:
`pnpm --filter @noy-db/hub typecheck` (src + `.test.ts` ratchet) · `pnpm --filter @noy-db/hub build` · `pnpm --filter @noy-db/hub test` (expect the same count as pre-move) · `node scripts/check-architecture.mjs` · a `dist/` + `exports`-targets diff proving byte-identical public output.

## Relationship to the edge-crypto spec

Independent but complementary. This spec relocates the **optional** subsystems; the edge-crypto spec reshapes the **kernel/plumbing** at top level (`store/`, `cache/`, dissolving `to-memory`). Doing the reorg **first** gives the edge-crypto work a clean top-level kernel surface to operate on. Neither blocks the other; if sequenced, reorg → edge-crypto.
