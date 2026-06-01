# Devtools Inspector — B1 Inspector Core Design

> **Status:** Design (approved in brainstorming) — pre-plan
> **Date:** 2026-06-02
> **Track:** B (devtools inspector), slice B1 of 3
> **Spec parent:** `docs/superpowers/specs/2026-06-01-kernel-shrink-and-devtools-proposal.md`

## What this is

Track B is the devtools inspector from the kernel-shrink/devtools proposal — the feature that lets a developer *see* a live noy-db: vaults, collections, schema, stats, records, and live writes. It decomposes into three slices:

- **B1 — Inspector core** *(this spec)*: a framework-agnostic package that turns a live `Noydb` + open `Vault` handles into plain, serializable read-only structures plus a live update stream. The data layer both UIs consume.
- **B2 — CLI/TUI inspector**: an interactive terminal UI over B1 (complements `noydb describe`).
- **B3 — Browser panel**: a web UI over B1.

This spec covers **B1 only**. B2/B3 are separate spec → plan → implementation cycles.

## Architecture

A new package **`@noy-db/in-devtools`** in the `in-*` family. It is a **pure consumer of public hub APIs** — it imports only the published surface of `@noy-db/hub`, touches no internals, and requires **zero hub changes**. `@noy-db/hub` is a `peerDependency` (`workspace:*`), matching every other satellite.

The package exports a single factory, `createInspector(noydb)`, returning a read-only facade. Output is always **plain serializable objects** (no live hub handles leak into returned data), so a browser panel can `structuredClone`/`postMessage` them and a CLI can render them directly.

The package is intentionally small and framework-agnostic (no DOM, no framework deps) — it is the substrate B2/B3 build on.

## Public API (slice B1)

```ts
import { createInspector } from '@noy-db/in-devtools'

const inspector = createInspector(db) // db: Noydb

// 1. Top-level vault list — no decryption, no open required.
inspector.listVaults(): Promise<VaultInfo[]>
//   Backed by db.listAccessibleVaults(). VaultInfo = { name, role, ... } (the
//   public AccessibleVault shape, re-surfaced as a plain object).

// 2. Structure + stats for an ALREADY-OPEN vault.
inspector.snapshot(vault: Vault): Promise<InspectorSnapshot>
//   Backed by vault.dumpSchema(). InspectorSnapshot = {
//     vault: string,
//     collections: Array<{
//       name: string
//       fields: Record<string, FieldDescriptor>   // from dumpSchema
//       indexes: ...; refs: ...
//       stats?: { records, bytes, bytesAvg, oldest, newest }
//     }>
//   }  — a flattened, plain projection of VaultSchemaSnapshot.

// 3. Paged, decrypted record contents for one collection of an open vault.
inspector.records(vault: Vault, collection: string, opts?: { limit?: number; offset?: number }):
  Promise<{ rows: unknown[]; total: number; limit: number; offset: number }>
//   Backed by vault.collection(collection).query().limit(l).offset(o).toArray()
//   plus .count() for total. Default limit = 50; a hard max (e.g. 500) clamps it.

// 4. Live write stream (all vaults of this Noydb).
inspector.subscribe(handler: (event: InspectorWriteEvent) => void): Unsubscribe
//   Backed by db.onAfterWrite(). InspectorWriteEvent is the public WriteEvent
//   projected to a plain object: { op, vault, collection, docId, before, after,
//   version, baseVersion, userId, timestamp }.

// 5. Pending-write state (for a "writes in flight" indicator).
inspector.pendingWrites(): { pending: number; depth: number }
//   Backed by db.writeQueue.
```

`Unsubscribe`, `WriteEvent`, `AccessibleVault`, `VaultSchemaSnapshot`, `FieldDescriptor`, `Vault`, `Noydb` are all imported as types from `@noy-db/hub`.

## Data flow

