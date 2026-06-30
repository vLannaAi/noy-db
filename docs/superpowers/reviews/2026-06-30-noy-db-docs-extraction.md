# noy-db → noy-db-docs extraction — strategic pre-analysis (READ-ONLY)

Date: 2026-06-30. Scope: map the extraction boundary for pulling docs/help/examples/non-production
collateral out of `/Users/vicio/lanna-db/noy-db/` into the already-scaffolded
`/Users/vicio/lanna-db/noy-db-docs/`. No changes made.

## TL;DR

The destination repo is **not an empty guess — it is a deliberately pre-designed landing zone** with
a written runbook (`docs/doc-sync.md`), a 5-partition content model, a 2-channel (`latest`/`next`)
versioning model, and an idempotent sync-state file (`docs.manifest.json`). The seam decision is
already made (consume **published** `@noy-db/*`, publish nothing). So this is **not** a "design the
target" exercise; it's a "resolve two inconsistencies in the existing plan, then execute the move and
the link rewrites" exercise. The two inconsistencies: (1) the migration gate points at PR #498, but
#498 is actually the family-folder reorg, not a doc-extraction PR; (2) the runbook's source-of-truth
mapping says core/subsystems docs *live in noy-db* while the migration note says docs/ *moves out* —
those can't both hold post-move.

---

## 1. What `noy-db-docs` is today (destination inventory)

A **Nuxt 4 + Nuxt Content v3 + Nuxt UI Pro** documentation site, scaffolded but **content-empty**.
Single commit: `cb71b18 chore: scaffold noy-db-docs — Nuxt 4 + Content v3 + UI Pro docs skeleton`.

- **Stack / consumption:** pnpm workspace, ESM-only, Node ≥22. Root `package.json` is `private`,
  `version 0.0.0`, description: *"Consumes published @noy-db/* — publishes nothing."* The site package
  is `@noy-db-docs/site` at `apps/docs` (Nuxt 4, `@nuxt/content` v3, `@nuxt/ui-pro` v3, image/fonts/icon).
- **Layout:** `apps/docs` (the site, real) · `apps/showcases` (planned stub, README only) ·
  `examples/`, `recipes/`, `templates/`, `packages/` (all **README-only placeholders**) ·
  `scripts/sync/` (a **stub** `sync.mjs` that just prints the runbook outline) · `docs/doc-sync.md`
  (the tracked operating manual) · `docs.manifest.json` (sync state) · `CLAUDE.md` (git-ignored local
  pointer to `docs/doc-sync.md`).
- **Content model — 5 partitions** under `apps/docs/content/` (`1.core/ 2.adapters/ 3.ui/
  4.subsystems/ 5.demos/`). Only `1.core/` has real pages today (`architecture`,
  `encryption-envelope`, `query-dsl`); the rest are `index.md` placeholders.
- **Source-of-truth mapping (per the runbook):** core ← noy-db `@noy-db/hub` README + `docs/core/*` +
  `SPEC.md` + typedoc; adapters ← noy-db 5 essentials + noy-db-to 16 stores + `features.yaml`;
  ui ← noy-db-ui; subsystems ← `SUBSYSTEMS.md` + `features.yaml` + `docs/subsystems/*`;
  demos ← noy-db-docs itself (showcases/examples/recipes), *"until then noy-db/showcases, playground,
  recipes"*.
- **Explicit gate (in CLAUDE.md, README, runbook):** *"Content migration (moving docs/, showcases/,
  playground/, recipes/ out of noy-db) is deferred until noy-db PR #498 lands. This repo is the
  prepared destination + skeleton."*

**Conclusion:** the destination is ~90% designed and ~10% populated. The extraction work is mostly
*moving content in and rewriting links*, not architecting the target.

---

## 2. The "2 releases (latest / next)" model — already decided

The runbook **rejects a multi-version archive** (no `/v1`, `/v2`) pre-1.0. Instead **two channels
mirroring npm dist-tags**:

- `latest` = curated `@latest`; the default site. `next` = in-flight `@next` pre-release.
- Per-page frontmatter declares lineage: `sinceVersion`, `status`
  (`stable|experimental|deprecated|planned`), `channel` (`latest|both|next`), validated by
  `content.config.ts`. Next-only sections carry a `channel: next` badge.
