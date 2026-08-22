/**
 * as-json against the published `as-*` export-gate contract.
 *
 * Package-specific behaviour stays in this package's own suite. This is the
 * half every plaintext projection shares: the gate refuses, and refuses
 * before reading anything.
 */
import { runFormatConformanceTests } from '@noy-db/test-format-conformance'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Vault } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { withTeam } from '@noy-db/hub/team'
import { toString, toObject, download, write } from '../src/index.js'

function toMemory(): NoydbStore {
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
        for (const [id, env] of Object.entries(recs)) coll.set(id, env)
      }
    },
  }
}

/** Export-CAPABLE on purpose — see the kit's note on `writeWithoutAcknowledgement`. */
async function seededVault(): Promise<Vault> {
  const store = toMemory()
  const seed = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner-01', secret: 'owner-pass' })
  const seeded = await seed.openVault('acme')
  await seeded.collection('invoices').put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
  await seed.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'owner-pass',
    exportCapability: { plaintext: ['json'] },
  })
  await seed.close()
  const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner-01', secret: 'owner-pass' })
  return db.openVault('acme')
}

runFormatConformanceTests('as-json', {
  format: 'json',
  vault: seededVault,
  exports: [
    { name: 'toString', run: (vault) => toString(vault) },
    { name: 'toObject', run: (vault) => toObject(vault) },
    { name: 'download', run: (vault) => download(vault) },
    { name: 'write', run: (vault) => write(vault, '/tmp/conformance.json', { acknowledgeRisks: true }) },
  ],
  writeWithoutAcknowledgement: (vault, path) =>
    write(vault, path, {} as Parameters<typeof write>[2]),
})
