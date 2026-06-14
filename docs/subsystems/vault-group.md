# Vault Group — Multi-Vault Partition Federation (MVF)

> Status: **preview** (milestone 16 MVP). Spec:
> `docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md`.

## Overview

`VaultGroup` routes records across many per-partition shard vaults behind a
single entry point, while every shard stays an ordinary noy-db vault within its
small-DB ceiling. Shard discovery is backed by a `vault-registry` collection
that is the single source of truth (no dependency on `listAccessibleVaults`, so
it works on every backend).

## API

```ts
db.withVaultTemplate('client-template', {
  version: 1,
  configure(vault) { vault.collection('invoices') },
})

const state = await db.openVault('state')
const firm = await db.openVaultGroup('firm-clients', {
  registry: state.collection('vault-registry'),
  sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template', autoCreate: true },
})

// Transparent write — routed (and auto-provisioned) by partition key.
await firm.collection('invoices').put('inv-1', { clientId: 'acme', amount: 1200, status: 'open' })

// Cross-shard fan-out read.
const { results, skippedVaults } = await firm.collection('invoices')
  .query().where('status', '==', 'overdue').toArray({ minVersion: 1 })

// Drill down to one shard's full Collection API.
const acme = await firm.shard('acme')
```

## Key-custody model

VaultGroup operations run as the **calling identity**, which may hold grants to
only a subset of the shards. The fan-out returns the **openable subset**; a shard
the caller has no grant to is a `'no-grant'` skip — expected under scoped access,
not a fault.

### Skip reasons

| reason | meaning |
|---|---|
| `'schema-drift'` | shard `schemaVersion` below the `minVersion` guard |
| `'no-grant'` | caller holds no keyring envelope for this shard (`NoAccessError`) |
| `'error'` | store fault, corruption, or wrong credential (`InvalidKeyError`, `KeyringCorruptError`, etc.) |

Only `NoAccessError` maps to `'no-grant'`; all other errors map to `'error'` so
that credential/corruption failures are never hidden as routine scoped-access
skips.

### Non-creating opens

All federation opens (`openShard`, `queryAcross` fan-out) are **non-creating**
(`create: false`). A missing grant therefore fails cleanly with `NoAccessError`
and never self-provisions a keyring entry. The **only creating path** is
`createShard`, which is called exclusively by the owning operator identity.

### Registry vault access

Opening a VaultGroup requires a grant to the **registry/StateManagement vault**
(`state` in the typical setup). Without it the caller cannot read the
`vault-registry` collection that drives shard discovery.

### Partition key design

`keyOf` must return an **opaque partition key** (e.g. an internal UUID or a
short code). Registry rows are stored plaintext-visible to every member of the
registry vault — do not key by sensitive identifiers such as tax IDs or full
legal names.

### Out of scope (this MVP)

Per-identity roster scoping (limiting which registry rows a grantee can see) is
deferred. The current model exposes the full registry to all registry-vault
grantees; access control is at the shard level.

## Guarantees & limits

- The operator `Noydb` instance owns its shards (`createShard` provisions them).
- `createShard` is idempotent; a registry row pointing at a missing vault raises
  `ShardProvisioningError` rather than recreating it.
- The `minVersion` guard pre-filters shards by their registry-recorded
  `schemaVersion`; behind-version shards land in `skippedVaults`, never mixed
  into `results`.
- **Out of scope (still):** cross-shard joins, push-model cross-vault
  derivations (Insight Vault), reactive `queryAcrossLive`, `aggregateAcross`
  have since shipped; remaining open items are the design questions (DEK-grant
  executor identity, data-residency routing). See the spec's deferred list.

## Insight Vault — cross-vault derivation (push model, #271 Layer 4)

A fleet dashboard shouldn't decrypt N client vaults on every read. The
**Insight Vault** is a separate analytics vault holding one small summary row
per shard, derived from each shard and pushed in.

