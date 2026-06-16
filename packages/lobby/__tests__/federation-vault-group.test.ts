/**
 * MVF VaultGroup routing — milestone 16 MVP.
 * Spec: docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, ShardProvisioningError, VaultTemplateNotFoundError, UnknownShardError, ValidationError, NoAccessError, InvalidKeyError, KeyringCorruptError } from '@noy-db/hub'
import { classifyShardSkip } from '../src/federation/classify-skip.js'
import { createNoydb } from '@noy-db/hub'
import type { Noydb } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import type { VaultRegistryRow } from '../src/federation/index.js'
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

interface Invoice { clientId: string; amount: number; status: string }

/** Build an operator db with the registry vault opened and a v1 client template registered. */
async function harness(opts: { autoCreate?: boolean; templateVersion?: number } = {}) {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: opts.templateVersion ?? 1,
    configure(vault: Vault) {
      vault.collection<Invoice>('invoices')
    },
  })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const firm = await lobby.openVaultGroup<Invoice>('firm-clients', {
    registry,
    sharding: {
      keyOf: (r) => r.clientId,
      vaultTemplate: 'client-template',
      ...(opts.autoCreate !== undefined ? { autoCreate: opts.autoCreate } : {}),
    },
  })
  return { adapter, db, registry, firm }
}

describe('VaultGroup — template + createShard', () => {
  let h: Awaited<ReturnType<typeof harness>>
  beforeEach(async () => { h = await harness() })

  it('openVaultGroup throws when the template is unregistered', async () => {
    const db = await createNoydb({ store: memory(), user: 'operator', secret: 'op-pass' })
    const lobby = createLobby(db)
    const sv = await db.openVault('state')
    await expect(
      lobby.openVaultGroup<Invoice>('firm', {
        registry: sv.collection<VaultRegistryRow>('vault-registry'),
        sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'missing' },
      }),
    ).rejects.toBeInstanceOf(VaultTemplateNotFoundError)
  })

  it('createShard writes a registry row with the template version', async () => {
    await h.firm.createShard('acme')
    const row = await h.registry.get('firm-clients--acme')
    expect(row).not.toBeNull()
    expect(row!.vaultId).toBe('firm-clients--acme')
    expect(row!.partitionKey).toBe('acme')
    expect(row!.templateName).toBe('client-template')
    expect(row!.schemaVersion).toBe(1)
  })

  it('createShard is idempotent — re-running returns a handle, no duplicate row', async () => {
    await h.firm.createShard('acme')
    await h.firm.createShard('acme') // no throw
    const rows = await (async () => { await h.registry.list(); return h.registry.query().toArray() })()
    expect(rows.filter((r) => r.partitionKey === 'acme')).toHaveLength(1)
  })

  it('createShard reconciles a provisioned-but-unregistered vault (row missing, vault exists)', async () => {
    // Provision the shard vault directly, leaving the registry empty.
    await h.db.openVault('firm-clients--acme')
    const before = await h.registry.get('firm-clients--acme')
    expect(before).toBeNull()
    await h.firm.createShard('acme') // reconcile
    const after = await h.registry.get('firm-clients--acme')
    expect(after).not.toBeNull()
  })

  it('createShard throws ShardProvisioningError when the row exists but the vault is gone', async () => {
    // Write a registry row pointing at a vault that was never provisioned.
    await h.registry.put('firm-clients--ghost', {
      vaultId: 'firm-clients--ghost', partitionKey: 'ghost',
      templateName: 'client-template', schemaVersion: 1, createdAt: 1, group: 'firm-clients',
    })
    await expect(h.firm.createShard('ghost')).rejects.toBeInstanceOf(ShardProvisioningError)
  })
})

describe('VaultGroup — write routing', () => {
  it('put auto-creates the shard and routes the write (autoCreate default on)', async () => {
    const h = await harness()
    await h.firm.collection('invoices').put('inv-1', { clientId: 'acme', amount: 1200, status: 'open' })

    // The shard exists and holds the record.
    const acme = await h.firm.shard('acme')
    const rec = await acme.collection<Invoice>('invoices').get('inv-1')
    expect(rec).toEqual({ clientId: 'acme', amount: 1200, status: 'open' })

    // A registry row was created.
    expect(await h.registry.get('firm-clients--acme')).not.toBeNull()
  })

  it('put routes records with different partition keys to different shards', async () => {
    const h = await harness()
    await h.firm.collection('invoices').put('inv-a', { clientId: 'acme', amount: 100, status: 'open' })
    await h.firm.collection('invoices').put('inv-b', { clientId: 'bigco', amount: 200, status: 'open' })

    const acme = await h.firm.shard('acme')
    const bigco = await h.firm.shard('bigco')
    expect(await acme.collection<Invoice>('invoices').get('inv-b')).toBeNull()
    expect(await bigco.collection<Invoice>('invoices').get('inv-a')).toBeNull()
    expect(await bigco.collection<Invoice>('invoices').get('inv-b')).not.toBeNull()
  })

  it('put throws UnknownShardError when autoCreate is off and the shard is unknown', async () => {
    const h = await harness({ autoCreate: false })
    await expect(
      h.firm.collection('invoices').put('inv-1', { clientId: 'acme', amount: 1, status: 'open' }),
    ).rejects.toBeInstanceOf(UnknownShardError)
  })
})