```
caller (B2 CLI / B3 panel / test)
  └─ createInspector(noydb)
       ├─ listVaults()      → db.listAccessibleVaults()      → VaultInfo[]
       ├─ snapshot(vault)   → vault.dumpSchema()             → InspectorSnapshot
       ├─ records(vault,c)  → vault.collection(c).query()…   → { rows, total, … }
       ├─ subscribe(fn)     → db.onAfterWrite(fn')           → Unsubscribe
       └─ pendingWrites()   → db.writeQueue                  → { pending, depth }
```

Every method is a thin adapter: call the public API, project the result into a plain inspector-owned type, return. No caching, no state held in the inspector beyond the set of active subscriptions (which are just the unsubscribe fns from `onAfterWrite`).

## Constraints (load-bearing)

- **Read-only.** No method writes. `records()` only reads via `query()`. There is no `edit`/`put`/`delete` surface in B1.
- **Zero-knowledge-respecting.** The inspector operates strictly within an *already-unlocked* session: it never handles passphrases and never opens vaults — the caller passes open `Vault` handles. It shows only what the session's keyring can already decrypt; `query()`/`dumpSchema()` enforce permissions automatically, so the inspector inherits them (a viewer sees only what a viewer can read).
- **Bounded plaintext.** `records()` is always paged with a default `limit` (50) and a hard ceiling (500) so the inspector never bulk-dumps an entire collection's plaintext into memory in one call.
- **Serializable output.** Returned objects contain only plain data (strings/numbers/plain objects), never live `Vault`/`Collection`/`Noydb` handles — so B3 can ship them across a `postMessage` boundary.

## Components / files

```
packages/in-devtools/
  src/
    index.ts        # createInspector(), public types, re-exports
    snapshot.ts     # listVaults() + snapshot() projection from dumpSchema
    records.ts      # records() paging/clamping over query()
    events.ts       # subscribe() projection of WriteEvent + pendingWrites()
  __tests__/
    inspector.test.ts
  package.json      # in-* template: type module, tsup build, vitest, hub peer-dep
  tsconfig.json     # extends ../../tsconfig.base.json
  tsup.config.ts    # (or shared) dual ESM/CJS build like other in-* packages
```

Each file has one responsibility; `index.ts` wires them into the `createInspector` facade.

## Error handling

- `snapshot(vault)` / `records(vault, …)` propagate hub errors as-is (e.g. a `ReadOnlyError`/permission error surfaces to the caller — the UI decides how to show it). The inspector does not swallow them.
- `records()` clamps `limit` to `[1, 500]` and treats a negative/NaN `offset` as 0 rather than erroring.
- `subscribe()` returns the `onAfterWrite` unsubscribe verbatim; handler errors are the hub's existing concern (it warns, per #230).

## Testing

Vitest against an in-memory-store `Noydb` (the established hub-test pattern — inline memory adapter + `createNoydb`):

- `listVaults()` returns accessible vaults.
- `snapshot(vault)` returns collections with fields + stats (recordCount, bytes) after seeding records.
- `records(vault, c, { limit, offset })` returns the right page + `total`; respects the default limit and the hard ceiling.
- `subscribe(fn)` fires with a correct `InspectorWriteEvent` on `put` (op:'create'/'update') and `delete` (op:'delete', after:null); the returned unsubscribe stops further events.
- `pendingWrites()` reflects `db.writeQueue`.
- **Read-only assertion:** exercising every inspector method does not mutate the underlying store (record count unchanged).
- Output is plain/serializable (`structuredClone(result)` does not throw).

## Non-goals (B1)

- No UI — terminal (B2) and browser (B3) are separate slices.
- No history / sync-state / audit-ledger surface yet (a later B1 extension once the UIs exist and need it).
- No editing / mutation of any kind.
- No multi-vault aggregation helper — the caller inspects one open vault at a time (keeps the unit small; B3 manages multiple).

## Follow-on

- **B2 — CLI/TUI inspector** over this core.
- **B3 — Browser panel** over this core.
- Later B1 extensions: history timeline, sync/presence state, per-collection live-query views.