```ts
firm.withCrossVaultDerivation<Invoice, ClientSummary>({
  source: 'invoices',                                       // read from each shard
  target: { vault: 'firm-insights', collection: 'client-summary' },
  derive: (records, ctx) => ({                              // runs per shard
    clientId: ctx.partitionKey,
    totalRevenue: records.reduce((s, r) => s + r.amount, 0),
    overdueCount: records.filter((r) => r.status === 'overdue').length,
    schemaVersion: ctx.schemaVersion,
  }),
})

const { written, skippedVaults } = await firm.refreshInsights({ minVersion: 3 })
// analyst then reads firm-insights directly — no per-client decryption
```

- **Push model.** `refreshInsights()` reads each eligible shard's `source`
  records in-process (under the group's `Noydb`, which holds both keyrings),
  runs `derive(records, ctx)` per shard, and writes the returned row into the
  Insight Vault keyed by partition key — **re-encrypted under the Insight
  Vault's own DEK**. A shard's ciphertext never crosses a DEK boundary.
- **`ctx`** = `{ vaultId, partitionKey, schemaVersion }` (from the registry row).
- Respects the `minVersion` drift guard; a shard whose read fails lands in
  `skippedVaults` and its summary is **not** overwritten with a stale value.
- **v1 is explicit-refresh** — call `refreshInsights()` after a batch of writes
  or on a schedule. Auto-push-on-write is a deferred follow-up.

> **⚠️ Zero-knowledge profile (weaker — read before adopting).** The Insight
> Vault backend sees *aggregated structure* (totals, counts, timestamps) drawn
> from many shards. That is a **weaker** guarantee than the per-shard vaults,
> each of which is its own DEK boundary. The Insight Vault is **opt-in** and
> should hold **aggregate scalars only** — no raw records, no embeddings.
> Treat its backend as a `tier: 'derived'` store with a formally weaker ZK
> profile, and grant it explicitly.

### Executor identity & least privilege

`refreshInsights()` runs the derivation under whatever `Noydb` opened the group.
In v1 that is typically the operator/admin, whose keyrings can decrypt **every**
shard and write **everywhere** — a broad blast radius for a background job.

For production, run the aggregation under a **dedicated service account** granted
*only* read on each shard's `source` collection and write on the Insight Vault —
nothing else. No hub change is needed; this is `grant()` + `createNoydb()` wiring:

```ts
// One-time provisioning by an admin holding owner on each vault:
for (const shardId of shardIds) {
  await admin.grant(shardId, {
    userId: 'svc-insights', displayName: 'Insight aggregator', role: 'operator',
    passphrase: SVC_PASSPHRASE,
    permissions: { collections: { invoices: ['read'] } },        // read-only source
  })
}
await admin.grant('firm-insights', {
  userId: 'svc-insights', displayName: 'Insight aggregator', role: 'operator',
  passphrase: SVC_PASSPHRASE,
  permissions: { collections: { 'client-summary': ['read', 'write'] } },
})

// The aggregation process runs as the service account:
const svc = await createNoydb({ store, user: 'svc-insights', secret: SVC_PASSPHRASE })
const firm = await svc.openVaultGroup('firm-clients', { sharding })
firm.withCrossVaultDerivation({ source: 'invoices', target, derive })
await firm.refreshInsights()   // reads only what it's granted; writes only the summary
```

A shard the service account isn't granted → a `'no-grant'` skip (already handled);
revoking its grant cleanly drops that shard from future refreshes. Every write is
actor-stamped (`_by = 'svc-insights'`) for a clean audit trail.

**Write isolation (enforced).** `withCrossVaultDerivation` throws a
`ValidationError` if `target.vault` is the group itself or one of its shards
(`<group>--<key>`) — a summary must never write back into client-shard data, which
would breach the per-shard DEK boundary. The target must be a separate vault.

## Fleet schema migration (#271)

When the template's `version` bumps (new schema + a `coordinatedCutover`
transform), each shard must run its per-vault M12 cutover. The fleet runner
orchestrates that across the group and records per-shard status in the
StateManagement Vault — **each shard still uses M12's single-vault protocol
internally** (`vault.runSchemaCutover()`); this adds the fleet-level ordering,
status, and resumability.