describe('VaultGroup — fan-out read', () => {
  it('merges matching records across shards', async () => {
    const h = await harness()
    const inv = h.firm.collection('invoices')
    await inv.put('a-1', { clientId: 'acme', amount: 100, status: 'overdue' })
    await inv.put('a-2', { clientId: 'acme', amount: 200, status: 'open' })
    await inv.put('b-1', { clientId: 'bigco', amount: 300, status: 'overdue' })

    const out = await h.firm.collection('invoices').query().where('status', '==', 'overdue').toArray()
    expect(out.skippedVaults).toEqual([])
    expect(out.results.map((r) => r.amount).sort((x, y) => x - y)).toEqual([100, 300])
  })

  it('minVersion guard moves behind-version shards into skippedVaults (not results)', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
    const lobby = createLobby(db)

    // Register template v1, create shard A at v1.
    lobby.withVaultTemplate('client-template', {
      version: 1,
      configure(vault: Vault) { vault.collection<Invoice>('invoices') },
    })
    const stateVault = await db.openVault('state')
    const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
    let firm = await lobby.openVaultGroup<Invoice>('firm-clients', {
      registry, sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
    })
    await firm.collection('invoices').put('a-1', { clientId: 'acme', amount: 100, status: 'overdue' })

    // Re-register the template at v2 and create shard B at v2.
    lobby.withVaultTemplate('client-template', {
      version: 2,
      configure(vault: Vault) { vault.collection<Invoice>('invoices') },
    })
    firm = await lobby.openVaultGroup<Invoice>('firm-clients', {
      registry, sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
    })
    await firm.collection('invoices').put('b-1', { clientId: 'bigco', amount: 300, status: 'overdue' })

    const out = await firm.collection('invoices').query()
      .where('status', '==', 'overdue')
      .toArray({ minVersion: 2 })

    expect(out.results.map((r) => r.amount)).toEqual([300]) // only the v2 shard
    expect(out.skippedVaults).toEqual([
      { vaultId: 'firm-clients--acme', reason: 'schema-drift' },
    ])
  })

  it('a registry row whose vault is unprovisioned surfaces as skippedVaults reason "error" (no silent recreate)', async () => {
    const h = await harness()
    // Real provisioned shard with data.
    await h.firm.collection('invoices').put('a-1', { clientId: 'acme', amount: 100, status: 'overdue' })
    // Divergent registry row: points at a vault that was never provisioned.
    await h.registry.put('firm-clients--ghost', {
      vaultId: 'firm-clients--ghost', partitionKey: 'ghost',
      templateName: 'client-template', schemaVersion: 1, createdAt: 1, group: 'firm-clients',
    })

    const out = await h.firm.collection('invoices').query().where('status', '==', 'overdue').toArray()

    expect(out.results.map((r) => r.amount)).toEqual([100]) // acme only
    const ghost = out.skippedVaults.find((s) => s.vaultId === 'firm-clients--ghost')
    expect(ghost).toBeDefined()
    expect(ghost!.reason).toBe('error')
    expect(ghost!.error).toBeInstanceOf(ShardProvisioningError)
  })

  it('a per-shard read failure lands in skippedVaults with reason "error" (fan-out not aborted)', async () => {
    // Write with one db, then read with a FRESH db (empty caches) so the
    // fan-out actually re-hydrates from the store and re-hits list(). The
    // injected failure targets only the invoices collection of one shard;
    // keyring load (collection '_keyring') is unaffected, so the shard
    // opens and the failure surfaces inside the fan-out callback.
    const base = memory()
    let failBigco = false
    const adapter: NoydbStore = {
      ...base,
      async list(c, col) {
        if (failBigco && c === 'firm-clients--bigco' && col === 'invoices') {
          throw new Error('injected list failure')
        }
        return base.list(c, col)
      },
    }
    const tmpl = (vault: Vault) => { vault.collection<Invoice>('invoices') }

    // --- write side ---
    const wdb = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
    const wlobby = createLobby(wdb)
    wlobby.withVaultTemplate('client-template', { version: 1, configure: tmpl })
    const wState = await wdb.openVault('state')
    const wFirm = await wlobby.openVaultGroup<Invoice>('firm-clients', {
      registry: wState.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
    })
    await wFirm.collection('invoices').put('a-1', { clientId: 'acme', amount: 100, status: 'overdue' })
    await wFirm.collection('invoices').put('b-1', { clientId: 'bigco', amount: 300, status: 'overdue' })

    // --- read side: fresh db, caches empty ---
    failBigco = true
    const rdb = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
    const rlobby = createLobby(rdb)
    rlobby.withVaultTemplate('client-template', { version: 1, configure: tmpl })
    const rState = await rdb.openVault('state')
    const rFirm = await rlobby.openVaultGroup<Invoice>('firm-clients', {
      registry: rState.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
    })

    const out = await rFirm.collection('invoices').query().where('status', '==', 'overdue').toArray()
    expect(out.results.map((r) => r.amount)).toEqual([100]) // bigco failed, acme survived
    expect(out.skippedVaults).toHaveLength(1)
    expect(out.skippedVaults[0]!.vaultId).toBe('firm-clients--bigco')
    expect(out.skippedVaults[0]!.reason).toBe('error')
    expect(out.skippedVaults[0]!.error).toBeInstanceOf(Error)
  })
})

