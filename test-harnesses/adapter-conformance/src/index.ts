import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

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
export function runStoreConformanceTests(
  name: string,
  factory: () => Promise<NoydbStore>,
  cleanup?: () => Promise<void>,
): void {
  describe(`Adapter Conformance: ${name}`, () => {
    let adapter: NoydbStore

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

      it('round-trips a delete-marker envelope (_del) byte-identically (#589)', async () => {
        const marker = { _noydb: 1 as const, _v: 6, _ts: new Date().toISOString(), _iv: '', _data: '', _del: true as const }
        await adapter.put('comp1', 'coll1', 'id1', marker)
        const result = await adapter.get('comp1', 'coll1', 'id1')
        expect(result).toEqual(marker)          // _del must survive — a store that drops it breaks #589 convergence
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

    // ─── Optional capability surface (#845) ────────────────────────
    //
    // The six-method core is mandatory; `ping` / `listVaults` / `tx` /
    // `listPage` / `getStoreTime` are not. Stores diverge exactly here, and
    // until now the harness never looked — which is how `@noy-db/to-memory`
    // shipped a working `tx()` whose `txAtomic` capability was never declared,
    // while its JSDoc claimed otherwise. The hub reads that bit to decide
    // whether to delegate, so the implementation would simply have been
    // skipped.
    //
    // Each block runs only when the store implements the method, so this adds
    // no requirement. The load-bearing rule is the pairing assertion:
    // IMPLEMENTED ⇒ DECLARED. That is what catches this whole class of drift,
    // for every store present and future.

    describe('optional capabilities', () => {
      it('declares txAtomic if and only if tx() is implemented', async () => {
        const implemented = typeof adapter.tx === 'function'
        const declared = adapter.capabilities?.txAtomic === true
        expect(
          declared,
          implemented
            ? 'store implements tx() but does not declare capabilities.txAtomic — ' +
              'the hub gates delegation on that bit, so the implementation would be skipped'
            : 'store declares capabilities.txAtomic but has no tx() to delegate to',
        ).toBe(implemented)
      })

      it('ping() resolves without throwing, when implemented', async () => {
        if (typeof adapter.ping !== 'function') return
        await expect(adapter.ping()).resolves.not.toThrow()
      })

      it('listVaults() reports a vault that has been written to, when implemented', async () => {
        if (typeof adapter.listVaults !== 'function') return
        await adapter.put('comp-lv', 'coll1', 'id1', makeEnvelope(1))
        const vaults = await adapter.listVaults()
        expect(vaults).toContain('comp-lv')
      })

      it('tx() applies every op, when implemented', async () => {
        if (typeof adapter.tx !== 'function') return
        await adapter.tx([
          { type: 'put', vault: 'comp-tx', collection: 'coll1', id: 'a', envelope: makeEnvelope(1, 'a') },
          { type: 'put', vault: 'comp-tx', collection: 'coll1', id: 'b', envelope: makeEnvelope(1, 'b') },
        ])
        expect(await adapter.get('comp-tx', 'coll1', 'a')).not.toBeNull()
        expect(await adapter.get('comp-tx', 'coll1', 'b')).not.toBeNull()
      })

      it('getStoreTime() returns a non-decreasing interval, when implemented', async () => {
        if (typeof adapter.getStoreTime !== 'function') return
        const a = await adapter.getStoreTime()
        const b = await adapter.getStoreTime()
        expect(a.earliest).toBeLessThanOrEqual(a.latest)
        expect(b.earliest).toBeGreaterThanOrEqual(a.earliest)
      })

      it('listPage() paginates and terminates, when implemented', async () => {
        if (typeof adapter.listPage !== 'function') return
        for (let i = 0; i < 3; i++) {
          await adapter.put('comp-lp', 'coll1', `id${i}`, makeEnvelope(1))
        }
        const first = await adapter.listPage('comp-lp', 'coll1', undefined, 2)
        expect(first.items.length).toBeLessThanOrEqual(2)
        // A cursor must eventually run out — no infinite paging.
        let cursor = first.nextCursor
        let guard = 0
        while (cursor && guard++ < 10) {
          cursor = (await adapter.listPage('comp-lp', 'coll1', cursor, 2)).nextCursor
        }
        expect(cursor).toBeFalsy()
      })
    })
  })
}
