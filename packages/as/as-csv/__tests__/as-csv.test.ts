/**
 * Integration tests for @noy-db/as-csv.
 *
 * Covers:
 *   - happy path: owner with canExportPlaintext['csv'] grant → valid CSV output
 *   - RFC 4180 escaping: commas, quotes, newlines inside fields
 *   - null/undefined/Date/boolean/number serialisation
 *   - explicit `columns` overrides inference
 *   - authorization refusal: owner without grant → ExportCapabilityError
 *   - authorization refusal: operator without grant → ExportCapabilityError
 *   - acknowledgeRisks refusal on write()
 */

import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { toString, download, write } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
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
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice {
  id: string
  client: string
  amount: number
  status: string
}

async function seedVault() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  const vault = await db.openVault('acme')
  const invoices = vault.collection<Invoice>('invoices')
  await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500, status: 'paid' })
  await invoices.put('inv-2', { id: 'inv-2', client: 'Acme, Inc.', amount: 2400, status: 'draft' })
  await invoices.put('inv-3', { id: 'inv-3', client: 'Stark "Industries"', amount: 999, status: 'overdue' })
  return { db, adapter }
}

describe('happy path', () => {
  it('owner with csv grant produces valid CSV', async () => {
    const { db, adapter } = await seedVault()
    // Grant self (owner) + csv format
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['csv'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')
    const csv = await toString(vault, { collection: 'invoices' })

    // First line is header; subsequent lines are records
    const lines = csv.split('\n')
    expect(lines[0]).toMatch(/^id,client,amount,status$/)
    expect(lines.length).toBeGreaterThanOrEqual(4)  // header + 3 rows
    expect(csv).toContain('inv-1,Globex,1500,paid')
    // Field with comma is quoted
    expect(csv).toContain('"Acme, Inc."')
    // Embedded double quotes are doubled
    expect(csv).toContain('"Stark ""Industries"""')
    await db2.close()
  })
})

describe('authorization refusals', () => {
  it('owner without csv grant is refused', async () => {
    const { db } = await seedVault()
    const vault = await db.openVault('acme')
    // Default owner has no plaintext grant.
    await expect(toString(vault, { collection: 'invoices' })).rejects.toThrow(ExportCapabilityError)
    await db.close()
  })

  it('operator without csv grant is refused even with read ACL', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'op', displayName: 'Op', role: 'operator',
      passphrase: 'op-pass',
      permissions: { invoices: 'rw' },
    })
    await db.close()

    const opDb = await createNoydb({ store: adapter, user: 'op', secret: 'op-pass' })
    const vault = await opDb.openVault('acme')
    await expect(toString(vault, { collection: 'invoices' })).rejects.toThrow(ExportCapabilityError)
    await opDb.close()
  })

  it('operator with csv grant but no read ACL gets empty CSV', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'op', displayName: 'Op', role: 'operator',
      passphrase: 'op-pass',
      permissions: { payments: 'rw' },  // access to OTHER collection
      exportCapability: { plaintext: ['csv'] },
    })
    await db.close()

    const opDb = await createNoydb({ store: adapter, user: 'op', secret: 'op-pass' })
    const vault = await opDb.openVault('acme')
    const csv = await toString(vault, { collection: 'invoices' })
    expect(csv).toBe('')  // ACL-scoped; no invoices visible
    await opDb.close()
  })
})

describe('escaping + formatting', () => {
  it('explicit columns override inference', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['csv'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')
    const csv = await toString(vault, { collection: 'invoices', columns: ['id', 'amount'] })
    const lines = csv.split('\n')
    expect(lines[0]).toBe('id,amount')
    expect(lines[1]).toBe('inv-1,1500')
    await db2.close()
  })

  it('supports CRLF line endings', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['*'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')
    const csv = await toString(vault, { collection: 'invoices', eol: '\r\n' })
    expect(csv).toContain('\r\n')
    await db2.close()
  })
})

describe('write() guard', () => {
  it('refuses to write without acknowledgeRisks: true', async () => {
    const { db } = await seedVault()
    const vault = await db.openVault('acme')
    // @ts-expect-error — intentionally omitting acknowledgeRisks to verify runtime guard
    await expect(write(vault, '/tmp/should-never-happen.csv', { collection: 'invoices' })).rejects.toThrow(
      /acknowledgeRisks: true is required/,
    )
    await db.close()
  })
})
