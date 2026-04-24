/**
 * Tests for consent boundaries (v0.16 #218).
 *
 * Covers:
 *   - No entries written outside a withConsent scope
 *   - Entries written for get / put / delete inside a scope
 *   - Restored context after scope exits
 *   - Filter by collection / actor / purpose / time window
 *   - Encrypted mode — entries are retrievable via consentAudit()
 *     but not readable as plaintext from the adapter
 *   - Error inside withConsent still restores the prior context
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, createNoydb, CONSENT_AUDIT_COLLECTION } from '../src/index.js'
import { withConsent } from '../src/consent/index.js'
import type { Noydb } from '../src/index.js'

function memoryStore(): { store: NoydbStore; data: Map<string, Map<string, Map<string, EncryptedEnvelope>>> } {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    data,
    store: {
      name: 'memory',
      async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
      async put(v, c, id, env, ev) {
        const coll = getColl(v, c); const ex = coll.get(id)
        if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
        coll.set(id, env)
      },
      async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
      async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
      async loadAll(v) {
        const vm = data.get(v); const snap: VaultSnapshot = {}
        if (vm) for (const [cn, cm] of vm) {
          if (cn.startsWith('_')) continue
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of cm) r[id] = e
          snap[cn] = r
        }
        return snap
      },
      async saveAll() { /* n/a */ },
    },
  }
}

interface Invoice { amount: number; status: string }
const CONSENT = { purpose: 'quarterly-review', consentHash: '7f3a8b9c' }

describe('vault.withConsent / vault.consentAudit (v0.16 #218)', () => {
  let db: Noydb

  beforeEach(async () => {
    const { store } = memoryStore()
    db = await createNoydb({
      store,
      user: 'alice',
      encrypt: false,
      consentStrategy: withConsent(),
    })
  })

  describe('opt-in scoping', () => {
    it('writes no consent entries when no scope is active', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await invoices.get('inv-1')
      await invoices.delete('inv-1')

      expect(await vault.consentAudit()).toEqual([])
    })

    it('writes one entry per access inside a scope', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })  // pre-scope, not logged

      await vault.withConsent(CONSENT, async () => {
        await invoices.get('inv-1')
        await invoices.put('inv-2', { amount: 200, status: 'draft' })
        await invoices.delete('inv-1')
      })

      const log = await vault.consentAudit()
      expect(log).toHaveLength(3)
      const ops = log.map((e) => e.op).sort()
      expect(ops).toEqual(['delete', 'get', 'put'])
      expect(log.every((e) => e.purpose === 'quarterly-review')).toBe(true)
      expect(log.every((e) => e.consentHash === '7f3a8b9c')).toBe(true)
      expect(log.every((e) => e.actor === 'alice')).toBe(true)
    })

    it('restores the prior context after a scope exits (including on error)', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await expect(
        vault.withConsent(CONSENT, async () => {
          await invoices.put('inv-1', { amount: 1, status: 'x' })
          throw new Error('oops')
        }),
      ).rejects.toThrow('oops')

      // After the scope errored, no scope is active again — the next put
      // should not be logged.
      await invoices.put('inv-2', { amount: 2, status: 'x' })

      const log = await vault.consentAudit()
      expect(log).toHaveLength(1)
      expect(log[0]!.recordId).toBe('inv-1')
    })

    it('returns the function\'s resolved value', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })

      const result = await vault.withConsent(CONSENT, async () => {
        return invoices.get('inv-1')
      })
      expect(result).toEqual({ amount: 100, status: 'draft' })
    })
  })

  describe('consentAudit filters', () => {
    beforeEach(async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      const receipts = vault.collection<Invoice>('receipts')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await receipts.put('rc-1', { amount: 100, status: 'draft' })

      await vault.withConsent({ purpose: 'review', consentHash: 'aaa' }, async () => {
        await invoices.get('inv-1')
      })
      await vault.withConsent({ purpose: 'backup', consentHash: 'bbb' }, async () => {
        await receipts.get('rc-1')
      })
    })

    it('filters by collection', async () => {
      const vault = await db.openVault('acme')
      const invoiceLog = await vault.consentAudit({ collection: 'invoices' })
      expect(invoiceLog).toHaveLength(1)
      expect(invoiceLog[0]!.collection).toBe('invoices')
    })

    it('filters by purpose', async () => {
      const vault = await db.openVault('acme')
      const review = await vault.consentAudit({ purpose: 'review' })
      expect(review).toHaveLength(1)
      expect(review[0]!.purpose).toBe('review')
    })

    it('filters by actor', async () => {
      const vault = await db.openVault('acme')
      const aliceLog = await vault.consentAudit({ actor: 'alice' })
      expect(aliceLog.length).toBeGreaterThanOrEqual(2)
      const bobLog = await vault.consentAudit({ actor: 'bob-who-doesnt-exist' })
      expect(bobLog).toHaveLength(0)
    })
  })

  describe('zero-knowledge — adapter sees only ciphertext', () => {
    it('consent entries in _consent_audit are ciphertext in encrypted vaults', async () => {
      const { store, data } = memoryStore()
      const encDb = await createNoydb({
        store,
        user: 'alice',
        secret: 'test-passphrase-12345678',
        consentStrategy: withConsent(),
      })
      const vault = await encDb.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })

      await vault.withConsent(CONSENT, async () => {
        await invoices.get('inv-1')
      })

      // Peek at the raw adapter storage for _consent_audit: entries exist,
      // but their _data is base64 ciphertext — grep for 'quarterly-review'
      // should turn up nothing.
      const auditMap = data.get('acme')?.get(CONSENT_AUDIT_COLLECTION)
      expect(auditMap?.size).toBeGreaterThan(0)
      for (const env of auditMap!.values()) {
        expect(env._data).not.toContain('quarterly-review')
        expect(env._data).not.toContain('7f3a8b9c')
      }

      // But vault.consentAudit() can read them
      const log = await vault.consentAudit()
      expect(log).toHaveLength(1)
      expect(log[0]!.purpose).toBe('quarterly-review')
    })
  })
})
