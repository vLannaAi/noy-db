/**
 * Issue #308 — import-capability foundation tests.
 *
 * Mirrors `export-capability.test.ts` with the carve-out that import
 * is **default-closed for every role** (including owner) on both
 * plaintext and bundle tiers.
 *
 * Covers:
 *   - hasImportCapability plaintext — empty default, explicit grant,
 *     wildcard
 *   - hasImportCapability bundle — closed default for every role,
 *     explicit override
 *   - evaluateImportCapability — same logic without keyring
 *   - grant() persisting importCapability
 *   - loadKeyring() reconstituting importCapability
 *   - back-compat — legacy keyrings without the field still load
 *   - vault.assertCanImport / canImport gates
 *   - ImportCapabilityError shape
 */

import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import {
  ImportCapabilityError,
  evaluateImportCapability,
  hasImportCapability,
} from '../src/index.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { UnlockedKeyring } from '../src/team/keyring.js'

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

function fakeKeyring(role: UnlockedKeyring['role'], cap?: UnlockedKeyring['importCapability']): UnlockedKeyring {
  return {
    userId: 'test',
    displayName: 'Test',
    role,
    permissions: {},
    deks: new Map(),
    kek: {} as CryptoKey,
    salt: new Uint8Array(),
    ...(cap !== undefined && { importCapability: cap }),
  }
}

describe('hasImportCapability — plaintext tier', () => {
  it('defaults to closed for every role without a grant', () => {
    for (const role of ['owner', 'admin', 'operator', 'viewer', 'client'] as const) {
      const k = fakeKeyring(role)
      expect(hasImportCapability(k, 'plaintext', 'csv')).toBe(false)
      expect(hasImportCapability(k, 'plaintext', 'json')).toBe(false)
      expect(hasImportCapability(k, 'plaintext', 'ndjson')).toBe(false)
      expect(hasImportCapability(k, 'plaintext', 'zip')).toBe(false)
    }
  })

  it('allows only the granted format when a per-format allowlist is set', () => {
    const k = fakeKeyring('operator', { plaintext: ['csv', 'json'] })
    expect(hasImportCapability(k, 'plaintext', 'csv')).toBe(true)
    expect(hasImportCapability(k, 'plaintext', 'json')).toBe(true)
    expect(hasImportCapability(k, 'plaintext', 'ndjson')).toBe(false)
    expect(hasImportCapability(k, 'plaintext', 'zip')).toBe(false)
  })

  it('wildcard "*" allows every format', () => {
    const k = fakeKeyring('admin', { plaintext: ['*'] })
    expect(hasImportCapability(k, 'plaintext', 'csv')).toBe(true)
    expect(hasImportCapability(k, 'plaintext', 'json')).toBe(true)
    expect(hasImportCapability(k, 'plaintext', 'ndjson')).toBe(true)
    expect(hasImportCapability(k, 'plaintext', 'zip')).toBe(true)
  })

  it('empty plaintext array means no access (even for owner)', () => {
    const k = fakeKeyring('owner', { plaintext: [] })
    expect(hasImportCapability(k, 'plaintext', 'csv')).toBe(false)
  })
})

describe('hasImportCapability — bundle tier', () => {
  it('defaults to closed for every role (including owner)', () => {
    expect(hasImportCapability(fakeKeyring('owner'), 'bundle')).toBe(false)
    expect(hasImportCapability(fakeKeyring('admin'), 'bundle')).toBe(false)
    expect(hasImportCapability(fakeKeyring('operator'), 'bundle')).toBe(false)
    expect(hasImportCapability(fakeKeyring('viewer'), 'bundle')).toBe(false)
    expect(hasImportCapability(fakeKeyring('client'), 'bundle')).toBe(false)
  })

  it('only explicit bundle: true grants access', () => {
    expect(hasImportCapability(fakeKeyring('owner', { bundle: true }), 'bundle')).toBe(true)
    expect(hasImportCapability(fakeKeyring('client', { bundle: true }), 'bundle')).toBe(true)
  })

  it('explicit bundle: false denies (same as default)', () => {
    expect(hasImportCapability(fakeKeyring('owner', { bundle: false }), 'bundle')).toBe(false)
  })
})

describe('evaluateImportCapability — no-keyring variant', () => {
  it('mirrors hasImportCapability logic; role argument is ignored for bundle tier', () => {
    expect(evaluateImportCapability(undefined, 'operator', 'plaintext', 'csv')).toBe(false)
    expect(evaluateImportCapability({ plaintext: ['csv'] }, 'operator', 'plaintext', 'csv')).toBe(true)
    expect(evaluateImportCapability({ plaintext: ['*'] }, 'viewer', 'plaintext', 'json')).toBe(true)
    // bundle is closed regardless of role
    expect(evaluateImportCapability(undefined, 'owner', 'bundle')).toBe(false)
    expect(evaluateImportCapability(undefined, 'admin', 'bundle')).toBe(false)
    expect(evaluateImportCapability(undefined, 'client', 'bundle')).toBe(false)
    expect(evaluateImportCapability({ bundle: true }, 'client', 'bundle')).toBe(true)
    expect(evaluateImportCapability({ bundle: false }, 'owner', 'bundle')).toBe(false)
  })
})

