import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import type { NoydbAdapter, EncryptedEnvelope } from '@noy-db/core'
import { ConflictError } from '@noy-db/core'

function makeEnvelope(version: number, data = 'test-data'): EncryptedEnvelope {
  return {
    _noydb: 1,
    _v: version,
    _ts: new Date().toISOString(),
    _iv: 'dGVzdC1pdi0xMjM0', // base64 of "test-iv-1234"
    _data: Buffer.from(data).toString('base64'),
  }
}

/**
 * Parameterized adapter conformance test suite.
 * Every NOYDB adapter must pass all of these tests.
 */
export function runAdapterConformanceTests(
  name: string,
  factory: () => Promise<NoydbAdapter>,
  cleanup?: () => Promise<void>,
): void {
  describe(`Adapter Conformance: ${name}`, () => {
    let adapter: NoydbAdapter

    beforeEach(async () => {
      adapter = await factory()
    })

    afterAll(async () => {
      await cleanup?.()
    })

    // ─── Basic CRUD ────────────────────────────────────────────────

    describe('basic CRUD', () => {
      it('put + get returns the same envelope', async () => {
        const envelope = makeEnvelope(1)
        await adapter.put('comp1', 'coll1', 'id1', envelope)
        const result = await adapter.get('comp1', 'coll1', 'id1')
        expect(result).toEqual(envelope)
      })

      it('get returns null for non-existent record', async () => {
        const result = await adapter.get('comp1', 'coll1', 'nonexistent')
        expect(result).toBeNull()
      })

      it('put overwrites existing record', async () => {
        await adapter.put('comp1', 'coll1', 'id1', makeEnvelope(1, 'first'))
        const updated = makeEnvelope(2, 'second')
        await adapter.put('comp1', 'coll1', 'id1', updated)
        const result = await adapter.get('comp1', 'coll1', 'id1')
        expect(result).toEqual(updated)
      })

      it('delete removes a record', async () => {
        await adapter.put('comp1', 'coll1', 'id1', makeEnvelope(1))
        await adapter.delete('comp1', 'coll1', 'id1')
        const result = await adapter.get('comp1', 'coll1', 'id1')
        expect(result).toBeNull()
      })

      it('delete on non-existent record does not throw', async () => {
        await expect(adapter.delete('comp1', 'coll1', 'nonexistent')).resolves.not.toThrow()
      })

      it('list returns all IDs in a collection', async () => {
        await adapter.put('comp1', 'coll1', 'a', makeEnvelope(1))
        await adapter.put('comp1', 'coll1', 'b', makeEnvelope(1))
        await adapter.put('comp1', 'coll1', 'c', makeEnvelope(1))
        const ids = await adapter.list('comp1', 'coll1')
        expect(ids.sort()).toEqual(['a', 'b', 'c'])
      })

      it('list returns empty array for empty collection', async () => {
        const ids = await adapter.list('comp1', 'empty-coll')
        expect(ids).toEqual([])
      })
    })

    // ─── Optimistic Concurrency ────────────────────────────────────

    describe('optimistic concurrency', () => {
      it('put with correct expectedVersion succeeds', async () => {
        await adapter.put('comp1', 'coll1', 'id1', makeEnvelope(1))
        await expect(
          adapter.put('comp1', 'coll1', 'id1', makeEnvelope(2), 1),
        ).resolves.not.toThrow()
      })

      it('put with wrong expectedVersion throws ConflictError', async () => {
        await adapter.put('comp1', 'coll1', 'id1', makeEnvelope(3))
        await expect(
          adapter.put('comp1', 'coll1', 'id1', makeEnvelope(4), 1),
        ).rejects.toThrow(ConflictError)
      })

      it('put without expectedVersion always succeeds (upsert)', async () => {
        await adapter.put('comp1', 'coll1', 'id1', makeEnvelope(5))
        await expect(
          adapter.put('comp1', 'coll1', 'id1', makeEnvelope(6)),
        ).resolves.not.toThrow()
      })
    })

    // ─── Bulk Operations ───────────────────────────────────────────

    describe('bulk operations', () => {
      it('loadAll returns all collections and records', async () => {
        await adapter.put('comp1', 'invoices', 'inv-1', makeEnvelope(1, 'inv1'))
        await adapter.put('comp1', 'invoices', 'inv-2', makeEnvelope(1, 'inv2'))
        await adapter.put('comp1', 'payments', 'pay-1', makeEnvelope(1, 'pay1'))

        const snapshot = await adapter.loadAll('comp1')
        expect(Object.keys(snapshot).sort()).toEqual(['invoices', 'payments'])
        expect(Object.keys(snapshot['invoices']!).sort()).toEqual(['inv-1', 'inv-2'])
        expect(Object.keys(snapshot['payments']!)).toEqual(['pay-1'])
      })

      it('loadAll returns empty snapshot for empty compartment', async () => {
        const snapshot = await adapter.loadAll('empty-comp')
        expect(snapshot).toEqual({})
      })

      it('saveAll writes all collections', async () => {
        const data = {
          invoices: {
            'inv-1': makeEnvelope(1, 'saved-inv1'),
          },
          payments: {
            'pay-1': makeEnvelope(1, 'saved-pay1'),
          },
        }
        await adapter.saveAll('comp1', data)

        const inv = await adapter.get('comp1', 'invoices', 'inv-1')
        expect(inv?._data).toBe(Buffer.from('saved-inv1').toString('base64'))

        const pay = await adapter.get('comp1', 'payments', 'pay-1')
        expect(pay?._data).toBe(Buffer.from('saved-pay1').toString('base64'))
      })

      it('saveAll followed by loadAll round-trips correctly', async () => {
        const data = {
          coll1: { 'r1': makeEnvelope(1, 'data1'), 'r2': makeEnvelope(2, 'data2') },
          coll2: { 'r3': makeEnvelope(1, 'data3') },
        }
        await adapter.saveAll('rt-comp', data)
        const loaded = await adapter.loadAll('rt-comp')
        expect(loaded).toEqual(data)
      })
    })

    // ─── Isolation ─────────────────────────────────────────────────

    describe('isolation', () => {
      it('records in different compartments are isolated', async () => {
        await adapter.put('compA', 'coll1', 'id1', makeEnvelope(1, 'A'))
        await adapter.put('compB', 'coll1', 'id1', makeEnvelope(1, 'B'))

        const a = await adapter.get('compA', 'coll1', 'id1')
        const b = await adapter.get('compB', 'coll1', 'id1')
        expect(a?._data).not.toBe(b?._data)
      })

      it('records in different collections are isolated', async () => {
        await adapter.put('comp1', 'collA', 'id1', makeEnvelope(1, 'A'))
        await adapter.put('comp1', 'collB', 'id1', makeEnvelope(1, 'B'))

        const a = await adapter.get('comp1', 'collA', 'id1')
        const b = await adapter.get('comp1', 'collB', 'id1')
        expect(a?._data).not.toBe(b?._data)
      })

      it('operations on one collection do not affect another', async () => {
        await adapter.put('comp1', 'coll1', 'id1', makeEnvelope(1))
        await adapter.put('comp1', 'coll2', 'id1', makeEnvelope(1))
        await adapter.delete('comp1', 'coll1', 'id1')

        const deleted = await adapter.get('comp1', 'coll1', 'id1')
        const intact = await adapter.get('comp1', 'coll2', 'id1')
        expect(deleted).toBeNull()
        expect(intact).not.toBeNull()
      })
    })

    // ─── Edge Cases ────────────────────────────────────────────────

    describe('edge cases', () => {
      it('handles record IDs with Unicode / Thai characters', async () => {
        const id = 'บริษัท-ABC-001'
        await adapter.put('comp1', 'coll1', id, makeEnvelope(1))
        const result = await adapter.get('comp1', 'coll1', id)
        expect(result).not.toBeNull()
        const ids = await adapter.list('comp1', 'coll1')
        expect(ids).toContain(id)
      })

      it('handles large envelopes (1MB+ _data field)', async () => {
        const largeData = 'x'.repeat(1_000_000)
        const envelope = makeEnvelope(1, largeData)
        await adapter.put('comp1', 'coll1', 'large', envelope)
        const result = await adapter.get('comp1', 'coll1', 'large')
        expect(result?._data).toBe(Buffer.from(largeData).toString('base64'))
      })

      it('handles IDs with special characters', async () => {
        const ids = ['with spaces', 'with.dots', 'with-dashes', 'with_underscores', 'MiXeD.CaSe-123']
        for (const id of ids) {
          await adapter.put('comp1', 'coll1', id, makeEnvelope(1, id))
        }
        const listed = await adapter.list('comp1', 'coll1')
        for (const id of ids) {
          expect(listed).toContain(id)
        }
      })

      it('handles rapid sequential writes', async () => {
        const promises = Array.from({ length: 100 }, (_, i) =>
          adapter.put('comp1', 'coll1', `rapid-${i}`, makeEnvelope(1, `data-${i}`)),
        )
        await Promise.all(promises)
        const ids = await adapter.list('comp1', 'coll1')
        expect(ids.length).toBe(100)
      })

      it('handles empty string values in envelope fields', async () => {
        const envelope: EncryptedEnvelope = {
          _noydb: 1,
          _v: 1,
          _ts: new Date().toISOString(),
          _iv: '',
          _data: '',
        }
        await adapter.put('comp1', 'coll1', 'empty', envelope)
        const result = await adapter.get('comp1', 'coll1', 'empty')
        expect(result?._iv).toBe('')
        expect(result?._data).toBe('')
      })
    })

    // ─── Internal Collection Filtering ─────────────────────────────

    describe('internal collection filtering', () => {
      it('loadAll excludes _keyring collection', async () => {
        await adapter.put('comp1', 'invoices', 'inv-1', makeEnvelope(1, 'record'))
        await adapter.put('comp1', '_keyring', 'user-01', makeEnvelope(1, 'keyring'))
        const snapshot = await adapter.loadAll('comp1')
        expect(snapshot['invoices']).toBeDefined()
        expect(snapshot['_keyring']).toBeUndefined()
      })

      it('loadAll excludes _sync collection', async () => {
        await adapter.put('comp1', 'invoices', 'inv-1', makeEnvelope(1, 'record'))
        await adapter.put('comp1', '_sync', 'meta', makeEnvelope(1, 'sync'))
        const snapshot = await adapter.loadAll('comp1')
        expect(snapshot['invoices']).toBeDefined()
        expect(snapshot['_sync']).toBeUndefined()
      })

      it('get/put/delete still work on _keyring collection directly', async () => {
        await adapter.put('comp1', '_keyring', 'user-01', makeEnvelope(1, 'keyring'))
        const result = await adapter.get('comp1', '_keyring', 'user-01')
        expect(result).not.toBeNull()
        await adapter.delete('comp1', '_keyring', 'user-01')
        const deleted = await adapter.get('comp1', '_keyring', 'user-01')
        expect(deleted).toBeNull()
      })
    })
  })
}
