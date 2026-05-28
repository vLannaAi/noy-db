/**
 * Showcase 88 — Transferable partition bundles (extract → adopt → own)
 *
 * What you'll learn
 * ─────────────────
 * How a firm spins a sub-portfolio off into a brand-new, independently-owned
 * vault — the full owner-transfer ceremony:
 *
 *   1. `describeExtraction()` — preview what would travel (counts + bytes),
 *      decrypting nothing it doesn't have to.
 *   2. `extractPartition()` — walk the FK closure from a seed predicate,
 *      re-encrypt the selected records under fresh DEKs, and seal those DEKs
 *      under a one-time transfer key. Returns `{ bundleBytes, transferKey,
 *      sealId }`. Owner-only; non-destructive on the source.
 *   3. `adoptPartition()` — the recipient imports the re-keyed bundle into
 *      their own store. The vault is present but UNOWNED.
 *   4. `createOwnerOnAdoptedPartition()` — the recipient mints the first
 *      owner keyring (wrapping the partition DEKs under their passphrase) and
 *      the transfer seal is destroyed.
 *
 * Why it matters
 * ──────────────
 * The motivating case (niwat): the accounting firm's director **Alice** owns
 * one vault; operator **Belle** manages a sub-portfolio of hotel clients. The
 * firm spins off a dedicated hotel-accounting department that needs its OWN
 * vault — owned by Belle, containing only the hotel clients and the full
 * transitive closure of their bills / credit notes / workers — with Alice
 * nowhere in its keyring. Today that's a four-step error-prone dump-and-replay;
 * here it's a single audited ceremony, and the new owner's control is a
 * cryptographic property (she holds the only DEKs), not a vendor T&C.
 *
 * `carryLedger: true` carries the audit chain (regulatory continuity), and the
 * source vault records a `partition-handed-over` entry. (`carrySchemas: true`
 * likewise carries the persisted JSON Schemas — omitted here for brevity.)
 *
 * Prerequisites
 * ─────────────
 *   - Showcase 00 (hello vault), 05 (refs), 07 (withHistory), 21 (bundles)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → transferable-partition
 * docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, ref } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'
import {
  describeExtraction,
  extractPartition,
  adoptPartition,
  createOwnerOnAdoptedPartition,
} from '@noy-db/hub/bundle'
import { memory } from '@noy-db/to-memory'

interface Entity extends Record<string, unknown> { id: string; name: string }
interface Client extends Record<string, unknown> { id: string; name: string; entityId: string; operatorUserId: string }
interface Bill extends Record<string, unknown> { id: string; clientId: string; amount: number }
interface CreditNote extends Record<string, unknown> { id: string; billId: string; amount: number }
interface Worker extends Record<string, unknown> { id: string; clientId: string; name: string }

/**
 * Build the firm's vault, owned by Alice, with Belle's hotel clients + Ann's
 * shop client sharing one parent entity. Returns the open vault.
 */
async function niwatVault() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'alice-director-2026', historyStrategy: withHistory() })
  const vault = await db.openVault('niwat')

  const entities = vault.collection<Entity>('entities')
  const clients = vault.collection<Client>('clients', { refs: { entityId: ref('entities') } })
  const bills = vault.collection<Bill>('bills', { refs: { clientId: ref('clients') } })
  const creditNotes = vault.collection<CreditNote>('creditNotes', { refs: { billId: ref('bills') } })
  const workers = vault.collection<Worker>('workers', { refs: { clientId: ref('clients') } })

  await entities.put('e-grp', { id: 'e-grp', name: 'Lanna Group' }) // shared parent

  // Belle's hotel clients.
  await clients.put('c-hotelA', { id: 'c-hotelA', name: 'Hotel A', entityId: 'e-grp', operatorUserId: 'belle' })
  await clients.put('c-hotelB', { id: 'c-hotelB', name: 'Hotel B', entityId: 'e-grp', operatorUserId: 'belle' })
  // Ann's client — must NOT travel.
  await clients.put('c-shop', { id: 'c-shop', name: 'Corner Shop', entityId: 'e-grp', operatorUserId: 'ann' })

  await bills.put('b-1', { id: 'b-1', clientId: 'c-hotelA', amount: 1000 })
  await bills.put('b-2', { id: 'b-2', clientId: 'c-hotelB', amount: 2000 })
  await bills.put('b-3', { id: 'b-3', clientId: 'c-shop', amount: 500 })       // Ann's — excluded
  await creditNotes.put('cn-1', { id: 'cn-1', billId: 'b-1', amount: 100 })     // child of b-1
  await workers.put('w-1', { id: 'w-1', clientId: 'c-hotelA', name: 'Niran' })  // child of c-hotelA

  return vault
}