describe('VaultGroup — partition key validation', () => {
  it('rejects a partitionKey containing the "--" separator', async () => {
    const h = await harness()
    await expect(h.firm.createShard('a--b')).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a partitionKey with store-unsafe characters', async () => {
    const h = await harness()
    await expect(h.firm.createShard('a/b')).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects an empty partitionKey', async () => {
    const h = await harness()
    await expect(h.firm.createShard('')).rejects.toBeInstanceOf(ValidationError)
  })

  it('accepts ordinary hyphenated keys (e.g. UUID-like)', async () => {
    const h = await harness()
    await expect(h.firm.createShard('acme-corp-2026')).resolves.toBeDefined()
  })
})

describe('classifyShardSkip', () => {
  it('NoAccessError → no-grant; corruption/credential/other → error', () => {
    expect(classifyShardSkip(new NoAccessError('x'))).toBe('no-grant')
    expect(classifyShardSkip(new InvalidKeyError())).toBe('error')
    expect(classifyShardSkip(new KeyringCorruptError({ failedCollections: ['c'], intactCount: 0 }))).toBe('error')
    expect(classifyShardSkip(new Error('store boom'))).toBe('error')
  })
})

describe('VaultGroup — key-custody-neutral fan-out', () => {
  it('non-granted shard → no-grant skip on fan-out; clean throw on drill-down/put; zero self-provision', async () => {
    const adapter = memory()
    const op = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
    const oplobby = createLobby(op)
    oplobby.withVaultTemplate('t', { version: 1, configure: (v: Vault) => { v.collection<Invoice>('invoices') } })
    const opState = await op.openVault('state')
    const opFirm = await oplobby.openVaultGroup<Invoice>('firm', {
      registry: opState.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 't' },
    })
    await opFirm.collection('invoices').put('a1', { clientId: 'acme', amount: 100, status: 'overdue' })
    await opFirm.collection('invoices').put('b1', { clientId: 'beta', amount: 200, status: 'overdue' })
    await op.grant('firm--acme', { userId: 'advisor', displayName: 'Adv', role: 'viewer', passphrase: 'adv-pass' })
    await op.grant('state', { userId: 'advisor', displayName: 'Adv', role: 'viewer', passphrase: 'adv-pass' })

    const adv = await createNoydb({ store: adapter, user: 'advisor', secret: 'adv-pass' })
    const advlobby = createLobby(adv)
    advlobby.withVaultTemplate('t', { version: 1, configure: (v: Vault) => { v.collection<Invoice>('invoices') } })
    const advState = await adv.openVault('state')
    const advFirm = await advlobby.openVaultGroup<Invoice>('firm', {
      registry: advState.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 't' },
    })

    const out = await advFirm.collection('invoices').query().where('status', '==', 'overdue').toArray()
    expect(out.results.map((r) => r.amount)).toEqual([100])             // acme only (granted)
    expect(out.skippedVaults.find((s) => s.vaultId === 'firm--beta')?.reason).toBe('no-grant')
    expect(await adapter.get('firm--beta', '_keyring', 'advisor')).toBeNull()  // no self-provision

    await expect(advFirm.shard('beta')).rejects.toBeInstanceOf(NoAccessError)
    expect(await adapter.get('firm--beta', '_keyring', 'advisor')).toBeNull()
    await expect(
      advFirm.collection('invoices').put('x', { clientId: 'beta', amount: 9, status: 'open' }),
    ).rejects.toBeInstanceOf(NoAccessError)
    expect(await adapter.get('firm--beta', '_keyring', 'advisor')).toBeNull()
  })
})
