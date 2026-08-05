# `@noy-db/hub/cargo` — the klum orchestration seam

`/cargo` is the **canonical** orchestration seam that **klum-db** binds. In the
architecture lexicon, *cargo* is the layer of services + interfaces required to
**manage pods** — the multi-vault management plane: **custody, deed, diff,
distributed query, addressing, and change-observation**. It consolidates the
entire `/kernel` runtime floor (re-exported via `export *`) plus the
orchestration delta klum previously pulled from the bare `@noy-db/hub` root
barrel, so an outward orchestrator binds **one** narrow subpath instead of
reaching into hub internals.

The published `/kernel` subpath has been **retired** (coordinated removal;
consumers migrated to `/cargo`). `src/legacy/kernel.ts` still exists on disk,
but only as `/cargo`'s internal re-export floor — it is no longer built as a
subpath entry. All orchestration consumers bind `/cargo`. The export surface is frozen by
`__tests__/cargo-surface-golden.test.ts` against `cargo-surface.golden.json`, so
changes to the seam are deliberate and reviewed (additive-only).

See `docs/foundations/architecture-lexicon.md` for the
canonical lexicon this implements.