const hotelSeed = { clients: (c: Record<string, unknown>) => c.operatorUserId === 'belle' }

describe('Showcase 88 — transferable partition bundles', () => {
  it('describeExtraction previews exactly the closure that would travel', async () => {
    const vault = await niwatVault()

    const preview = await describeExtraction(vault, { seeds: hotelSeed })

    const byName = Object.fromEntries(preview.byCollection.map((c) => [c.name, c.recordCount]))
    // Belle's two clients + their bills (b-1, b-2) + cn-1 + w-1, plus the
    // shared parent entity pulled by outbound FK completion. Ann's c-shop/b-3
    // are absent.
    expect(byName).toEqual({ entities: 1, clients: 2, bills: 2, creditNotes: 1, workers: 1 })
    expect(preview.totalRecords).toBe(7)
    expect(preview.totalBytes).toBeGreaterThan(0)
    expect(preview.graph.cyclesDetected).toBe(false)
  })

  it('runs the full extract → adopt → own ceremony; Belle owns a partition Alice cannot reach', async () => {
    const source = await niwatVault()

    // ── Firm side: Alice (owner) extracts Belle's hotel sub-portfolio.
    const { bundleBytes, transferKey, sealId } = await extractPartition(source, {
      seeds: hotelSeed,
      carryLedger: true, // regulatory audit continuity
    })
    expect(transferKey.byteLength).toBe(32)
    expect(sealId.length).toBeGreaterThan(0)

    // ── Recipient side: Belle imports into her OWN store, then takes ownership.
    const belleStore = memory()
    const adoption = await adoptPartition(bundleBytes, {
      transferKey,
      destinationStore: belleStore,
      vaultName: 'niwat-hotel',
    })
    expect(adoption.needsOwner).toBe(true)

    await createOwnerOnAdoptedPartition(belleStore, 'niwat-hotel', {
      userId: 'belle',
      passphrase: 'belle-hotel-dept-2026',
      transferKey,
    })

    // Belle opens her vault with HER passphrase — Alice's never touches it.
    const belleDb = await createNoydb({ store: belleStore, user: 'belle', secret: 'belle-hotel-dept-2026', historyStrategy: withHistory() })
    const hotel = await belleDb.openVault('niwat-hotel')

    // The hotel clients + their full FK closure are readable.
    expect(await hotel.collection<Client>('clients').get('c-hotelA')).toMatchObject({ name: 'Hotel A' })
    expect(await hotel.collection<Bill>('bills').get('b-1')).toMatchObject({ amount: 1000 })
    expect(await hotel.collection<CreditNote>('creditNotes').get('cn-1')).toMatchObject({ billId: 'b-1' })
    expect(await hotel.collection<Worker>('workers').get('w-1')).toMatchObject({ name: 'Niran' })
    expect(await hotel.collection<Entity>('entities').get('e-grp')).toMatchObject({ name: 'Lanna Group' }) // FK parent travelled

    // Ann's client never crossed the boundary.
    expect(await hotel.collection<Client>('clients').get('c-shop')).toBeNull()
    expect(await hotel.collection<Bill>('bills').get('b-3')).toBeNull()

    // The carried audit chain verifies over the re-keyed data.
    expect((await hotel.verifyBackupIntegrity()).ok).toBe(true)

    // Belle is the sole owner: Alice is nowhere in the partition's keyring, so
    // she cannot read it — the access barrier is cryptographic (no DEK she can
    // unwrap), surfaced when she tries to read.
    const aliceDb = await createNoydb({ store: belleStore, user: 'alice', secret: 'alice-director-2026' })
    const aliceView = await aliceDb.openVault('niwat-hotel')
    await expect(aliceView.collection<Client>('clients').get('c-hotelA')).rejects.toThrow()
  })

  it('leaves the source vault intact and records a partition-handed-over audit entry', async () => {
    const source = await niwatVault()
    const { sealId } = await extractPartition(source, { seeds: hotelSeed, carryLedger: true })

    // Non-destructive: every source record still resolves, including Belle's.
    expect(await source.collection<Client>('clients').get('c-hotelA')).toMatchObject({ name: 'Hotel A' })
    expect(await source.collection<Bill>('bills').get('b-1')).toMatchObject({ amount: 1000 })
    expect((await source.verifyBackupIntegrity()).ok).toBe(true)

    // The firm's ledger records that the partition was handed over.
    const ledger = source._getLedgerOrNull()!
    const entries = await ledger.loadAllEntries()
    expect(entries.some((e) => e.op === 'lifecycle' && e.reason === `partition-handed-over:${sealId}`)).toBe(true)
  })
})
