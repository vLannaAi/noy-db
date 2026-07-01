# `@noy-db/hub/cargo` — the klum orchestration seam

`/cargo` is the **canonical** orchestration seam that **klum-db** binds. In the
architecture lexicon, *cargo* is the layer of services + interfaces required to
**manage pods** — the multi-vault management plane: **custody, deed, diff,
distributed query, addressing, and change-observation**. It consolidates the
entire `/kernel` runtime floor (re-exported via `export *`) plus the
orchestration delta klum previously pulled from the bare `@noy-db/hub` root
barrel, so an outward orchestrator binds **one** narrow subpath instead of
reaching into hub internals.

`/kernel` (`src/kernel/index.ts`) remains as a **deprecated alias** for existing
pins and will **not be removed** without a coordinated version bump. New
orchestration consumers should bind `/cargo`. The export surface is frozen by
`__tests__/cargo-surface-golden.test.ts` against `cargo-surface.golden.json`, so
changes to the seam are deliberate and reviewed (additive-only).

See `docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md` for the
canonical lexicon this implements.
