/**
 * as-csv against the published `as-*` export-gate contract.
 *
 * The package's own suite covers CSV: RFC 4180 escaping, column inference,
 * value serialisation. This runs the half every plaintext projection shares —
 * that the gate refuses, and refuses before reading anything.
 */
import { runFormatConformanceTests } from '@noy-db/test-format-conformance'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Vault } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { withTeam } from '@noy-db/hub/team'
import { toString, download, write } from '../src/index.js'

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

/**
 * A vault that is EXPORT-CAPABLE, which matters more than it looks.
 *
 * Without the `exportCapability` grant, `assertCanExport` refuses every call —
 * so `write` rejects before it ever reads `acknowledgeRisks`, and the
 * acknowledgement case passes no matter what the guard does. The kit now also
 * matches on the message, so both halves have to be wrong for it to slip.
 */
async function seededVault(): Promise<Vault> {
  const store = toMemory()
  const seed = await createNoydb({
    teamStrategy: withTeam(), store, user: 'owner-01', secret: 'owner-pass',
  })
  const seeded = await seed.openVault('acme')
  await seeded.collection('invoices').put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
  await seed.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'owner-pass',
    exportCapability: { plaintext: ['csv'] },
  })
  await seed.close()

  const db = await createNoydb({
    teamStrategy: withTeam(), store, user: 'owner-01', secret: 'owner-pass',
  })
  return db.openVault('acme')
}

runFormatConformanceTests('as-csv', {
  format: 'csv',
  vault: seededVault,
  // Every plaintext-producing export, not a representative one. `download`
  // delegates to `toString` today; listing both is what would catch it if
  // that ever stops being true.
  exports: [
    { name: 'toString', run: (vault) => toString(vault, { collection: 'invoices' }) },
    { name: 'download', run: (vault) => download(vault, { collection: 'invoices' }) },
    { name: 'write', run: (vault) => write(vault, '/tmp/conformance.csv', { collection: 'invoices', acknowledgeRisks: true }) },
  ],
  writeWithoutAcknowledgement: (vault, path) =>
    write(vault, path, { collection: 'invoices' } as Parameters<typeof write>[2]),
})
