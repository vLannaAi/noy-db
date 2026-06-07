/**
 * MVF VaultGroup routing — milestone 16 MVP.
 * Spec: docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, ShardProvisioningError, VaultTemplateNotFoundError, UnknownShardError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { Vault } from '../src/vault.js'
import type { VaultRegistryRow } from '../src/federation/index.js'

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
  db.withVaultTemplate('client-template', {
    version: opts.templateVersion ?? 1,
    configure(vault: Vault) {
      vault.collection<Invoice>('invoices')
    },
  })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const firm = await db.openVaultGroup<Invoice>('firm-clients', {
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
    const sv = await db.openVault('state')
    await expect(
      db.openVaultGroup<Invoice>('firm', {
        registry: sv.collection<VaultRegistryRow>('vault-registry'),
        sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'missing' },
      }),
    ).rejects.toBeInstanceOf(VaultTemplateNotFoundError)
  })

  it('createShard writes a registry row with the template version', async () => {
    await h.firm.createShard('acme')
    const row = await h.registry.get('acme')
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
    const before = await h.registry.get('acme')
    expect(before).toBeNull()
    await h.firm.createShard('acme') // reconcile
    const after = await h.registry.get('acme')
    expect(after).not.toBeNull()
  })

  it('createShard throws ShardProvisioningError when the row exists but the vault is gone', async () => {
    // Write a registry row pointing at a vault that was never provisioned.
    await h.registry.put('ghost', {
      vaultId: 'firm-clients--ghost', partitionKey: 'ghost',
      templateName: 'client-template', schemaVersion: 1, createdAt: 1,
    })
    await expect(h.firm.createShard('ghost')).rejects.toBeInstanceOf(ShardProvisioningError)
  })
})
