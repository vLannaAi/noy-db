/**
 * RFC #249 — capability-bit foundation tests.
 *
 * Covers:
 *   - hasExportCapability plaintext — empty default, explicit grant,
 *     per-format + wildcard allowlists
 *   - hasExportCapability bundle — role-based default (owner/admin on,
 *     others off), explicit override
 *   - evaluateExportCapability — same logic without requiring a keyring
 *   - grant() persisting exportCapability into the keyring file
 *   - loadKeyring() reconstituting exportCapability
 *   - back-compat — legacy keyrings without the field still load
 *   - ExportCapabilityError shape
 */

import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import {
  ExportCapabilityError,
  evaluateExportCapability,
  hasExportCapability,
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

function fakeKeyring(role: UnlockedKeyring['role'], cap?: UnlockedKeyring['exportCapability']): UnlockedKeyring {
  return {
    userId: 'test',
    displayName: 'Test',
    role,
    permissions: {},
    deks: new Map(),
    kek: {} as CryptoKey,
    salt: new Uint8Array(),
    ...(cap !== undefined && { exportCapability: cap }),
  }
}

describe('hasExportCapability — plaintext tier', () => {
  it('defaults to empty (no format) for every role without a grant', () => {
    for (const role of ['owner', 'admin', 'operator', 'viewer', 'client'] as const) {
      const k = fakeKeyring(role)
      expect(hasExportCapability(k, 'plaintext', 'xlsx')).toBe(false)
      expect(hasExportCapability(k, 'plaintext', 'csv')).toBe(false)
      expect(hasExportCapability(k, 'plaintext', 'json')).toBe(false)
    }
  })

  it('allows only the granted format when a per-format allowlist is set', () => {
    const k = fakeKeyring('operator', { plaintext: ['xlsx', 'csv'] })
    expect(hasExportCapability(k, 'plaintext', 'xlsx')).toBe(true)
    expect(hasExportCapability(k, 'plaintext', 'csv')).toBe(true)
    expect(hasExportCapability(k, 'plaintext', 'sql')).toBe(false)
    expect(hasExportCapability(k, 'plaintext', 'pdf')).toBe(false)
  })

  it('wildcard "*" allows every format', () => {
    const k = fakeKeyring('admin', { plaintext: ['*'] })
    expect(hasExportCapability(k, 'plaintext', 'xlsx')).toBe(true)
    expect(hasExportCapability(k, 'plaintext', 'json')).toBe(true)
    expect(hasExportCapability(k, 'plaintext', 'blob')).toBe(true)
    expect(hasExportCapability(k, 'plaintext', 'zip')).toBe(true)
  })

  it('empty plaintext array means no access (even for owner)', () => {
    const k = fakeKeyring('owner', { plaintext: [] })
    expect(hasExportCapability(k, 'plaintext', 'xlsx')).toBe(false)
  })
})

describe('hasExportCapability — bundle tier', () => {
  it('defaults to true for owner and admin (backup happy path)', () => {
    expect(hasExportCapability(fakeKeyring('owner'), 'bundle')).toBe(true)
    expect(hasExportCapability(fakeKeyring('admin'), 'bundle')).toBe(true)
  })

  it('defaults to false for operator / viewer / client', () => {
    expect(hasExportCapability(fakeKeyring('operator'), 'bundle')).toBe(false)
    expect(hasExportCapability(fakeKeyring('viewer'), 'bundle')).toBe(false)
    expect(hasExportCapability(fakeKeyring('client'), 'bundle')).toBe(false)
  })

  it('explicit bundle: true overrides default for non-admin roles', () => {
    const k = fakeKeyring('operator', { bundle: true })
    expect(hasExportCapability(k, 'bundle')).toBe(true)
  })

  it('explicit bundle: false overrides default for owner/admin', () => {
    const owner = fakeKeyring('owner', { bundle: false })
    const admin = fakeKeyring('admin', { bundle: false })
    expect(hasExportCapability(owner, 'bundle')).toBe(false)
    expect(hasExportCapability(admin, 'bundle')).toBe(false)
  })
})

describe('evaluateExportCapability — no-keyring variant', () => {
  it('mirrors hasExportCapability logic', () => {
    expect(evaluateExportCapability(undefined, 'operator', 'plaintext', 'xlsx')).toBe(false)
    expect(evaluateExportCapability({ plaintext: ['xlsx'] }, 'operator', 'plaintext', 'xlsx')).toBe(true)
    expect(evaluateExportCapability({ plaintext: ['*'] }, 'viewer', 'plaintext', 'pdf')).toBe(true)
    expect(evaluateExportCapability(undefined, 'owner', 'bundle')).toBe(true)
    expect(evaluateExportCapability(undefined, 'client', 'bundle')).toBe(false)
    expect(evaluateExportCapability({ bundle: true }, 'client', 'bundle')).toBe(true)
    expect(evaluateExportCapability({ bundle: false }, 'owner', 'bundle')).toBe(false)
  })
})

describe('grant() persistence — exportCapability round-trips via keyring file', () => {
  it('persists explicit export capability for a newly-granted operator', async () => {
    const adapter = memory()
    const ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    await ownerDb.openVault('acme')

    await ownerDb.grant('acme', {
      userId: 'op@test',
      displayName: 'Operator',
      role: 'operator',
      passphrase: 'op-pass',
      permissions: { invoices: 'rw' },
      exportCapability: { plaintext: ['xlsx', 'csv'], bundle: true },
    })
    await ownerDb.close()

    const opDb = await createNoydb({ store: adapter, user: 'op@test', secret: 'op-pass' })
    await opDb.openVault('acme')

    const internals = (opDb as unknown as { keyringCache: Map<string, UnlockedKeyring> })
    const opKeyring = internals.keyringCache.get('acme')!
    expect(opKeyring.exportCapability).toEqual({ plaintext: ['xlsx', 'csv'], bundle: true })
    expect(hasExportCapability(opKeyring, 'plaintext', 'xlsx')).toBe(true)
    expect(hasExportCapability(opKeyring, 'plaintext', 'sql')).toBe(false)
    expect(hasExportCapability(opKeyring, 'bundle')).toBe(true)
    await opDb.close()
  })

  it('legacy keyrings (no exportCapability field) load with role-based defaults', async () => {
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
    expect(opKeyring.exportCapability).toBeUndefined()
    expect(hasExportCapability(opKeyring, 'plaintext', 'xlsx')).toBe(false)
    expect(hasExportCapability(opKeyring, 'bundle')).toBe(false)
    await opDb.close()
  })

  it('owner keyring defaults to bundle-on even without explicit grant', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    await db.openVault('acme')

    const internals = (db as unknown as { keyringCache: Map<string, UnlockedKeyring> })
    const ownerKeyring = internals.keyringCache.get('acme')!
    expect(hasExportCapability(ownerKeyring, 'bundle')).toBe(true)
    expect(hasExportCapability(ownerKeyring, 'plaintext', 'xlsx')).toBe(false)
    await db.close()
  })
})

