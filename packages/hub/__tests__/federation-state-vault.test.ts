import { describe, it, expect } from 'vitest'
import { captureBlueprint, fingerprintBlueprint } from '../src/federation/schema-manifest.js'
import type { Vault } from '../src/vault.js'
import { ReservedVaultNameError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { StateManagementVault } from '../src/federation/state-vault.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
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

describe('StateManagementVault', () => {
  it('configures registry/manifest/event accessors idempotently', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)
    const sv2 = await StateManagementVault.open(db) // idempotent
    await sv.registry.put('g--p1', {
      vaultId: 'g--p1', partitionKey: 'p1', templateName: 't', schemaVersion: 1, createdAt: 1, group: 'g',
    })
    expect((await sv2.registry.get('g--p1'))?.partitionKey).toBe('p1')
  })

  it('appendEvent writes append-only events with unique ids', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)
    await sv.appendEvent({ type: 'group-opened', group: 'g' })
    await sv.appendEvent({ type: 'group-opened', group: 'g' })
    const events = await sv.queryEvents().toArray()
    expect(events.length).toBe(2)
    expect(events[0].id).not.toBe(events[1].id)
  })

  it('recordManifest stores a fingerprinted row keyed by template:version', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)
    await sv.recordManifest('client', { version: 1, configure: (v) => { v.collection('invoices') } })
    const row = await sv.schemaManifest.get('client:1')
    expect(row?.collections).toEqual(['invoices'])
    expect(row?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('group-qualified registry ids', () => {
  it('keys registry rows by `${group}--${partitionKey}` so two groups do not collide', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    db.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    const sv = await StateManagementVault.open(db)
    const groupA = await db.openVaultGroup<{ pk: string }>('groupA', {
      registry: sv.registry,
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    const groupB = await db.openVaultGroup<{ pk: string }>('groupB', {
      registry: sv.registry,
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    await groupA.createShard('shared')
    await groupB.createShard('shared')
    expect((await sv.registry.get('groupA--shared'))?.group).toBe('groupA')
    expect((await sv.registry.get('groupB--shared'))?.group).toBe('groupB')
  })
})

describe('openVaultGroup auto-wiring', () => {
  it('auto-opens the state vault when registry is omitted, recording row + manifest + event', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    db.withVaultTemplate('client', { version: 2, configure: (v) => { v.collection('invoices') } })
    const group = await db.openVaultGroup<{ pk: string }>('firm', {
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 'client' },
    })
    await group.createShard('acme')

    const sv = await StateManagementVault.open(db)
    expect((await sv.registry.get('firm--acme'))?.group).toBe('firm')
    expect((await sv.schemaManifest.get('client:2'))?.collections).toEqual(['invoices'])
    const events = await sv.queryEvents().toArray()
    expect(events.some((e) => e.type === 'shard-created' && e.vaultId === 'firm--acme')).toBe(true)
    expect(events.some((e) => e.type === 'group-opened' && e.group === 'firm')).toBe(true)
  })

  it('still honors an explicitly-passed registry (backward-compat)', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    db.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    const sv = await StateManagementVault.open(db)
    const group = await db.openVaultGroup<{ pk: string }>('g', {
      registry: sv.registry,
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    await group.createShard('p1')
    expect((await sv.registry.get('g--p1'))?.partitionKey).toBe('p1')
  })
})
