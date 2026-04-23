import { describe, it, expect } from 'vitest'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { IDBFactory } from 'fake-indexeddb'
import { browserIdbStore } from '../src/index.js'

let counter = 0

// ─── Full conformance suite with obfuscation ───────────────────────────

runStoreConformanceTests(
  'store-browser-idb (obfuscate)',
  async () => {
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory()
    return browserIdbStore({ prefix: `obf-${++counter}`, obfuscate: true })
  },
  async () => {
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory()
  },
)

// ─── Obfuscated round-trip ─────────────────────────────────────────────

describe('obfuscation: round-trip', () => {
  it('list() returns original IDs despite obfuscated keys', async () => {
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory()
    const adapter = browserIdbStore({ prefix: `obf-rt-${++counter}`, obfuscate: true })

    await adapter.put('C1', 'coll', 'id-alpha', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'a' })
    await adapter.put('C1', 'coll', 'id-beta', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'b' })

    const ids = await adapter.list('C1', 'coll')
    expect(ids.sort()).toEqual(['id-alpha', 'id-beta'])
  })

  it('loadAll() returns original collection and ID names', async () => {
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory()
    const adapter = browserIdbStore({ prefix: `obf-la-${++counter}`, obfuscate: true })

    await adapter.put('C1', 'invoices', 'inv-1', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'x' })
    await adapter.put('C1', 'payments', 'pay-1', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'y' })

    const snapshot = await adapter.loadAll('C1')
    expect(Object.keys(snapshot).sort()).toEqual(['invoices', 'payments'])
    expect(Object.keys(snapshot['invoices']!)).toEqual(['inv-1'])
    expect(Object.keys(snapshot['payments']!)).toEqual(['pay-1'])
  })

  it('loadAll excludes _keyring collections', async () => {
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory()
    const adapter = browserIdbStore({ prefix: `obf-kr-${++counter}`, obfuscate: true })

    await adapter.put('C1', 'invoices', 'inv-1', { _noydb: 1, _v: 1, _ts: '', _iv: 'iv', _data: 'data' })
    await adapter.put('C1', '_keyring', 'user-01', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: '{}' })

    const snapshot = await adapter.loadAll('C1')
    expect(snapshot['invoices']).toBeDefined()
    expect(snapshot['_keyring']).toBeUndefined()
  })
})
