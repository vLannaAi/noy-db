/**
 * as-xml against the published `as-*` gate contract — BOTH shapes.
 *
 * Deleted in #1193 when the inversion made it stop type-checking; restored for
 * #1209 covering the format's REAL surface: the inverted entry, the surviving
 * argument-shape wrappers, and (where the format decodes) the import gate the
 * old fixture never touched.
 */
import { runFormatConformanceTests, observeStore, type ObservedStore } from '@noy-db/test-format-conformance'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Vault } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { withTeam } from '@noy-db/hub/team'
import { withFormats } from '@noy-db/hub/as'
import { asXml, download, write } from '../src/index.js'

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
 * Export- AND import-CAPABLE, with `withFormats()` — all three are required
 * for the kit's ungated-success guards to be falsifiable. Without the import
 * grant the import-denial case would refuse for the wrong reason; without the
 * strategy the inverted entries throw FormatsNotEnabledError before proving
 * anything.
 */
async function seededVault(): Promise<Vault> {
  return (await seededVaultWithStore()).vault
}

async function seededVaultWithStore(): Promise<{ vault: Vault; store: ObservedStore }> {
  // #1211 — wrapped where the store is CREATED; a wrapper applied after the
  // vault exists intercepts nothing (the vault captured its store already).
  const store = observeStore(toMemory())
  const opts = {
    teamStrategy: withTeam(), formatsStrategy: withFormats(),
    store, user: 'owner-01', secret: 'owner-pass',
  }
  const seed = await createNoydb(opts)
  const seeded = await seed.openVault('acme')
  await seeded.collection('invoices').put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
  await seed.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'owner-pass',
    exportCapability: { plaintext: ['xml'] },
    importCapability: { plaintext: ['xml'] },
  })
  await seed.close()

  const db = await createNoydb(opts)
  return { vault: await db.openVault('acme'), store }
}

runFormatConformanceTests('as-xml', {
  tier: 'plaintext',
  format: 'xml',
  vault: seededVault,
  observableVault: seededVaultWithStore,
  exports: [
    { name: 'vault.export(asXml())', run: (vault) => vault.export(asXml(), { collections: ['invoices'] }) },
    { name: 'download', run: (vault) => download(vault, { collection: 'invoices' } as never) },
    { name: 'write', run: (vault) => write(vault, '/tmp/conformance.xml', { collection: 'invoices', acknowledgeRisks: true } as never) },
  ],
  imports: [
    { name: 'vault.import(asXml())', run: (vault) => vault.import(asXml(), '<Records><Invoice><id>inv-2</id></Invoice></Records>', { collection: 'invoices' }) },
  ],
  writeWithoutAcknowledgement: (vault, path) =>
    write(vault, path, { collection: 'invoices' } as never),
})