describe('vault.assertCanExport / canExport', () => {
  it('owner can export bundle by default (no grant needed)', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db.openVault('acme')
    expect(vault.canExport('bundle')).toBe(true)
    expect(() => vault.assertCanExport('bundle')).not.toThrow()
    await db.close()
  })

  it('owner cannot export plaintext without a grant', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db.openVault('acme')
    expect(vault.canExport('plaintext', 'xlsx')).toBe(false)
    expect(() => vault.assertCanExport('plaintext', 'xlsx')).toThrow(ExportCapabilityError)
    await db.close()
  })

  it('operator with plaintext grant can export that format', async () => {
    const adapter = memory()
    const ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    await ownerDb.openVault('acme')
    await ownerDb.grant('acme', {
      userId: 'op@test', displayName: 'Operator', role: 'operator',
      passphrase: 'op-pass',
      permissions: { invoices: 'rw' },
      exportCapability: { plaintext: ['xlsx'] },
    })
    await ownerDb.close()

    const opDb = await createNoydb({ store: adapter, user: 'op@test', secret: 'op-pass' })
    const vault = await opDb.openVault('acme')
    expect(vault.canExport('plaintext', 'xlsx')).toBe(true)
    expect(vault.canExport('plaintext', 'csv')).toBe(false)
    expect(() => vault.assertCanExport('plaintext', 'csv')).toThrow(ExportCapabilityError)
    expect(() => vault.assertCanExport('plaintext', 'xlsx')).not.toThrow()
    // Operator without bundle grant is denied (role default is off)
    expect(vault.canExport('bundle')).toBe(false)
    expect(() => vault.assertCanExport('bundle')).toThrow(ExportCapabilityError)
    await opDb.close()
  })
})

describe('ExportCapabilityError', () => {
  it('carries tier + userId + format on plaintext variant', () => {
    const err = new ExportCapabilityError({
      tier: 'plaintext',
      userId: 'op@test',
      format: 'xlsx',
    })
    expect(err.code).toBe('EXPORT_CAPABILITY')
    expect(err.tier).toBe('plaintext')
    expect(err.format).toBe('xlsx')
    expect(err.userId).toBe('op@test')
    expect(err.name).toBe('ExportCapabilityError')
    expect(err.message).toMatch(/plaintext-export capability/)
    expect(err.message).toMatch(/"xlsx"/)
  })

  it('omits format on bundle variant', () => {
    const err = new ExportCapabilityError({
      tier: 'bundle',
      userId: 'op@test',
    })
    expect(err.tier).toBe('bundle')
    expect(err.format).toBeUndefined()
    expect(err.message).toMatch(/encrypted-bundle export capability/)
  })
})
