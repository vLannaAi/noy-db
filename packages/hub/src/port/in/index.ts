/**
 * @noy-db/hub/in — the in-* framework family port (types only).
 *
 * A framework binding (`in-react`, `in-nuxt`, `in-vue`, `in-pinia`,
 * `in-tanstack-query`, `in-ai`, …) binds ONLY to this subpath: the handle
 * types it wraps (`Noydb`, `Vault`, `Collection`, `Query`, `LiveQuery`) plus
 * the change-event shape it observes (`ChangeEvent`). Type-only — a
 * framework binding always receives a live instance from `createNoydb()`/
 * `openVault()`/`collection()` via the root barrel or `@noy-db/hub/cargo`;
 * this port exists so its wrapper types can name the shapes without
 * importing the whole hub surface.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export type { Noydb } from '../../kernel/noydb.js'
export type { Vault } from '../../kernel/vault.js'
export type { Collection } from '../../kernel/collection.js'
export type { Query } from '../../kernel/query/builder.js'
export type { LiveQuery } from '../../kernel/query/live.js'
export type { ChangeEvent } from '../../kernel/types.js'