- `docs.manifest.json` records, **per channel and per partition**, the last family version each was
  generated from → makes re-sync idempotent.

**Implication for extraction:** this is **one content tree with channel metadata**, *not* a
snapshot-per-release directory and *not* two npm-version builds. Extraction only has to **seed the
tree once** from current source; the channel layering is applied at sync time by reading
`npm view @noy-db/hub dist-tags` and stamping frontmatter. The sync tooling itself is still a stub —
real automation is also gated on the same (mis-pointed) PR.

---

## 3. The dependency seam — consume PUBLISHED packages (decided, and correct)

The repo's own description and CLAUDE.md fix this: **consume published `@noy-db/*` at peer ranges,
publish nothing** — the same model `klum-db` (binds `@noy-db/hub/kernel`) and `noy-db-to` (binds
`@noy-db/hub/adapter`) already use. **Recommendation: keep this; do not workspace-link.**

Why it's right: docs document *releases*. Examples/showcases/recipes that run against the published
surface prove the docs match what users actually `npm install`. The natural consequence — the docs
repo lags noy-db `main` by a release — is **a feature, not a bug**, and is exactly what the
`latest`/`next` channel split expresses (`@next` carries in-flight features; docs for them sit on the
`next` channel).

**What this forces during the move:** every moved runnable asset currently uses `workspace:*` and must
convert to a **ranged peerDependency** (`^0.2.x`):
- `showcases/` package deps are all `workspace:*` (`@noy-db/hub`, all `in-*`, `as-*`, `by-*` …).
- `recipes/*` packages use `workspace:*` + `peerDependencies: { @noy-db/hub: workspace:* }`.
- `playground/cli` and `playground/nuxt` (`@noy-db/playground-nuxt`) use `workspace:*`.

---

## 4. MOVE / STAYS / AMBIGUOUS — the boundary

### MOVE — pure public docs / examples / help (→ noy-db-docs)

| Source (in noy-db) | Size | Target partition / area | Notes |
|---|---|---|---|
| `docs/core/` (7 files) | 44K | `content/1.core` | conceptual core docs |
| `docs/packages/` (7) | 56K | `content/2.adapters` + cross-fam | `to/in/on/as/by/at` family overviews |
| `docs/subsystems/` (35) | 340K | `content/4.subsystems` | the public subsystem catalog pages |
| `docs/recipes/` (9) | 60K | `content/5.demos` (or recipes) | cookbook prose |
| `docs/glossary/`, `docs/migration/`, `docs/th/` (Thai i18n) | ~40K | core/misc | public reference + localized intro |
| `docs/assets/` (3) | 584K | site `public/` | images/diagrams |
| `recipes/` (runnable: `attestation-verifier`, `aws-kms-pdf-attestation`) | — | `examples/` or `recipes/` | convert `workspace:*`→peer ranges |
| `playground/cli` (the `pnpm demo` tour) | — | `examples/` | update/retire root `pnpm demo` |

### STAYS — production source / tests / config / canonical source-of-truth

