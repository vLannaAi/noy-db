# transferable partitions

> **Subpath:** `@noy-db/hub/bundle`
> **Factory:** none — direct named imports
> **Cluster:** F — Snapshot & Portability
> **LOC cost:** off-bundle when not opted in (lives in the `bundle` subpath)

## What it does

Extracts a subset of a vault's records into a **new, independently-owned vault** — the owner-transfer ceremony. Starting from a seed predicate, it walks the foreign-key closure (so every reference resolves), re-encrypts the selected records under **fresh per-collection DEKs**, and seals those DEKs under a **one-time transfer key**. The recipient adopts the bundle into their own store and mints the first owner keyring; after that they hold the only keys and the source owner is nowhere in the partition's keyring. The source vault is untouched (an audit append aside) — extraction is a copy, not a move.

## When you need it

- A firm spins a sub-portfolio off into a dedicated department's own vault (the motivating niwat case: hand the hotel clients + their bills/receipts/workers to a new owner).
- A client exercises data portability — taking the records they control to a new provider, with audit + schema fidelity, as a cryptographic right rather than a vendor favour.
- Splitting a shared vault along an ownership boundary without a manual dump-and-replay (which loses the FK closure, schema, and audit chain).

## Opt-in

Direct named imports — tree-shakes naturally:

```ts
import { createNoydb } from '@noy-db/hub'
import {
  describeExtraction,
  extractPartition,
  adoptPartition,
  createOwnerOnAdoptedPartition,
} from '@noy-db/hub/bundle'

// ── Source side (owner only) ──────────────────────────────────────────
const preview = await describeExtraction(sourceVault, {
  seeds: { clients: (c) => c.operatorUserId === 'belle' },
})
// preview.totalRecords / totalBytes / byCollection / graph — decrypts nothing
// it doesn't have to.

const { bundleBytes, transferKey, sealId } = await extractPartition(sourceVault, {
  seeds: { clients: (c) => c.operatorUserId === 'belle' },
  carrySchemas: true, // optional — carry persisted JSON Schemas (default false)
  carryLedger: true,  // optional — carry the re-chained audit ledger (default false)
})
// Deliver `transferKey` (32 bytes) out-of-band; it never travels in the bundle.

// ── Recipient side ────────────────────────────────────────────────────
await adoptPartition(bundleBytes, { transferKey, destinationStore, vaultName: 'hotel' })
await createOwnerOnAdoptedPartition(destinationStore, 'hotel', {
  userId: 'belle',
  passphrase: 'belle-hotel-2026',
  transferKey,
})

// Now open it normally — a keyring exists.
const db = await createNoydb({ store: destinationStore, user: 'belle', secret: 'belle-hotel-2026' })
const hotel = await db.openVault('hotel')
```

## Lifecycle

```
source vault ──extractPartition──▶ extracted bundle ──adoptPartition──▶ ADOPTED, UNOWNED ──createOwnerOnAdoptedPartition──▶ OWNED
 (owner only)  re-keyed, sealed,    _meta/adoption,    recipient keyring,
               bundleKind header     keyring empty       seal destroyed
```