describe('grant() persistence — importCapability round-trips via keyring file', () => {
  it('persists explicit import capability for a newly-granted operator', async () => {
    const adapter = memory()
    const ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    await ownerDb.openVault('acme')

    await ownerDb.grant('acme', {
      userId: 'op@test',
      displayName: 'Operator',
      role: 'operator',
      passphrase: 'op-pass',
      permissions: { invoices: 'rw' },
      importCapability: { plaintext: ['csv', 'json'], bundle: true },
    })
    await ownerDb.close()

    const opDb = await createNoydb({ store: adapter, user: 'op@test', secret: 'op-pass' })
    await opDb.openVault('acme')

    const internals = (opDb as unknown as { keyringCache: Map<string, UnlockedKeyring> })
    const opKeyring = internals.keyringCache.get('acme')!
    expect(opKeyring.importCapability).toEqual({ plaintext: ['csv', 'json'], bundle: true })
    expect(hasImportCapability(opKeyring, 'plaintext', 'csv')).toBe(true)
    expect(hasImportCapability(opKeyring, 'plaintext', 'ndjson')).toBe(false)
    expect(hasImportCapability(opKeyring, 'bundle')).toBe(true)
    await opDb.close()
  })

  it('legacy keyrings (no importCapability field) load default-closed', async () => {
    const adapter = memory()
    const ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    await ownerDb.openVault('acme')

    await ownerDb.grant('acme', {
      userId: 'op@test',
      displayName: 'Operator',
      role: 'operator',
      passphrase: 'op-pass',
      permissions: { invoices: 'rw' },
    })
    await ownerDb.close()

    const opDb = await createNoydb({ store: adapter, user: 'op@test', secret: 'op-pass' })
    await opDb.openVault('acme')

    const internals = (opDb as unknown as { keyringCache: Map<string, UnlockedKeyring> })
    const opKeyring = internals.keyringCache.get('acme')!
    expect(opKeyring.importCapability).toBeUndefined()
    expect(hasImportCapability(opKeyring, 'plaintext', 'csv')).toBe(false)
    expect(hasImportCapability(opKeyring, 'bundle')).toBe(false)
    await opDb.close()
  })

  it('owner keyring is default-closed too (no auto-grant for any tier)', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    await db.openVault('acme')

    const internals = (db as unknown as { keyringCache: Map<string, UnlockedKeyring> })
    const ownerKeyring = internals.keyringCache.get('acme')!
    expect(hasImportCapability(ownerKeyring, 'plaintext', 'csv')).toBe(false)
    expect(hasImportCapability(ownerKeyring, 'bundle')).toBe(false)
    await db.close()
  })
})

describe('vault.assertCanImport / canImport', () => {
  it('owner cannot import plaintext or bundle without a grant', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db.openVault('acme')
    expect(vault.canImport('plaintext', 'csv')).toBe(false)
    expect(vault.canImport('bundle')).toBe(false)
    expect(() => vault.assertCanImport('plaintext', 'csv')).toThrow(ImportCapabilityError)
    expect(() => vault.assertCanImport('bundle')).toThrow(ImportCapabilityError)
    await db.close()
  })

  it('operator with plaintext grant can import that format and only that format', async () => {
    const adapter = memory()
    const ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    await ownerDb.openVault('acme')
    await ownerDb.grant('acme', {
      userId: 'op@test', displayName: 'Operator', role: 'operator',
      passphrase: 'op-pass',
      permissions: { invoices: 'rw' },
      importCapability: { plaintext: ['csv'] },
    })
    await ownerDb.close()

    const opDb = await createNoydb({ store: adapter, user: 'op@test', secret: 'op-pass' })
    const vault = await opDb.openVault('acme')
    expect(vault.canImport('plaintext', 'csv')).toBe(true)
    expect(vault.canImport('plaintext', 'json')).toBe(false)
    expect(vault.canImport('bundle')).toBe(false)
    expect(() => vault.assertCanImport('plaintext', 'csv')).not.toThrow()
    expect(() => vault.assertCanImport('plaintext', 'json')).toThrow(ImportCapabilityError)
    expect(() => vault.assertCanImport('bundle')).toThrow(ImportCapabilityError)
    await opDb.close()
  })
})

describe('ImportCapabilityError', () => {
  it('carries tier + userId + format on plaintext variant', () => {
    const err = new ImportCapabilityError({
      tier: 'plaintext',
      userId: 'op@test',
      format: 'csv',
    })
    expect(err.tier).toBe('plaintext')
    expect(err.userId).toBe('op@test')
    expect(err.format).toBe('csv')
    expect(err.message).toMatch(/Import capability denied/)
    expect(err.message).toMatch(/csv/)
  })

  it('omits format on bundle variant', () => {
    const err = new ImportCapabilityError({ tier: 'bundle', userId: 'op@test' })
    expect(err.tier).toBe('bundle')
    expect(err.format).toBeUndefined()
    expect(err.message).toMatch(/encrypted-bundle import/)
  })
})