| Item | Why it stays |
|---|---|
| `packages/**` (all ~68) | production software |
| `test-harnesses/` (adapter-conformance, benchmarks, simulation-*) | production test infra |
| `scripts/` (release, check-architecture, validate-features, …) | build/release tooling |
| `features.yaml` (130K) | schema-validated production catalog; `validate:features` consumes it; also a doc *source* |
| `turbo.json`, `tsconfig*`, `vitest.config.ts`, `eslint`, `knip.json`, `typedoc.json` | build config |
| `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `MIGRATING.md`, `LICENSE` | per-repo / GitHub conventions; npm shopfront READMEs stay with packages |
| `SPEC.md`, `SUBSYSTEMS.md` | **canonical source-of-truth** the docs site *renders from* — stay in noy-db, surfaced (not forked) in the site (runbook: "READMEs stay in their package repos; this repo links, doesn't fork") |

### AMBIGUOUS — flag with the tradeoff

| Item | Size | Tradeoff / recommendation |
|---|---|---|
| **`docs/superpowers/`** (specs 79, plans 86, reviews; 183 files) | **4.0M** | **The single largest and most mis-handle-prone chunk.** These are *internal design working docs* (SDD specs/plans/reviews), **neither public documentation nor production software**. They map to **no** docs-site partition. The user's phrasing ("everything not production software") would sweep them up, but they don't belong on a public docs site. **Recommend: STAYS in noy-db as internal dev history (or a separate private archive) — explicitly excluded from the published docs site.** Decide deliberately; don't let them ride along by default. |
| **`showcases/`** (`@noy-db/showcases`, 101 `*.showcase.test.ts`, +14 helpers) | — | **Double identity: e2e TEST + literate tutorial.** README calls them "living documentation." Destination README already states the intended split: *"the full literate corpus lives here [docs]; a thin smoke subset stays in noy-db as a real in-repo integration gate."* **Recommend: split, not wholesale move** — corpus → `noy-db-docs/apps/showcases` (peer ranges); keep a smoke subset in noy-db (workspace) as the CI integration gate. They are a workspace package in `pnpm-workspace.yaml` + `turbo` test graph → moving touches both. |
| **`playground/nuxt`** (`@noy-db/playground-nuxt`) | — | Self-describes as *"integration against a real Vue/Pinia consumer"* — a demo **and** an integration test. Same split logic as showcases: demo value → docs; if it's also a real consumer-integration gate, keep a thin version in noy-db. |
| **`ROADMAP.md`** | 28K | Public-facing reading, but also repo planning. Lean **STAYS** (repo-level planning doc); optionally surface a rendered copy in the site. |
| `SPEC.md` / `SUBSYSTEMS.md` | — | Listed under STAYS but inherently doc-shaped; they are *sources* the site renders. The decision hinges on the open question in §6. |

### Headline counts (by content bucket, not file count)

- **MOVE: 8 buckets** (docs/core, docs/packages, docs/subsystems, docs/recipes, docs/{glossary,migration,th}, docs/assets, runnable recipes/, playground/cli)
- **STAYS: 8 buckets** (packages, test-harnesses, scripts, features.yaml, build-config, repo-convention md's, SPEC.md, SUBSYSTEMS.md)
- **AMBIGUOUS: 5 buckets** (docs/superpowers ← biggest, showcases, playground/nuxt, ROADMAP.md, SPEC/SUBSYSTEMS-as-source)

---

## 5. What breaks in the core repo when docs move out

1. **Relative links UP and OUT of `docs/`** — the largest mechanical cost. Grep of `docs/**.md` for
   `](../…)` shows e.g. **34× `../../SUBSYSTEMS.md`, 11× `../../SPEC.md`, ~40× `../../packages/on-*`**
   (on-webauthn/totp/threat/shamir/recovery/pin/oidc/magic-link/email-otp …), plus intra-`docs`
   `../subsystems/…`, `../core/…`, `../recipes/…`. Once `docs/` lives in another repo, every `../../`
   link to a noy-db file breaks → must be rewritten to **absolute GitHub URLs** (for source that
   stays) or to **in-site routes** (for content that moved). Intra-docs links re-map to Nuxt Content
   routes (numeric prefixes stripped: `1.core/index.md` → `/core`).
2. **`pnpm-workspace.yaml`** lists `showcases` (and the workspace globs cover `recipes`, `playground`).
   Removing those packages requires editing the workspace list.
3. **`turbo.json`** test graph — `@noy-db/showcases` participates in `turbo run test`. The
   `pnpm --filter @noy-db/showcases test` flow and the showcase-as-integration-gate disappear unless a
   smoke subset is retained.
4. **Root scripts** — `pnpm demo` runs `playground/cli`; moving it breaks the script (retire or
   repoint).
5. **`typedoc.json`** outputs to `docs/api` and `readme: README.md`. If `docs/` moves, the generated
   API output path needs a decision (it's a build artifact; typedoc itself STAYS as it generates from
   `packages/*/src`). The site can consume typedoc output as the core partition's API reference.
6. **NOT affected:** `features.yaml` stays → `validate:features` unaffected. `check-architecture`
   scans `packages/**` → unaffected by the docs move itself (it just stops seeing the moved
   showcase/recipe/playground packages' `workspace:*` deps).

---

## 6. Risks, sequencing, and the open question

### Is it safe to do AFTER the with-* reorg + edge-crypto? — Yes.

- **Path-disjoint from the reorg.** PR #498 (the family-folder reorg: `packages/<family>/<pkg>`) is
  **CLOSED** and touches `packages/**`. The extraction touches `docs/`, `showcases/`, `playground/`,
  `recipes/` — **almost entirely disjoint paths** → low merge-conflict risk. The one overlap is the
  doc *link rewrites* that reference `../../packages/on-*` (those target paths changed under the
  reorg), so doing extraction **after** the reorg means you rewrite each such link **once**, to its
  final location, rather than twice.
- **No reason to do it early**, with one caveat: the **stale gate** (`doc-sync.md` says "deferred
  until PR #498") is now misleading and should be re-pointed regardless of when the move happens.

### Recommended sequence

1. **Resolve the open question (below)** — pick the post-move source-of-truth policy.
2. **Re-point the gate** in `docs/doc-sync.md` / `noy-db-docs/CLAUDE.md` / README from the (closed,
   mis-identified) "#498" to the real extraction PR.
3. **Move pure public docs** (`docs/core|packages|subsystems|recipes|glossary|migration|th|assets`)
   into `apps/docs/content/*`; rewrite links (GitHub-absolute for stays, site-route for moves).
4. **Split showcases**: corpus → `noy-db-docs/apps/showcases` at peer ranges; retain a smoke subset
   in noy-db as the CI integration gate. Update `pnpm-workspace.yaml` + `turbo.json`.
5. **Move runnable recipes + `playground/cli`** → `noy-db-docs/examples` at peer ranges; retire/repoint
   `pnpm demo`. Decide `playground/nuxt` (demo vs. kept integration gate).
6. **Decide `docs/superpowers/` deliberately** — recommend it stays internal and is excluded from the
   public site.
7. **Clean & verify core repo**: workspace globs, turbo graph, root scripts; `pnpm build/test/
   typecheck/typedoc` + `check:architecture` + `validate:features` all green with the content gone.
8. **Seed the docs site once**, then exercise the channel/sync model (`docs.manifest.json` +
   frontmatter) and replace the `scripts/sync/sync.mjs` stub.

### Risks

- **Link rot (highest-likelihood):** ~100+ relative `../../` links break silently; the site needs a
  link-check gate (the runbook already lists "internal link check" in step 7).
- **Losing the showcase integration gate:** if showcases move wholesale with no smoke subset, noy-db
  loses an e2e safety net and the moved corpus can only test the *published* surface (so it can't gate
  unreleased changes on noy-db `main`). The split mitigates this.
- **Source-of-truth drift:** if `docs/core`/`docs/subsystems` physically leave noy-db but the runbook
  still names them as the canonical source, future syncs have no source to read from (see open
  question).
- **`docs/superpowers` accidentally published:** 4MB of internal SDD specs/plans/reviews swept into a
  public site by an over-broad "everything non-production" rule.

### THE single biggest open question

> **After `docs/` physically leaves noy-db, what is the canonical source-of-truth for the `core` and
> `subsystems` partitions?** The prepared plan is internally contradictory: `doc-sync.md`'s mapping
> table says those partitions are *generated from* noy-db's `docs/core/*`, `docs/subsystems/*`,
> `SPEC.md`, and `SUBSYSTEMS.md` (read-only sources), **but** the migration note says `docs/` *moves
> out of noy-db*. Both cannot hold. Resolve to one of:
> (a) **docs/core & docs/subsystems STAY** as source in noy-db; only `showcases/playground/recipes`
>     move (docs site renders from the staying sources — least churn, matches the runbook as written);
>     or
> (b) **docs/core & docs/subsystems MOVE**; the docs repo becomes their canonical home, and the only
>     remaining in-repo sources are package READMEs + `SPEC.md`/`SUBSYSTEMS.md`/`features.yaml` (matches
>     the user's "all docs leave" intent but requires rewriting the runbook's source mapping).
> This choice determines the entire extraction boundary for the two biggest doc partitions and must be
> made before any files move.