The FK graph is **auto-derived from `ref()` declarations** (the `RefRegistry`) — you supply only `seeds`, not a hand-written edge list. The walk is two-phase: inbound expansion grows the scope from the seeds (a client's bills travel with it), then outbound completion pulls referenced parents so no FK dangles (without re-expanding those parents into unrelated siblings).

## API

- `describeExtraction(vault, { seeds, maxDepth? })` → `ExtractionPreview` — read-only dry-run (counts, bytes, `_ts` span, graph depth, `inaccessible[]`); writes nothing.
- `extractPartition(vault, { seeds, maxDepth?, compression?, carrySchemas?, carryLedger? })` → `{ bundleBytes, transferKey, sealId }` — **owner-only**; non-destructive on the source.
- `adoptPartition(bundleBytes, { transferKey, destinationStore, vaultName })` → `{ vaultName, needsOwner: true, sealId }`.
- `createOwnerOnAdoptedPartition(store, vaultName, { userId, passphrase, transferKey })` → `{ vaultName, userId }` — mints the first owner and destroys the transfer seal.
- `walkClosure(vault, { seeds, maxDepth? })` → `{ closure, graph }` — the underlying FK-closure primitive (also used by `describeExtraction`).
- Header additions (read pre-decryption by cloud listers): `bundleKind: 'extracted-partition'` + a `transferSeal` indicator. New errors: `PartitionExtractionError`, `TransferSealError`, `AdoptionStateError`.

## Behavior when NOT opted in

These are not strategy-gated — they're explicit imports from `@noy-db/hub/bundle`. An ordinary backup (`writeNoydbBundle`) has no `bundleKind`/`transferSeal`; `adoptPartition` rejects it with a `ValidationError` pointing you to `readNoydbBundle` + `vault.load`. `carrySchemas`/`carryLedger` default `false`, producing a clean partition with no `_internal` payload.

## Security model

- **Owner-only extraction.** Producing a re-keyed standalone vault is an ownership operation; a non-owner caller is rejected.
- **The transfer key never travels in the bundle.** `extractPartition` mints a random 32-byte key and seals the DEK set under it; the bundle bytes alone are inert. Deliver the key out-of-band (in person, a secrets manager, or #197 sealed delivery).
- **DEKs stay sealed at rest after adoption.** `adoptPartition` validates the key by unsealing in memory only; the sealed payload persists in `_meta/adoption` until `createOwnerOnAdoptedPartition` wraps the DEKs under the recipient's KEK and destroys the seal.
- **One-time per destination.** Re-adopting the same bundle into the same store is rejected; into a different store it's allowed (the bundle is immutable — the consumed marker is local).
- **Cryptographic ownership.** The recipient's control is that they hold the only DEKs, not a policy flag. The source owner cannot read the adopted partition.

## Carry opt-ins

- **`carrySchemas`** — re-keys `_schemas/<collection>` for the closure under the destination DEKs, so the recipient validates against the same contract and `noydb describe` works on the partition.
- **`carryLedger`** — filters the source audit chain to the closure, re-chains it (fresh indices/`prevHash`), recomputes each `payloadHash` against the re-keyed ciphertext for the latest put per record, and re-encrypts under a fresh `_ledger` DEK (sealed with the rest). The recipient's `verifyBackupIntegrity()` passes over the re-keyed data. (Open vault with a history strategy to exercise it.)

## Audit trail

All three lifecycle events ride a generic `'lifecycle'` ledger op (empty `collection`/`id`, detail in `reason`; skipped by the data cross-check, present in the tamper-evident chain):

- **Source:** `extractPartition` appends `partition-handed-over:<sealId>` (the firm's record that data left). No-op without a source history strategy.
- **Destination** (when `carryLedger` was used): `createOwnerOnAdoptedPartition` appends `creation-of-new-owner:<userId>` + `transfer-seal-consumed:<sealId>` to the carried chain.

## Edge cases & limits

- **Standard passphrase mode only** at owner-create today; managed mode (`SealingKeyProvider` / `at-*`) + recovery enrollment at creation are follow-ups (enroll recovery post-hoc via `db.enrollRecovery`).
- **`walkClosure` performance** is O(frontier · inbound-collections · records) per depth — fine at consumer-firm scale (≤100k records, FK depth ≤5); `maxDepth` (default 16) throws `PartitionExtractionError` on runaway graphs.
- **No source-side delete** — the ceremony is non-destructive of source records; destructive withdrawal is a separate concern (sibling #199).
- **`carryLedger` slice 1** carries `_ledger` entries only; `_ledger_deltas` (historical versions) + `_history` snapshots are a follow-up.
- **Records need string `id`s** — a non-string id fails loud (`PartitionExtractionError`) rather than silently dropping (which would dangle an FK).

## See also

- SPEC: `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md` (lifecycle state machine, invariants, wire format)
- Showcase: `showcases/src/88-transferable-partition.showcase.test.ts` (the niwat hotel-department spin-off, end-to-end)
- Pairs with: [bundle](./bundle.md), [history](./history.md) (carryLedger), [persisted-json-schema](../core/05-schema-and-refs.md) (carrySchemas), [team](./team.md)
