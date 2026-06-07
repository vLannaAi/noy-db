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
