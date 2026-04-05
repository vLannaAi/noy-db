import { describe, it, expect, beforeEach } from 'vitest'
import { runAdapterConformanceTests } from '@noydb/test-adapter-conformance'
import { browser } from '../src/index.js'

// Run full conformance suite with obfuscation enabled
runAdapterConformanceTests(
  'browser (localStorage + obfuscate)',
  async () => {
    localStorage.clear()
    return browser({ prefix: `obf-${Date.now()}`, backend: 'localStorage', obfuscate: true })
  },
  async () => {
    localStorage.clear()
  },
)

describe('obfuscation', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keys in localStorage are hashed, not readable', async () => {
    const adapter = browser({ prefix: 'test', backend: 'localStorage', obfuscate: true })

    await adapter.put('MyCompany', 'invoices', 'INV-001', {
      _noydb: 1, _v: 1, _ts: '2026-01-01', _iv: 'abc', _data: 'encrypted',
    })

    const keys = Object.keys(localStorage)
    for (const key of keys) {
      // Keys should NOT contain readable names
      expect(key).not.toContain('MyCompany')
      expect(key).not.toContain('invoices')
      expect(key).not.toContain('INV-001')
    }

    // But the adapter can still retrieve by original names
    const result = await adapter.get('MyCompany', 'invoices', 'INV-001')
    expect(result).not.toBeNull()
    expect(result?._data).toBe('encrypted')
  })

  it('list() returns original IDs despite obfuscated keys', async () => {
    const adapter = browser({ prefix: 'test', backend: 'localStorage', obfuscate: true })

    await adapter.put('C1', 'coll', 'id-alpha', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'a' })
    await adapter.put('C1', 'coll', 'id-beta', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'b' })

    const ids = await adapter.list('C1', 'coll')
    expect(ids.sort()).toEqual(['id-alpha', 'id-beta'])
  })

  it('loadAll() returns original collection and ID names', async () => {
    const adapter = browser({ prefix: 'test', backend: 'localStorage', obfuscate: true })

    await adapter.put('C1', 'invoices', 'inv-1', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'x' })
    await adapter.put('C1', 'payments', 'pay-1', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'y' })

    const snapshot = await adapter.loadAll('C1')
    expect(Object.keys(snapshot).sort()).toEqual(['invoices', 'payments'])
    expect(Object.keys(snapshot['invoices']!)).toEqual(['inv-1'])
    expect(Object.keys(snapshot['payments']!)).toEqual(['pay-1'])
  })
})