```ts
// Active batch runner — migrate every behind shard to the template version.
const { target, migrated, failed } = await firm.migrateFleet({ batchSize: 8 })

// Staged / canary — migrate a cohort first, verify, then the rest.
await firm.migrateFleet({ cohort: ['acme'] })
await firm.migrateFleet()

// Lazy — migrate a shard on first access (opt-in at openVaultGroup).
const firm = await db.openVaultGroup('firm', { sharding, migrateOnOpen: true })

// One shard.
await firm.migrateShard('acme')
```

- **Per-shard step (`migrateShard`)**: open the shard (applies the template →
  arms the cutover) → `_drainPendingSchemaWrites()` → `runSchemaCutover()` →
  advance the registry row's `schemaVersion` → write `migration-status`. A shard
  already at the target is a no-op. A failed cutover is caught, recorded as
  `status: 'failed'`, and does **not** abort the fleet run.
- **Resumable / crash-safe**: the registry `schemaVersion` is the source of
  truth; a re-run skips shards already at the target and retries failed ones.
- **`migration-status`** rows (`{ vaultId, currentVersion, targetVersion,
  status, migrated?, error? }`) + `migration-started/completed/failed`
  deployment events live in the StateManagement Vault.
- **Mixed-version reads stay safe**: the `minVersion` fan-out guard skips
  behind-version shards (`skippedVaults`) rather than mixing record shapes —
  so reads work throughout the rollout window.
- **Co-location assumption**: the runner drives co-located shards in-process.
  Per-process/distributed shards are a `by-server` concern, out of scope.

## Data residency (#271)

A regulated firm must keep each client's shard on a backend in a specific region
(`acme` → EU store, `globex` → US store). Routing already supports this via
`routeStore({ vaultRoutes })` (vault-name prefix → backend); the residency guard
adds **enforcement** so a shard can never be *placed* on a wrong-region backend.

```ts
const eu = /* an EU-region store */, us = /* a US-region store */
// Backends declare the region they serve:
eu.capabilities = { ...eu.capabilities, region: 'eu' }
us.capabilities = { ...us.capabilities, region: 'us' }

const store = routeStore({ vaultRoutes: { 'firm--eu-': eu, 'firm--us-': us }, default: control })
const firm = await db.openVaultGroup<Client>('firm', {
  sharding: {
    keyOf: (r) => r.placementKey,   // region-encoded → routes to the right backend
    regionOf: (r) => r.region,      // the legally-required residency region
    vaultTemplate: 'client', autoCreate: true,
  },
})

await firm.collection('clients').put('c1', { region: 'eu', placementKey: 'eu-acme', ... })  // ✓ EU
await firm.collection('clients').put('c2', { region: 'eu', placementKey: 'us-acme', ... })  // ✗ DataResidencyError
```

- **`StoreCapabilities.region`** (advisory) — a store declares the region it serves;
  zero behavior change for stores that omit it.
- **`sharding.regionOf(record)`** — the region a record's shard must live in. On
  `createShard` (and the auto-creating `put`), the group resolves the candidate
  backend (`routeStore.resolveBackend(vaultId)` — vault-prefix routing) and throws
  **`DataResidencyError`** *before provisioning* if the backend's `region` differs.
- **Placement-only.** Reads aren't blocked (the route already determines the
  physical backend); the guard prevents wrong-region *placement* — the
  compliance-relevant event — and loudly catches naming/routing drift.
- **Convention.** Encode the region in the partition key (`eu-acme`, `us-globex`,
  within `[A-Za-z0-9._-]`) so `firm--eu-` / `firm--us-` prefixes route. Re-homing
  an existing shard between regions is out of scope (an `extractPartition` →
  re-adopt ceremony, #198), not a routing change.

## Control plane — StateManagement Vault

`openVaultGroup(name)` (no explicit `registry`) auto-opens the reserved
`__noydb_state__` vault, accessible via `db.openStateManagementVault()`. It owns
the `vaultRegistry` (authoritative, group-qualified shard list), a per-version
`schemaManifest` (serializable blueprint + deterministic fingerprint, with
`detectDrift()`), and an append-only `deploymentEvents` log. See the design spec:
`docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md`.
