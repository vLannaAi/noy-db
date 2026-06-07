# MVF VaultGroup Routing — Milestone 16 MVP Design

- **Date:** 2026-06-07
- **Milestone:** 16 — Multi-vault partition federation (epic #271)
- **Status:** Design approved, pending implementation plan
- **Scope:** First vertical slice — `withSharding`/`VaultGroup` transparent routing + minimal StateManagement `vault-registry`

## Goal

Deliver the headline `withSharding` primitive from the multi-vault partition
federation epic as a single, self-contained vertical slice: stamp per-partition
shards from a template, route writes transparently by partition key, and fan
out reads across shards — all backed by a minimal `vault-registry` control-plane
collection that is the authoritative source of shard discovery (closing the
`listAccessibleVaults` backend-capability gap on S3 / DynamoDB / browser stores).

Every individual shard remains an ordinary noy-db vault within its own
small-DB ceiling; this epic adds automation and an entry point *above* them.

## Scope

### In scope

- `withVaultTemplate(name, spec)` — register a schema blueprint carrying a `version`.
- `createShard(partitionKey)` — idempotently stamp a shard from a template and
  record its registry row.
- `openVaultGroup(name, opts)` → `VaultGroup` + `ShardedCollection<T>`.
- Transparent **write routing** by partition key, with `autoCreate` (default **on**).
- Cross-shard **fan-out read**: `.query().where(...).toArray()` →
  `{ results, skippedVaults }` with a `minSchemaVersion` guard.
- `firm.shard(key)` — drill-down to a single shard's full `Collection` API.
- Minimal StateManagement **`vault-registry`** collection as the source of truth
  for shard discovery.

### Explicitly deferred (with reason)

- `crossShardJoin` — would touch the `partitionScope: 'all'` invariant in
  `packages/hub/src/query/join.ts` (🔴 blocking conflict in the epic). **The MVP
  does not modify that seam.**
- `withCrossVaultDerivation` (Insight Vault push model) — the 🔴 cross-vault DEK
  invariant conflict (dim14). Deferred wholesale.
- `queryAcrossLive` (reactive fan-in), `aggregateAcross` (distributed reduce).
- Fleet schema-migration runner (lazy / active / staged rollout).
- StateManagement `schema-manifest`, `migration-status`, `deployment-events`
  collections — only `vault-registry` is in scope.

By deferring `crossShardJoin` and `withCrossVaultDerivation`, the MVP touches
**neither** of the epic's two 🔴 blocking conflicts.

## Architecture

A single operator `Noydb` instance owns the `store` and holds grants for all
shards it manages. `createShard` makes the operator the owner of each new shard.
(The dedicated service-account / least-privilege executor identity question from
the epic concerns the deferred cross-vault derivation executor, not routing.)

```
            operator Noydb instance (one store, many vaults)
                              │
          ┌───────────────────┼────────────────────────┐
          │                   │                         │
   StateManagement      VaultGroup 'firm-clients'   (other vaults…)
   vault                 ├─ template: client-template@v3
   └─ vault-registry     ├─ keyOf: r => r.clientId
      (source of truth)  └─ ShardedCollection<T>
          ▲                   │ routes to ▼
          │            shard: client-acme   shard: client-bigco   …N
          └──── discovery ────┘ (ordinary noy-db vaults)
```

### Components

#### `withVaultTemplate(name, spec)`

Registers a schema blueprint on the `Noydb` instance (or VaultGroup).

```ts
db.withVaultTemplate('client-template', {
  version: 3,                 // schema generation this blueprint produces
  configure(vault) {          // re-applied on every shard-collection open
    vault.collection('invoices', { indexes: [...], schema: invoiceSchema })
    vault.collection('ledger',   { schema: ledgerSchema })
  },
})
```

noy-db has no global per-vault schema registry — `collection()` options are
re-declared on every call. The template captures those options as a `configure`
function that `ShardedCollection` re-invokes so every routed handle is configured
identically. `version` is recorded into each shard's registry row at
`createShard` time and is the data source for the fan-out guard.

#### `openVaultGroup(name, opts)` → `VaultGroup`

```ts
const firm = await db.openVaultGroup('firm-clients', {
  registry: stateVault.collection('vault-registry'), // passed-in handle (bootstrap, below)
  sharding: {
    keyOf: (r) => r.clientId,
    vaultTemplate: 'client-template',
    autoCreate: true,
  },
})
```

#### `ShardedCollection<T>` — `firm.collection('invoices')`

- `.put(record)` — `keyOf(record)` → registry lookup → (autoCreate if missing) →
  route to that one shard.
- `.query().where(...).toArray()` — fan-out via `queryAcross` →
  `{ results, skippedVaults }`.
- `firm.shard(key)` — returns the underlying `Vault` (full Collection API; escape
  hatch for full-detail drill-down).

#### `createShard(partitionKey)` — idempotent

Vault-create and registry-write are two steps; `createShard` is re-runnable and
defines every partial-failure case:

| vault | registry row | action |
|---|---|---|
| missing | missing | create vault, apply template, write row |
| exists | missing | reconcile — re-write row, do not error |
| missing | exists | throw `ShardProvisioningError` (do not silently recreate — could mask data loss) |
| exists | exists | no-op, return existing handle |

### Data model — `vault-registry` row

```ts
interface VaultRegistryRow {
  vaultId: string        // noy-db vault name, e.g. "client-acme"
  partitionKey: string   // what keyOf() returns, e.g. "acme"
  templateName: string   // "client-template"
  schemaVersion: number  // copied from template.version at createShard
  createdAt: number
}
```

The registry is the single source of truth for discovery. `VaultGroup` never
uses `listAccessibleVaults` for discovery — one consistent, backend-agnostic
code path.

### The `minSchemaVersion` guard

- The registry rows give the candidate shard set for a fan-out.
- The guard is a **plaintext pre-filter over registry rows**: any row whose
  `schemaVersion < minVersion` is moved into `skippedVaults` *before* its vault
  is opened — so a mismatched shard is never cracked open and never silently
  mixes a different record shape into `results`.
- Versions differ only when templates are versioned across `createShard` calls.
  This is also the guard's test (see below); without it the guard ships untested
  because all-from-one-template shards always yield `skippedVaults: []`.

### Data flow

**Write:** `put(rec)` → `keyOf(rec) = 'acme'` → registry lookup
- hit → `openVault('client-acme')`, apply template, `collection('invoices').put(rec)`
- miss + `autoCreate` → `createShard('acme')`, then route
- miss + `!autoCreate` → `UnknownShardError`

**Read:** `query().where('status','==','overdue').toArray()`
→ read registry rows → version pre-filter → `queryAcross(eligibleVaultIds, v =>
v.collection('invoices').query().where(...).toArray(), { concurrency })`
→ flatten `result` slots into `results`; collect errored / version-filtered slots
into `skippedVaults` with a `reason` (`'schema-drift'` | `'error'`).

## Registry bootstrap

The `vault-registry` lives in a normal noy-db vault (the StateManagement vault),
opened by the operator instance. The **caller** opens/creates it and passes the
collection handle into `openVaultGroup`. `VaultGroup` never self-bootstraps a
vault — no chicken-and-egg.

## Error handling

- `UnknownShardError` — write to an unknown partition key with `autoCreate` off.
- `ShardProvisioningError` — registry row exists but the vault is gone.
- `VaultTemplateNotFoundError` — `vaultTemplate` names an unregistered template.
- Per-shard fan-out failures become `skippedVaults` entries (mirrors
  `queryAcross`'s swallow-into-result-slot behavior); a fan-out never throws as
  a whole because one shard failed.

## Invariants preserved

- `packages/hub/src/query/join.ts` `partitionScope: 'all'` seam is **untouched**.
  Cross-vault correlation still goes through `queryAcross`; `crossShardJoin` is
  deferred. Any edit there would be scope creep into deferred join work.
- Per-shard ZK / DEK boundary unchanged — no cross-vault derivation in the MVP.

## Testing strategy

- Template registration + `VaultTemplateNotFoundError`.
- `createShard` idempotency — all four partial-failure rows above.
- Write routing: hit, miss+autoCreate, miss+`UnknownShardError`.
- Fan-out merge across ≥3 shards; `concurrency` honored; per-shard error → `skippedVaults`.
- **Guard sequence:** register template v1 → `createShard('A')`; bump template to
  v2 → `createShard('B')`; `query({ minVersion: 2 }).toArray()` → `B` in `results`,
  `A` in `skippedVaults` with `reason: 'schema-drift'`.
- `firm.shard(key)` drill-down returns a fully-configured `Vault` Collection.

## Relationship to existing work

| Prior work | Relationship |
|---|---|
| `queryAcross` (`noydb.ts:932`) | Internal engine for `ShardedCollection.query().toArray()` |
| `openVault` (`noydb.ts:405`, open-or-create) | Underlying shard open/create primitive |
| `grant` (`noydb.ts:623`) | Operator identity holds shard grants |
| `partitionScope: 'all'` seam (`join.ts:95`) | Reserved for deferred `crossShardJoin`; untouched here |
| `vault.collection()` per-call options (`vault.ts:522`) | Captured by the vault template's `configure` |
| `extractPartition` / `adoptPartition` (milestone 10) | The "client leaves" provisioning ceremony for a shard (out of MVP scope, composes later) |

## Open items deferred to follow-up slices

- Insight Vault push-model derivation (`withCrossVaultDerivation`).
- `crossShardJoin` programmatic API (extends `partitionScope` seam).
- `queryAcrossLive`, `aggregateAcross`.
- Fleet schema-migration runner + `schema-manifest` / `migration-status` /
  `deployment-events`.
- Keyed point-reads on `ShardedCollection` (`.get(key, id)`, `.delete(key, id)`).
- Data-residency routing constraint on shard selection.
