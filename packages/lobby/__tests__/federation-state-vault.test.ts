import { describe, it, expect } from 'vitest'
import { captureBlueprint, fingerprintBlueprint } from '../src/federation/schema-manifest.js'
import type { Vault } from '@noy-db/hub'
import { ReservedVaultNameError } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { createNoydb } from '@noy-db/hub'
import { StateManagementVault } from '../src/federation/state-vault.js'
import { immutableGuard } from '@noy-db/hub/guards'
import { RecordLockedError } from '@noy-db/hub'
import { STATE_VAULT_NAME } from '@noy-db/hub'
import { createLobby } from '../src/index.js'

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
    const lobby = createLobby(db)
    lobby.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    const sv = await StateManagementVault.open(db)
    const groupA = await lobby.openVaultGroup<{ pk: string }>('groupA', {
      registry: sv.registry,
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    const groupB = await lobby.openVaultGroup<{ pk: string }>('groupB', {
      registry: sv.registry,
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    await groupA.createShard('shared')
    await groupB.createShard('shared')
    expect((await sv.registry.get('groupA--shared'))?.group).toBe('groupA')
    expect((await sv.registry.get('groupB--shared'))?.group).toBe('groupB')
  })

  it('scopes fan-out reads to the group — no cross-group leak via a shared auto-wired registry', async () => {
    // Encrypted mode: fan-out reads gate shards on _shardVaultProvisioned (a
    // keyring check), which only holds for encrypted vaults.
    const db = await createNoydb({ store: memory(), user: 'op', secret: 'op-pass' })
    const lobby = createLobby(db)
    lobby.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    // Both groups auto-wire to the same instance-wide StateManagement registry.
    const groupA = await lobby.openVaultGroup<{ pk: string; tag: string }>('groupA', {
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    const groupB = await lobby.openVaultGroup<{ pk: string; tag: string }>('groupB', {
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    await groupA.collection('items').put('a1', { pk: 'pa', tag: 'A' })
    await groupB.collection('items').put('b1', { pk: 'pb', tag: 'B' })

    const aOut = await groupA.collection<{ pk: string; tag: string }>('items').query().toArray()
    expect(aOut.results.map((r) => r.tag)).toEqual(['A'])
    const bOut = await groupB.collection<{ pk: string; tag: string }>('items').query().toArray()
    expect(bOut.results.map((r) => r.tag)).toEqual(['B'])
  })
})

describe('openVaultGroup auto-wiring', () => {
  it('auto-opens the state vault when registry is omitted, recording row + manifest + event', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const lobby = createLobby(db)
    lobby.withVaultTemplate('client', { version: 2, configure: (v) => { v.collection('invoices') } })
    const group = await lobby.openVaultGroup<{ pk: string }>('firm', {
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 'client' },
    })
    await group.createShard('acme')

    const sv = await StateManagementVault.open(db)
    expect((await sv.registry.get('firm--acme'))?.group).toBe('firm')
    expect((await sv.schemaManifest.get('client:2'))?.collections).toEqual(['invoices'])
    const events = await sv.queryEvents().toArray()
    expect(events.some((e) => e.type === 'shard-created' && e.vaultId === 'firm--acme')).toBe(true)
    expect(events.some((e) => e.type === 'group-opened' && e.group === 'firm')).toBe(true)
    expect(events.some((e) => e.type === 'manifest-recorded' && e.templateName === 'client' && e.version === 2)).toBe(true)
  })

  it('still honors an explicitly-passed registry (backward-compat)', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const lobby = createLobby(db)
    lobby.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    const sv = await StateManagementVault.open(db)
    const group = await lobby.openVaultGroup<{ pk: string }>('g', {
      registry: sv.registry,
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    await group.createShard('p1')
    expect((await sv.registry.get('g--p1'))?.partitionKey).toBe('p1')
  })
})

describe('reserved-name rejection', () => {
  it('rejects the reserved state-vault name as a group name', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const lobby = createLobby(db)
    lobby.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    await expect(
      lobby.openVaultGroup('__noydb_state__', { sharding: { keyOf: (r: { pk: string }) => r.pk, vaultTemplate: 't' } }),
    ).rejects.toBeInstanceOf(ReservedVaultNameError)
  })

  it('rejects the reserved name as a partition key', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const lobby = createLobby(db)
    lobby.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    const group = await lobby.openVaultGroup<{ pk: string }>('g', { sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' } })
    await expect(group.createShard('__noydb_state__')).rejects.toBeInstanceOf(ReservedVaultNameError)
  })
})

describe('manifest drift detection', () => {
  it('detects when a configure shape no longer matches a recorded manifest version', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)
    await sv.recordManifest('client', { version: 1, configure: (v) => { v.collection('invoices') } })
    // Same declared version, different shape → drift.
    const drift = await sv.detectDrift('client', { version: 1, configure: (v) => { v.collection('invoices'); v.collection('extra') } })
    expect(drift).toBe(true)
    const ok = await sv.detectDrift('client', { version: 1, configure: (v) => { v.collection('invoices') } })
    expect(ok).toBe(false)
  })

  it('treats a missing manifest as drift', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)
    expect(await sv.detectDrift('client', { version: 9, configure: (v) => { v.collection('x') } })).toBe(true)
  })
})

describe('deployment-events optional WORM hardening', () => {
  it('rejects mutation of an event when the consumer adds immutableGuard', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'op',
      encrypt: false,
      guardStrategies: [immutableGuard({ collection: 'deploymentEvents', appendOnly: true })],
    })
    const sv = await StateManagementVault.open(db)
    await sv.appendEvent({ type: 'group-opened', group: 'g' })
    const [ev] = await sv.queryEvents().toArray()
    // The events collection is private on StateManagementVault; a consumer
    // bypassing appendEvent via direct vault access still hits the WORM guard.
    const stateVault = await db.openVault(STATE_VAULT_NAME)
    await expect(
      stateVault.collection('deploymentEvents').put(ev.id, { ...ev, group: 'tampered' }),
    ).rejects.toBeInstanceOf(RecordLockedError)
  })
})

describe('lobby.openStateManagementVault factory', () => {
  it('returns a usable control-plane handle (lazy-loaded)', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const lobby = createLobby(db)
    const sv = await lobby.openStateManagementVault()
    await sv.appendEvent({ type: 'group-opened', group: 'x' })
    expect((await sv.queryEvents().toArray()).length).toBe(1)
  })
})
