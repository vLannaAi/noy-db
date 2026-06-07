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
- **Out of scope (this MVP):** cross-shard joins, push-model cross-vault
  derivations (Insight Vault), reactive `queryAcrossLive`, `aggregateAcross`,
  and the fleet schema-migration runner. See the spec's deferred-items list.
