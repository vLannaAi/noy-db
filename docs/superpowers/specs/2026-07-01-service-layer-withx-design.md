# Service-layer `withX()` design (S4)

> **Status:** design (2026-07-01). The final step of the microkernel reorg: give the
> service layer a **uniform, tree-shakeable opt-in surface**. Follows the canonical
> lexicon (`2026-07-01-noydb-architecture-lexicon.md`) — the `with-*` folders are the
> **service layer**; this spec defines how each service is opted into and tree-shaken.
> The topology reorg (S1–S3, PRs #539–#545) is done; this is S4.

## Problem

The `with-*` services are meant to be **opt-in and tree-shakeable via a `withX()`**, but an
audit shows only ~half have one. The gap isn't laziness — the services fall into **three
archetypes**, and the current `withX()` pattern only fits one:

| Archetype | Nature | Has `withX()` | Examples |
|---|---|---|---|
| **① pipeline strategy** | hooks the write/read pipeline | ✓ | history · crdt · guards · derivations · blobs · snapshots · periods · consent · tx · numbering · materialized-views · overlay-views · aggregate · indexing · shadow · archive · forget · session |
| **② on-demand capability** | methods you *invoke* | ✗ mostly | attestation · tiers · sealed-record · portability · custody · directory · search · sequence · **cargo** · **pod** |
| **③ schema feature** | declared per collection/field | ✗ | computed · money · links · introspection · schema-update |

## Decision — pattern-honest, uniform *feel*, two seams

Do **not** force one shape onto all three. Instead: two opt-in seams, matched to the
archetypes, with one consistent developer-facing story.

### Seam A — `withX()` capability → `createNoydb({ …Strategy: withX() })` (archetypes ① + ②)

① and ② share the **same call shape** — a `withX()` passed to `createNoydb` under a named
`…Strategy` field — while the injected payload differs internally:

- **① pipeline:** `withX()` returns a strategy that hooks the pipeline (unchanged — already the pattern).
- **② on-demand:** `withX()` returns a **capability gate**. Passing it (a) makes the module's
  methods exist on the instance (`vault.issueAttestation()`, `vault.exportPod()`, …) and (b)
  pulls the real impl via dynamic import. Omit it → the methods throw
  `SubsystemNotEnabledError` ("enable it with `withAttestation()` in `createNoydb`") and the
  impl tree-shakes out.

Both use the same `NO_X` no-op stub default and the **existing `strategy-opt-in` architecture
check** (which already requires a `with*()` reference to use a subsystem — ② simply joins that
rule). To a developer, everything instance-level is a `withX()`.

**Consequence (accepted):** archetype-② capabilities that are **always-on today become opt-in**
— calling them without the `withX()` throws. This is a **pre-1.0 breaking change**, chosen for
consistency with the ①-`strategy-opt-in` rule already enforced, and because it's what makes them
genuinely tree-shakeable (out of the floor bundle unless opted in). The error message names the
exact `withX()` to add.

### Seam B — collection-schema declaration (archetype ③)

`computed` · `money` · `links` · `introspection` · `schema-update` are field/collection features,
declared where they live: `db.collection('x', { schema, computed: {…}, money: [...] })`. Their
impl tree-shakes via a **dynamic import triggered by the schema declaration**. They get **no
top-level `withX()`** — the collection *is* their opt-in unit; a global `withX()` would be a fake
abstraction. They are documented as schema-declared features and **exempted from the `withX`
audit** (the `strategy-opt-in` check learns this exemption list).

## Canonical service shape (standardize ① + ②)

Every ①/② service folder converges on the same three files:

- **`strategy.ts`** — the `XStrategy` / `XCapability` type + the `NO_X` no-op stub (stays in the floor bundle; tiny).
- **`active.ts`** — the real `withX(opts)` factory + engine, **dynamically imported** so it's tree-shaken until opted in.
- **`index.ts`** — the barrel + the `@noy-db/hub/<x>` subpath export.

## Scope

- **Fill the ② gaps** — new capability-gate `withX()` for: `withAttestation` · `withTiers` ·
  `withSealedRecord` · `withPortability` · `withCustody` · `withDirectory` · `withSearch` ·
  `withSequence` · `withCargo` · `withPod`. (`embeddings` is the ① write-hook that *feeds*
  `search`'s ② retrieval — they share one `withSearch()`/`withEmbeddings()` pair; resolve during
  planning.)
- **① services** — already conform; a light consistency pass (ensure the three-file shape + a
  `NO_X` stub) only.
- **③ services** — document as schema-declared; verify lazy-import tree-shaking; add their names
  to the `strategy-opt-in` exemption list. No `withX`.
- **Update `strategy-opt-in`** in `scripts/check-architecture.mjs` to (a) require a `withX()` for
  every ①/② service and (b) exempt the ③ list — turning "every service is opt-in" into a
  mechanically enforced invariant.

## Success criteria

- Every ① and ② service has a `withX()` and is tree-shaken from the floor bundle when not opted in.
- The `strategy-opt-in` check passes and now covers the whole service layer (① + ② required, ③ exempt).
- A developer opts into instance capabilities uniformly (`createNoydb({ …: withX() })`) and into
  schema features on the collection (`collection({ computed, money, … })`).
- Bundle-size floor drops (② capabilities leave the always-on core).
- All existing tests pass; new tests assert the `SubsystemNotEnabledError` gate for each ② service.

## Out of scope / open (resolve in the plan)

- Whether `createNoydb` keeps named `…Strategy` fields or moves to a single `capabilities: [...]`
  array (a bigger API change — **default: keep named fields**; only revisit if the ② additions
  make it unwieldy).
- The `embeddings`↔`search` pairing (one `withX()` or two).
- Per-service migration ordering + the deprecation message wording.
