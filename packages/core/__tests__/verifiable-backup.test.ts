/**
 * Verifiable backups tests — #46, v0.4.
 *
 * Coverage:
 *   - dump() embeds ledgerHead + _internal sections for chain replay
 *   - load() round-trips a clean backup with no errors
 *   - load() rejects a backup whose ledger entry was tampered with
 *     (BackupLedgerError)
 *   - load() rejects a backup whose data envelope was modified
 *     between dump and restore (BackupCorruptedError)
 *   - load() rejects a backup whose embedded ledgerHead.hash was
 *     modified
 *   - load() of a legacy (pre-v0.4) backup logs a warning and skips
 *     the integrity check
 *   - verifyBackupIntegrity() can be called any time, not just on load
 *   - verifyBackupIntegrity() detects in-place data tampering on a
 *     live compartment
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '../src/types.js'
import { ConflictError, BackupLedgerError, BackupCorruptedError } from '../src/errors.js'

function memory(): NoydbAdapter {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: CompartmentSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Invoice {
  id: string
  client: string
  amount: number
}

describe('verifiable backups — #46', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      adapter: memory(),
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
  })

  it('dump() embeds ledgerHead and _internal sections', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', client: 'Acme', amount: 100 })
    await invoices.put('inv-2', { id: 'inv-2', client: 'Globex', amount: 200 })

    const backupJson = await company.dump()
    const backup = JSON.parse(backupJson)

    expect(backup.ledgerHead).toBeDefined()
    expect(backup.ledgerHead.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(backup.ledgerHead.index).toBe(1) // 0-based, two entries
    expect(backup.ledgerHead.ts).toMatch(/^\d{4}-/)

    expect(backup._internal).toBeDefined()
    expect(backup._internal._ledger).toBeDefined()
    // Two ledger entries → two padded keys.
    expect(Object.keys(backup._internal._ledger)).toHaveLength(2)
  })

  it('round-trips a clean backup with no errors', async () => {
    const adapter1 = memory()
    const sourceDb = await createNoydb({
      adapter: adapter1,
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const sourceCompany = await sourceDb.openCompartment('demo-co')
    const sourceInvoices = sourceCompany.collection<Invoice>('invoices')

    await sourceInvoices.put('inv-1', { id: 'inv-1', client: 'Acme', amount: 100 })
    await sourceInvoices.put('inv-2', { id: 'inv-2', client: 'Globex', amount: 200 })
    await sourceInvoices.put('inv-1', { id: 'inv-1', client: 'Acme', amount: 150 })

    const backup = await sourceCompany.dump()

    // Restore into a fresh adapter via a fresh Noydb. The same
    // passphrase is required so the keyring DEKs unwrap correctly
    // — verifiable-backup integrity is orthogonal to encryption.
    const adapter2 = memory()
    const targetDb = await createNoydb({
      adapter: adapter2,
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const targetCompany = await targetDb.openCompartment('demo-co')
    await targetCompany.load(backup)

    // Data should be visible.
    const targetInvoices = targetCompany.collection<Invoice>('invoices')
    expect(await targetInvoices.get('inv-1')).toEqual({
      id: 'inv-1', client: 'Acme', amount: 150,
    })
    expect(await targetInvoices.get('inv-2')).toEqual({
      id: 'inv-2', client: 'Globex', amount: 200,
    })

    // Ledger should also be valid on the loaded side.
    const verifyResult = await targetCompany.verifyBackupIntegrity()
    expect(verifyResult.ok).toBe(true)
  })

  it('rejects a backup whose embedded ledgerHead.hash was modified', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', client: 'Acme', amount: 100 })

    const backupJson = await company.dump()
    const backup = JSON.parse(backupJson)
    // Tamper: reverse the hash string. Reversing a 64-char hex
    // digest produces a deterministically-different value unless
    // the digest happens to be a palindrome (probability ~16^-32,
    // astronomically low). An earlier version of this test used
    // `.replace(/^./, '0')`, which silently no-ops about 1/16 of
    // the time when the first char is already '0' — that was the
    // source of an intermittent CI flake until #61 fixed it.
    backup.ledgerHead.hash = backup.ledgerHead.hash.split('').reverse().join('')
    const tamperedJson = JSON.stringify(backup)

    const adapter2 = memory()
    const targetDb = await createNoydb({
      adapter: adapter2,
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const targetCompany = await targetDb.openCompartment('demo-co')

    await expect(targetCompany.load(tamperedJson)).rejects.toThrow(BackupLedgerError)
  })

  it('rejects a backup whose data envelope was modified between dump and restore', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', client: 'Acme', amount: 100 })

    const backupJson = await company.dump()
    const backup = JSON.parse(backupJson)
    // Tamper: replace the _data field of the invoice envelope.
    const env = backup.collections.invoices['inv-1']
    env._data = env._data.split('').reverse().join('')
    const tamperedJson = JSON.stringify(backup)

    const adapter2 = memory()
    const targetDb = await createNoydb({
      adapter: adapter2,
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const targetCompany = await targetDb.openCompartment('demo-co')

    await expect(targetCompany.load(tamperedJson)).rejects.toThrow(BackupCorruptedError)
  })

  it('rejects a backup whose ledger entry was modified', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', client: 'Acme', amount: 100 })
    await invoices.put('inv-2', { id: 'inv-2', client: 'Globex', amount: 200 })

    const backupJson = await company.dump()
    const backup = JSON.parse(backupJson)
    // Tamper: modify the second ledger entry's encrypted bytes.
    const ledgerEntries = backup._internal._ledger
    const keys = Object.keys(ledgerEntries).sort()
    const secondKey = keys[1]
    const env = ledgerEntries[secondKey]
    env._data = env._data.split('').reverse().join('')
    const tamperedJson = JSON.stringify(backup)

    const adapter2 = memory()
    const targetDb = await createNoydb({
      adapter: adapter2,
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const targetCompany = await targetDb.openCompartment('demo-co')

    // The decrypt of the tampered ledger entry will throw a
    // TamperedError from the AES-GCM auth tag, propagating out of
    // verifyBackupIntegrity. Either error class signals corruption.
    await expect(targetCompany.load(tamperedJson)).rejects.toThrow()
  })

  it('legacy (pre-v0.4) backup loads with a warning and no integrity check', async () => {
    // Forge a "legacy" backup: round-trip a real one, then strip
    // the v0.4 fields. The data and keyrings still load fine.
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', client: 'Acme', amount: 100 })

    const backupJson = await company.dump()
    const backup = JSON.parse(backupJson)
    delete backup.ledgerHead
    delete backup._internal
    const legacyJson = JSON.stringify(backup)

    const adapter2 = memory()
    const targetDb = await createNoydb({
      adapter: adapter2,
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const targetCompany = await targetDb.openCompartment('demo-co')

    // Replace console.warn directly with a captured wrapper. vi.spyOn
    // wasn't capturing the call in this environment for reasons I
    // didn't get to the bottom of — direct replacement is more
    // reliable and the contract we're testing is "load() emitted at
    // least one warn-level message", which a function reassignment
    // captures cleanly.
    const warnings: string[] = []
    const originalWarn = console.warn
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    }
    try {
      await targetCompany.load(legacyJson)
    } finally {
      // eslint-disable-next-line no-console
      console.warn = originalWarn
    }
    // The data restored cleanly even though we couldn't verify it.
    const targetInvoices = targetCompany.collection<Invoice>('invoices')
    expect(await targetInvoices.get('inv-1')).toEqual({
      id: 'inv-1', client: 'Acme', amount: 100,
    })
    // The warning was emitted.
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toMatch(/legacy backup/i)
  })

  it('verifyBackupIntegrity() can be called on a live compartment', async () => {
    // Not a backup at all — just an in-place check that the chain
    // and data agree. Useful for periodic background audits.
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', client: 'Acme', amount: 100 })
    await invoices.put('inv-2', { id: 'inv-2', client: 'Globex', amount: 200 })

    const result = await company.verifyBackupIntegrity()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.length).toBe(2)
      expect(result.head).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('verifyBackupIntegrity() detects in-place data tampering', async () => {
    // Reach into the adapter and modify a record bytewise. The
    // ledger still has the OLD payloadHash; the new hash won't
    // match, and verifyBackupIntegrity returns kind: 'data'.
    const adapter = memory()
    const localDb = await createNoydb({
      adapter,
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const company = await localDb.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', client: 'Acme', amount: 100 })

    // Tamper directly in the adapter, bypassing the Collection.put
    // path entirely (so no ledger update).
    const env = await adapter.get('demo-co', 'invoices', 'inv-1')
    if (!env) throw new Error('expected envelope')
    const tampered: EncryptedEnvelope = {
      ...env,
      _data: env._data.split('').reverse().join(''),
    }
    await adapter.put('demo-co', 'invoices', 'inv-1', tampered)

    const result = await company.verifyBackupIntegrity()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('data')
      if (result.kind === 'data') {
        expect(result.collection).toBe('invoices')
        expect(result.id).toBe('inv-1')
      }
    }
  })

  it('verifyBackupIntegrity() returns ok on an empty compartment', async () => {
    const company = await db.openCompartment('demo-co')
    // No collections opened yet — empty ledger, empty data.
    const result = await company.verifyBackupIntegrity()
    expect(result.ok).toBe(true)
  })
})
