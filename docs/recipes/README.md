# Recipes

> Copy-paste-ready starter applications. Each recipe is a doc page + a runnable test under `showcases/src/`. Pick the one closest to your app, copy the `createNoydb({...})` setup, and adapt.

## Starter recipes

The four recipes that span the catalog from minimalist core to fully opted-in:

| Recipe | Bundle | Subsystems opted in | Verified by |
|---|---|---|---|
| [Personal encrypted notebook](./personal-notebook.md) | core only (~6.5K LOC) | none — pure floor | [`recipe-personal-notebook.recipe.test.ts`](../../showcases/src/recipe-personal-notebook.recipe.test.ts) |
| [Accounting application](./accounting-app.md) | ~13.2K LOC | history · periods · blobs · i18n · consent · aggregate | [`recipe-accounting-app.recipe.test.ts`](../../showcases/src/recipe-accounting-app.recipe.test.ts) |
| [Real-time collaborative app](./realtime-crdt-app.md) | ~10.4K LOC | crdt · sync · session | [`recipe-realtime-crdt.recipe.test.ts`](../../showcases/src/recipe-realtime-crdt.recipe.test.ts) |
| [Analytics-heavy querying](./analytics-app.md) | ~10.7K LOC | indexing · aggregate · session | [`recipe-analytics.recipe.test.ts`](../../showcases/src/recipe-analytics.recipe.test.ts) |

## Domain how-tos

Pattern-specific walkthroughs that don't map to a single starter recipe:

| Page | What it covers |
|---|---|
| [Email archive](./email-archive.md) | Storing MIME `.eml` ingestion as structured records + blob attachments + thread navigation |

## Related

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md) — full catalog
- [docs/core/](../core/) — what's always loaded
- [docs/subsystems/](../subsystems/) — what each opt-in capability does
