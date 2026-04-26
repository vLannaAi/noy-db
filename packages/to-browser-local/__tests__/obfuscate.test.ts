import { describe, it, expect, beforeEach } from 'vitest'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { browserLocalStore } from '../src/index.js'

// ─── Full conformance suite with obfuscation ───────────────────────────

runStoreConformanceTests(
  'store-browser-local (obfuscate)',
  async () => {
    localStorage.clear()
    return browserLocalStore({ prefix: `obf-${Date.now()}`, obfuscate: true })
  },
  async () => {
    localStorage.clear()
  },
)

// ─── Key opacity ───────────────────────────────────────────────────────

describe('obfuscation: key opacity', () => {
  beforeEach(() => { localStorage.clear() })

  it('localStorage keys do not contain plaintext vault, collection, or ID', async () => {
    const adapter = browserLocalStore({ prefix: 'test', obfuscate: true })

    await adapter.put('MyCompany', 'invoices', 'INV-001', {
      _noydb: 1, _v: 1, _ts: '2026-01-01', _iv: 'abc', _data: 'encrypted',
    })

    const keys = Object.keys(localStorage)
    for (const key of keys) {
      expect(key).not.toContain('MyCompany')
      expect(key).not.toContain('invoices')
      expect(key).not.toContain('INV-001')
    }
  })

  it('list() returns original IDs despite obfuscated keys', async () => {
    const adapter = browserLocalStore({ prefix: 'test', obfuscate: true })

    await adapter.put('C1', 'coll', 'id-alpha', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'a' })
    await adapter.put('C1', 'coll', 'id-beta', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'b' })

    const ids = await adapter.list('C1', 'coll')
    expect(ids.sort()).toEqual(['id-alpha', 'id-beta'])
  })

  it('loadAll() returns original collection and ID names', async () => {
    const adapter = browserLocalStore({ prefix: 'test', obfuscate: true })

    await adapter.put('C1', 'invoices', 'inv-1', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'x' })
    await adapter.put('C1', 'payments', 'pay-1', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: 'y' })

    const snapshot = await adapter.loadAll('C1')
    expect(Object.keys(snapshot).sort()).toEqual(['invoices', 'payments'])
    expect(Object.keys(snapshot['invoices']!)).toEqual(['inv-1'])
    expect(Object.keys(snapshot['payments']!)).toEqual(['pay-1'])
  })
})

// ─── Value opacity ─────────────────────────────────────────────────────

describe('obfuscation: value opacity', () => {
  beforeEach(() => { localStorage.clear() })

  it('stored value does not contain plaintext collection name', async () => {
    const adapter = browserLocalStore({ prefix: 'test', obfuscate: true })

    await adapter.put('C1', 'invoices', 'INV-001', {
      _noydb: 1, _v: 1, _ts: '2026-01-01', _iv: 'iv123', _data: 'cipher123',
    })

    for (let i = 0; i < localStorage.length; i++) {
      const raw = localStorage.getItem(localStorage.key(i)!)!
      expect(raw).not.toContain('"invoices"')
      expect(raw).not.toContain('"INV-001"')
    }
  })

  it('stored keyring value does not contain plaintext user ID or collection names', async () => {
    const adapter = browserLocalStore({ prefix: 'test', obfuscate: true })

    await adapter.put('C1', '_keyring', 'owner-secret', {
      _noydb: 1, _v: 1, _ts: '',
      _iv: '',
      _data: '{"user_id":"owner-secret","deks":{"invoices":"wrapped-key"}}',
    })

    for (let i = 0; i < localStorage.length; i++) {
      const raw = localStorage.getItem(localStorage.key(i)!)!
      expect(raw).not.toContain('owner-secret')
      expect(raw).not.toContain('"invoices"')
      expect(raw).not.toContain('wrapped-key')
    }

    const result = await adapter.get('C1', '_keyring', 'owner-secret')
    expect(result?._data).toContain('owner-secret')
    expect(result?._data).toContain('invoices')
  })

  it('stored value does not contain plaintext record ID', async () => {
    const adapter = browserLocalStore({ prefix: 'test', obfuscate: true })

    await adapter.put('C1', 'reports', 'RPT-SECRET-42', {
      _noydb: 1, _v: 1, _ts: '', _iv: 'iv', _data: 'data',
    })

    for (let i = 0; i < localStorage.length; i++) {
      const raw = localStorage.getItem(localStorage.key(i)!)!
      expect(raw).not.toContain('RPT-SECRET-42')
      expect(raw).not.toContain('reports')
    }
  })
})

// ─── Multi-instance isolation ──────────────────────────────────────────

describe('obfuscation: multi-instance isolation', () => {
  beforeEach(() => { localStorage.clear() })

  it('two adapter instances with different prefixes do not corrupt each other', async () => {
    const adapterA = browserLocalStore({ prefix: 'app-a', obfuscate: true })
    const adapterB = browserLocalStore({ prefix: 'app-b', obfuscate: true })

    await adapterA.put('C1', 'items', 'item-1', {
      _noydb: 1, _v: 1, _ts: '', _iv: 'ivA', _data: 'dataA',
    })

    await adapterB.put('C1', 'items', 'item-1', {
      _noydb: 1, _v: 1, _ts: '', _iv: 'ivB', _data: 'dataB',
    })

    const resultA = await adapterA.get('C1', 'items', 'item-1')
    const resultB = await adapterB.get('C1', 'items', 'item-1')

    expect(resultA?._data).toBe('dataA')
    expect(resultB?._data).toBe('dataB')

    const idsA = await adapterA.list('C1', 'items')
    const idsB = await adapterB.list('C1', 'items')
    expect(idsA).toEqual(['item-1'])
    expect(idsB).toEqual(['item-1'])
  })
})

// ─── loadAll filtering ─────────────────────────────────────────────────

describe('obfuscation: loadAll filtering', () => {
  beforeEach(() => { localStorage.clear() })

  it('loadAll excludes _keyring even when keys are obfuscated', async () => {
    const adapter = browserLocalStore({ prefix: 'test', obfuscate: true })

    await adapter.put('C1', 'invoices', 'inv-1', { _noydb: 1, _v: 1, _ts: '', _iv: 'iv', _data: 'data' })
    await adapter.put('C1', '_keyring', 'user-01', { _noydb: 1, _v: 1, _ts: '', _iv: '', _data: '{}' })

    const snapshot = await adapter.loadAll('C1')
    expect(snapshot['invoices']).toBeDefined()
    expect(snapshot['_keyring']).toBeUndefined()
  })

  it('unrelated localStorage keys are ignored', async () => {
    localStorage.setItem('unrelated-key', 'unrelated-value')
    localStorage.setItem('another-app:data', '{"foo": "bar"}')

    const adapter = browserLocalStore({ prefix: 'test', obfuscate: true })
    await adapter.put('C1', 'items', 'id-1', { _noydb: 1, _v: 1, _ts: '', _iv: 'iv', _data: 'data' })

    const ids = await adapter.list('C1', 'items')
    expect(ids).toEqual(['id-1'])

    const snapshot = await adapter.loadAll('C1')
    expect(Object.keys(snapshot)).toEqual(['items'])
  })
})
