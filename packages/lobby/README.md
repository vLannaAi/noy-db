# @klum-db/lobby

> **The Lobby** orchestrates a *group* of sovereign [noy-db](https://github.com/vLannaAi/noy-db) vaults — federation, interchange, custody, and scoped sync — without ever dissolving their independence.
>
> **noy-db is the vault (inward). klum-db is the Lobby (outward).**
> A container runs perfectly alone; the engine orchestrates many. Docker is to a container what the Lobby is to a vault.

`@klum-db/lobby` · status: **preview** · depends on `@noy-db/hub`

---

## The idea in 20 seconds

Banking, accounting, health, insurance — the data that matters is **individual, single-entity, and owned by the subject**. noy-db makes each of those a small, sovereign, in-memory vault that is a *complete system on its own*. Working "small, in memory" isn't a limitation — it's the strong core. The limitation only bites when one actor must work across **many** datasets at once.

The **Lobby** is the framework for exactly that outward dimension: *the efficiency of a small independent dataset at the core, joined with an actor operating across many at the same time* — a counterbalance to tech giants holding user data hostage. Vaults stay independent and relocatable; the Lobby coordinates them without absorbing them. That's why it's a **group** (Thai *klum* กลุ่ม), never a cluster — federation here is non-aggregative.

## Reads in a sentence

> A firm is a **Custodian** in the **Lobby**: it holds operating grants to client **Vaults** that all reference one shared **Pool**. The client holds the **Deed**. To onboard, the firm **Relocates** a client's vault as a **Bundle**, **Migrates** it to the current schema, and **Merges** the Pool slice by field **Authority** using **Provenance**. The client can **Withdraw** anytime; an abandoned vault can be **Liberated**.

Every bold word is a real, shipped capability.

## Architecture — one-way dependency, two complementary axes

```
            outward / orchestration                 inward / the vault
   ┌─────────────────────────────────┐     ┌──────────────────────────────────┐
   │          @klum-db/lobby         │     │            @noy-db/hub            │
   │                                 │     │                                   │
   │  Lobby  ⊃  many Vaults          │ ──▶ │  Vault ⊃ Collection ⊃ Record ⊃ Field │
   │   • Federation (fleets)         │     │   • keyring · per-record CEK      │
   │   • Interchange (move data)     │     │   • computed/derivation · money   │
   │   • Custody (Deed/Custodian)    │     │   • i18n · history · snapshots    │
   │   • Surface (scoped sync)       │     │   • a vault + a store = complete  │
   └─────────────────────────────────┘     └──────────────────────────────────┘
          binds to the stable  ── @noy-db/hub/kernel ──  surface only
```

The dependency runs **one way**: `@klum-db/lobby` → `@noy-db/hub`. No `@noy-db` package ever imports `@klum-db` (enforced by a build-time architecture guard). The Lobby binds to a stable internal surface, **`@noy-db/hub/kernel`**, not hub internals. A vault is a complete, shippable system *without* the Lobby; the Lobby is what you reach for when one actor must work across many vaults at once.

## Install

```bash
pnpm add @klum-db/lobby @noy-db/hub
```

```ts
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createLobby } from '@klum-db/lobby'

const db = await createNoydb({ store: memory(), user: 'firm', secret: '…' })
const lobby = createLobby(db)
```

---

## The four pillars

### 1 · Federation — operate many vaults as a fleet

A `VaultGroup` shards one logical dataset across per-entity vaults (one client = one vault), with cross-shard queries, firm-wide **Insight** rollups (zero client data crosses a DEK boundary), and a resumable **fleet schema-migration** runner.

```ts
lobby.withVaultTemplate('client', { version: 1, configure: v => v.collection('invoices') })
const group = await lobby.openVaultGroup('clients', { registry, sharding: { keyOf, vaultTemplate: 'client', autoCreate: true } })
await group.shard('acme-co').collection('invoices').put('i1', { id: 'i1', total: '1200.00' })
const all = await group.queryAcross(/* … */)          // fan-out read across shards
await group.migrateFleet({ batchSize: 4 })             // resumable, registry-tracked
```

### 2 · Interchange — move data between vaults, safely

The full onboarding spine — **Relocate → Migrate → Merge by Authority using Provenance** — composes cleanly:

```ts
// FR-2 — Relocate: extract an FK-closed slice across vaults into one bundle
const { bundle, transferKeys } = await extractCrossVaultPartition(openVault, { seed, crossVaultRefs })

// FR-8 — Migrate-then-merge: upgrade an older-schema bundle in staging, THEN merge
const report = await migrateThenMerge(receiver, compartmentBytes, {
  transferKey, fromVersion: 0, toVersion: 1,
  migrations: { clients: [{ toVersion: 1, transform: splitFullName }] },
  strategy: 'field-authority',
  fieldAuthority: { clients: { juristicName: { authority: 'source-newest' }, nickname: { authority: 'owner', ownerSource: 'client' } } },
})
```

| Capability | What it does | API |
|---|---|---|
| **Bundle** (FR-1) | Multi-compartment `.noydb` container + pre-decrypt manifest | `@noy-db/hub/bundle` · `writeMultiVaultBundle` |
| **Relocate** (FR-2) | Cross-vault FK-closure extraction → bundle | `extractCrossVaultPartition` / `walkCrossVaultClosure` |
| **Merge** (FR-3) | Reconcile a compartment into an existing vault | `mergeCompartment` |
| **Authority** (FR-4) | Per-**field** conflict resolution (registry-newest vs owner) | `resolveFieldAuthority` · `strategy: 'field-authority'` |
| **Provenance** (FR-5) | `_source`/`_sourceTs` on writes, preserved through merge | `collection({ provenance: true })` · `getMetadata` |
| **Migrate** (FR-8) | Upgrade an incoming bundle to the receiver schema in staging | `migrateThenMerge` |
| **Export** (FR-9) | Multi-vault Excel: primary sheet + FK-referenced supporting rows | `lobby.exportMultiVaultXlsx` |

```ts
// FR-9 — one workbook spanning a client shard + the shared directory (only referenced rows)
const xlsx = await lobby.exportMultiVaultXlsx({
  primary: { vault: 'acme', seeds: { bills: () => true } },
  crossVaultRefs: [{ from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities' } }],
  sheets: { acme: [{ name: 'bills', collection: 'bills', denormalize: [{ column: 'entityName', localField: 'entityId', from: { label: 'directory', collection: 'entities', keyField: 'id', pick: 'name' } }] }],
            directory: [{ name: 'entities', collection: 'entities' }] },
})
```

### 3 · Custody — sovereign ownership without lock-in (FR-6)

The client holds an **inalienable, sealed, hidden owner** (the **Deed**) from day one; the firm operates at **100%** as a **Custodian** that *provably cannot* take ownership; an abandoned vault can be **Liberated** under an audited ceremony (the inverse of withdrawal). Inalienability is **cryptographic** — the Custodian holds the data keys but never the owner credential (sealed under a non-firm boundary).

```ts
import { createDeedOwner } from '@klum-db/lobby'              // re-exported from @noy-db/hub

await createDeedOwner(store, 'acme', 'client-acme', clientSealingProvider)   // latent owner, never authenticates
await db.grantCustodian('acme', { userId: 'firm', displayName: 'Firm', passphrase: '…' })
//  firm now operates fully — but grant / revoke / rotate / extract-and-sever all throw for a custodian
await vault.custody.liberate({ newOwnerId: 'firm-owner', newOwnerPassphrase: '…', legalBasis: 'contractual-handover' })
```

### 4 · Surface — sync only an agreed slice (FR-7)

A **Surface** is a persisted, bilaterally-agreed subset two parties sync: `{ collections, fields?, direction, conflictPolicy, cadence }`. Collections and fields **outside the surface never leave the vault** (structural projection at the export boundary).

```ts
const surface = await proposeSurface(smvA, { collections: ['compensations'], fields: { compensations: ['period', 'pnd1', 'sso'] }, direction: 'push', conflictPolicy: { strategy: 'lww-by-ts' }, cadenceMs: MONTH }, 'payroll', Date.now())
await agreeSurface(smvB, surface.id, 'tax-agent', Date.now())
const { bundleBytes, transferKey } = await lobby.exportSurface('payroll-vault', surface)   // only the 3 named fields leave
await lobby.applySurface('tax-vault', surface, bundleBytes, transferKey)
```

---

## Relationship with noy-db

- **Depends on `@noy-db/hub`**, binds to the stable **`@noy-db/hub/kernel`** subpath — never reaches into hub internals.
- **Custody is a vault-level concern** and lives *in* hub (keyring/CEK/consent primitives); the Lobby **re-exports** it (`createDeedOwner`, `liberateVault`, `CustodyApi`) so consumers have one import surface.
- **Federation** was extracted *out of* hub into the Lobby (a breaking pre-1.0 change): `Noydb.openVaultGroup` now throws `FederationMovedError` — use `lobby.openVaultGroup`.
- The dependency is enforced one-way at build time; an `@noy-db` package importing `@klum-db` fails the architecture check.

## Status

Preview, developed inside the noy-db monorepo while the kernel boundary stabilizes (it graduates to its own repo once proven). Versions track noy-db in lockstep. Pilot-1 epic (FR-1…FR-9) complete.

Design spec: [`docs/superpowers/specs/2026-06-16-lobby-framework-design.md`](../../docs/superpowers/specs/2026-06-16-lobby-framework-design.md). Runnable showcases: [`showcases/src/12x-klum-*`](../../showcases/src).
