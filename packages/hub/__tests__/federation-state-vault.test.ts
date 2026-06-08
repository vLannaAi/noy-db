import { describe, it, expect } from 'vitest'
import { captureBlueprint, fingerprintBlueprint } from '../src/federation/schema-manifest.js'
import type { Vault } from '../src/vault.js'
import { ReservedVaultNameError } from '../src/errors.js'

describe('captureBlueprint', () => {
  it('records declared collections + indexes deterministically', () => {
    const configure = (v: Vault) => {
      v.collection('invoices', { indexes: ['buyerId'] })
      v.collection('ledger')
    }
    const bp = captureBlueprint(configure)
    expect(bp.collections).toEqual(['invoices', 'ledger'])
    expect(bp.indexes.invoices).toEqual(['buyerId'])
  })

  it('produces a stable fingerprint across two runs', async () => {
    const configure = (v: Vault) => { v.collection('a', { indexes: ['x'] }) }
    const f1 = await fingerprintBlueprint(captureBlueprint(configure))
    const f2 = await fingerprintBlueprint(captureBlueprint(configure))
    expect(f1).toBe(f2)
    expect(f1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes the fingerprint when an index is added', async () => {
    const a = (v: Vault) => { v.collection('a') }
    const b = (v: Vault) => { v.collection('a', { indexes: ['x'] }) }
    const fa = await fingerprintBlueprint(captureBlueprint(a))
    const fb = await fingerprintBlueprint(captureBlueprint(b))
    expect(fa).not.toBe(fb)
  })

  it('changes the fingerprint when persistJsonSchema is declared', async () => {
    const a = (v: Vault) => { v.collection('a') }
    const b = (v: Vault) => { v.collection('a', { persistJsonSchema: true }) }
    const bp = captureBlueprint(b)
    expect(bp.persistJsonSchema).toEqual(['a'])
    const fa = await fingerprintBlueprint(captureBlueprint(a))
    const fb = await fingerprintBlueprint(bp)
    expect(fa).not.toBe(fb)
  })

  it('does NOT change the fingerprint when only a validator changes (documented boundary)', async () => {
    const a = (v: Vault) => { v.collection('a', { schema: { '~standard': { version: 1, vendor: 'z', validate: (x: unknown) => ({ value: x }) } } } as never) }
    const b = (v: Vault) => { v.collection('a', { schema: { '~standard': { version: 1, vendor: 'z', validate: (_x: unknown) => ({ value: 42 }) } } } as never) }
    const fa = await fingerprintBlueprint(captureBlueprint(a))
    const fb = await fingerprintBlueprint(captureBlueprint(b))
    expect(fa).toBe(fb)
  })
})

describe('ReservedVaultNameError', () => {
  it('carries the offending name', () => {
    const e = new ReservedVaultNameError('__noydb_state__')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ReservedVaultNameError')
    expect(e.message).toContain('__noydb_state__')
  })
})
