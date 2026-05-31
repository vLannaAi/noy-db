# Runtime schema introspection (#229) — design

**Status:** approved (autonomous build) · **Date:** 2026-06-01 · **Issue:** #229 · **Milestone:** #12 (independent follow-up)

**Goal:** A read-only `vault.introspect()` that enumerates a vault's live registered schema — collections, guards, materialized views, schema-update strategies, and the current user's grants — so apps can build diagnostics/audit tooling without hard-coding names.

## Context — what already exists

`vault.dumpSchema()` already returns a rich `VaultSchemaSnapshot` (collections, materialized views, overlays, derivations, subsystem on/off flags, optional stats) — see `packages/hub/src/introspection/`. This feature does **not** duplicate it. Instead it adds a focused, cheap `introspect()` that surfaces the **gaps** `dumpSchema()` doesn't cover (guards enumeration, schema-update strategies, user grants) plus the two most-asked lightweight fields (collection names + doc counts, MV source mapping), in a flat shape convenient for a dashboard.

`dumpSchema()` stays the heavyweight "full snapshot + stats" tool; `introspect()` is the lightweight "what's registered right now" read.

## Scope (decided)

**In:**
- `collections`: `{ name, docCount }[]` — names from `vault.collections()`, count from `adapter.list(name).length`.
- `guards`: `{ collection, count }[]` — from `GuardRegistry` (new `summary()` accessor; today it only has `guardsFor(name)`).
- `materializedViews`: `{ name, sourceCollections }[]` — reuse `MaterializedViewRegistry.all()` (`outputCollection` + `dependencies`).
- `schemaUpdate`: `{ collection, strategies: string[] }[]` — strategy `.name`s. **Not stored anywhere today** — captured into a vault-level map at `collection({ schemaUpdate })` registration.
- `grants`: `{ collection, permission }[]` — from `vault.keyring.permissions` (a plain `Record<string, Permission>`), for the unlocked user.

**Out (deferred):**
- i18n bilingual fields (smaller win; private registries; add later if a UI needs it).
- Overlays + derivations enumeration — already in `dumpSchema()`; don't duplicate.
- `byteSize` / violation counts — `dumpSchema({ withStats })` is the place for expensive walks; `introspect()` stays cheap (one `adapter.list` per collection, no decryption).

## API

```ts
vault.introspect(): Promise<SchemaIntrospection>

interface SchemaIntrospection {
  readonly collections: ReadonlyArray<{ name: string; docCount: number }>
  readonly guards: ReadonlyArray<{ collection: string; count: number }>
  readonly materializedViews: ReadonlyArray<{ name: string; sourceCollections: string[] }>
  readonly schemaUpdate: ReadonlyArray<{ collection: string; strategies: string[] }>
  readonly grants: ReadonlyArray<{ collection: string; permission: Permission }>
}
```

`Permission` is the existing `'r' | 'rw' | 'admin'`-style type from `types.ts`. All arrays are sorted by name/collection for deterministic output (testability).

## Architecture

- **`GuardRegistry.summary()`** (new): `{ collection: string; count: number }[]` from its `_byCollection` map. Keeps the introspection read off the registry's internals.
- **Vault `#schemaUpdateNames: Map<string, string[]>`** (new): populated in the `collection()` registration path whenever `options.schemaUpdate` is present — stores `strategies.map(s => s.name)`. This is the only new *capture* (strategies are otherwise closed over in the gate).
- **`vault.introspect()`** (new): assembles the snapshot from `this.collections()` + `adapter.list`, `_getGuardRegistry()?.summary()`, `_getMaterializedViewRegistry()?.all()`, `#schemaUpdateNames`, and `this.keyring.permissions`. Registries are `null` when their subsystem isn't enabled → those arrays are empty.
- Lives on `Vault`; **post-unlock by construction** (a `Vault` only exists with an `UnlockedKeyring`), so no extra lock guard is needed — documented.
- Optional: re-export the `SchemaIntrospection` type from `@noy-db/hub`.

## Error handling

- No throws in the happy path. A collection with no guards / no MV / no schemaUpdate simply doesn't appear in those arrays. Registries absent (subsystem off) → empty arrays, not errors.

## Testing

- `GuardRegistry.summary()` unit test (registered guards across 2 collections → correct counts; empty registry → `[]`).
- Integration (`createNoydb` + memory): `introspect()` on a vault with 2 collections (one with N docs), a guard, an MV, and a `coordinatedCutover`/`additiveOnly` schemaUpdate list → asserts each array's contents; `docCount` matches; `schemaUpdate` lists the strategy names; `grants` reflects the owner's permissions; arrays are sorted.
- Subsystems-off vault → `guards`/`materializedViews`/`schemaUpdate` are `[]`, `collections`/`grants` still populated.

## Success criteria

1. `vault.introspect()` returns collection names with correct `docCount` (cheap `adapter.list`, no decryption).
2. Guards enumerated as `{collection, count}` via the new `GuardRegistry.summary()`.
3. Materialized views enumerated as `{name, sourceCollections}` from the existing registry.
4. `schemaUpdate` lists each collection's registered strategy names (captured at registration).
5. `grants` reflects the unlocked user's per-collection permissions.
6. Subsystems-off vault yields empty arrays for the optional sections without error; no behaviour change for the existing suite.
