# Sister-framework contracts — the "surfaces & contracts" layer (Phase 3)

> **Status:** design (2026-06-30). Phase 3 of the microkernel refactoring (north-star: `2026-06-30-target-architecture-north-star.md`). Formalizes the layer where cross-framework coupling is *allowed to live, and only there.* Built from the verified contracts map (`docs/superpowers/reviews/2026-06-30-contracts-map.md`). The phase ships the **hub-side** formalization; two items are flagged as owner decisions (cross-repo).

## The four contracts (current state)

| # | Contract (surface → consumer) | Kind | Guarded? | Status |
|---|---|---|---|---|
| 1 | `@noy-db/hub/kernel` → klum-db | curated subpath (6 helpers + 8 errors + ~16 types) | **Partial** (direction + leanness, not the export list) | **Leaks** — klum also binds `/bundle` + the bare root barrel |
| 2 | `@noy-db/hub/adapter` → noy-db-to | curated subpath (8 types + 4 errors) | **Yes** (consumer-side `hub-peer-range`/`adapter-only`/`no-crypto-deps`) | **Reference model** — clean |
| 3 | `collection.describe()` (`CollectionDescription`/`DescribedField`) → noy-db-ui | **root-barrel type** (no subpath) | **No** | **Biggest gap** — ui binds the whole barrel for one type |
| 4 | published `@noy-db/*` → noy-db-docs | published packages + doc-source map | n/a (consume-only) | Fine (doc-only open question) |

**The cross-cutting gap:** *no seam has a golden export-surface test.* Every "additive-only" claim is JSDoc prose with zero enforcement. `nit-db`'s `noy-surface.json` + parity test is the in-family precedent.

## Phase 3 — hub-side formalization (this PR)

1. **Golden export-surface tests** for `/kernel` and `/adapter` (the nit-db pattern): a checked-in baseline of each subpath's exported symbol set + a parity test that fails on drift. Turns "additive-only" into a gate — adding requires updating the baseline (visible, reviewed); removing/renaming fails loudly. *Highest-leverage item; pure test, zero runtime risk.*
2. **Add a `@noy-db/hub/describe` subpath** re-exporting the describe()-output types (`CollectionDescription`, `DescribedField`, `DescribeOptions`, `CollectionMeta`, `FieldMeta`, `SemanticType`) so `@noy-db/ui` can bind a **narrow seam** instead of the root barrel. Additive — existing exports stay byte-identical. + a **golden snapshot test of `describe()` output** for a representative schema so the `CollectionDescription` shape can't drift silently. (The ui-side switch to the new subpath is a noy-db-ui follow-up.)
3. **This spec + the contracts map** become the documented contract reference.

**Re-scoped from the north-star framing:** the `--nui-*` design tokens are **ui-owned** (`@noy-db/ui/tokens.css`), not a hub seam — documented as such, no hub action.

## Owner decisions (flagged — cross-repo, not in this PR)

- **D-C1 — the klum seam shape.** klum-db binds `/kernel` **+ `/bundle` + the bare root barrel** (custody API, `diffVault`, `STATE_VAULT_NAME`, write-hook types), contradicting its "only `/kernel`" doc. Resolve to one of:
  - **(a) widen `/kernel`** to absorb what klum legitimately needs (migrate the root-barrel symbols into `/kernel`, bless `/kernel` + `/bundle` as the documented pair), then klum drops its bare-barrel imports; or
  - **(b) keep `/kernel` narrow**, formally bless `/bundle` as a second orchestration seam, and add a klum-side `adapter-only`-style guard restricting hub imports to those two subpaths.
  Either way: eliminate the bare-root-barrel imports and add a consumer-side guard so the contract is mechanically enforced. *(Recommendation: (a) — one orchestration seam reads cleaner; but it's your call + a klum-db PR.)*
- **D-C4 — docs source-of-truth** (from the noy-db-docs analysis): after `docs/` leaves noy-db, are `docs/core`/`docs/subsystems` the canonical source the site renders from (stay), or does the docs repo become their home (move)? Gates the docs extraction; orthogonal to this PR.

## Success criteria
- `/kernel` and `/adapter` surfaces are frozen by a test (drift fails CI).
- `@noy-db/hub/describe` exists; ui *can* bind it instead of the barrel; describe() output is golden-pinned.
- All four contracts are documented in one place with their guard status honest.
- The two decisions are on the table for the owner.

## Verification
`pnpm --filter @noy-db/hub typecheck` · `build` (the new `/describe` subpath builds; existing `dist/`/`exports` unchanged + the one added entry) · `test` (the new golden + describe-snapshot tests pass; suite count grows by the new tests) · `check-architecture` (kernel-surface unchanged).
