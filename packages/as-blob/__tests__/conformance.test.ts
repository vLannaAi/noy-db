/**
 * as-blob against the published `as-*` export-gate contract.
 *
 * Package-specific behaviour stays in this package's own suite. This is the
 * half every projection shares: the gate refuses, and refuses before reading.
 */
import { runFormatConformanceTests, observeStore, type ObservedStore } from '@noy-db/test-format-conformance'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Vault } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { withTeam } from '@noy-db/hub/team'
import { withBlobs } from '@noy-db/hub/blobs'
import { toBytes, download, write } from '../src/index.js'

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
  return (await seededVaultWithStore()).vault
}

async function seededVaultWithStore(): Promise<{ vault: Vault; store: ObservedStore }> {
  // #1211 — wrapped where the store is CREATED; a wrapper applied after the
  // vault exists intercepts nothing (the vault captured its store already).
  const store = observeStore(toMemory())
  const opts = { teamStrategy: withTeam(), blobsStrategy: withBlobs(), store, user: 'owner-01', secret: 'owner-pass' }
  const seed = await createNoydb(opts)
  const seeded = await seed.openVault('acme')
  await seeded.collection('invoices').put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
  // A real blob, because the kit's "the fixture vault CAN export" case runs
  // the entry point for real. Without one, `toBytes` fails with
  // AsBlobNotFoundError and every refusal below passes for the wrong reason —
  // which is exactly what it reported on the first run.
  await seeded.collection('invoices').blob('inv-1').put('raw', new Uint8Array([1, 2, 3]), {
    mimeType: 'application/octet-stream',
    compress: false,
  })
  await seed.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'owner-pass',
    exportCapability: { plaintext: ['blob'] },
  })
  await seed.close()
  const db = await createNoydb(opts)
  return { vault: await db.openVault('acme'), store }
}

runFormatConformanceTests('as-blob', {
  tier: 'plaintext',
  format: 'blob',
  vault: seededVault,
  observableVault: seededVaultWithStore,
  exports: [
    { name: 'toBytes', run: (vault) => toBytes(vault, { collection: 'invoices', id: 'inv-1', slot: 'raw' }) },
    { name: 'download', run: (vault) => download(vault, { collection: 'invoices', id: 'inv-1', slot: 'raw' }) },
    { name: 'write', run: (vault) => write(vault, '/tmp/conformance.bin', { collection: 'invoices', id: 'inv-1', slot: 'raw', acknowledgeRisks: true }) },
  ],
  writeWithoutAcknowledgement: (vault, path) =>
    write(vault, path, { collection: 'invoices', id: 'inv-1', slot: 'raw' } as Parameters<typeof write>[2]),
})
