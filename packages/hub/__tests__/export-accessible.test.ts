/**
 * #199 P1 — vault.user.exportMyAccessibleData(): a non-owner exports the scope
 * they can decrypt as a re-keyed, non-destructive `.noydb` bundle. A client
 * granted only `invoices` must NOT be able to export `secrets`.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { readNoydbBundle } from '../src/with-fork/bundle/bundle.js'

function makeStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(v: string, c: string) {
    let m = store.get(v); if (!m) { m = new Map(); store.set(v, m) }
    let b = m.get(c); if (!b) { b = new Map(); m.set(c, b) }
    return b
  }
  return {
    name: 'memory',
    async get(v, c, id) { return bucket(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) { const b = bucket(v, c); const ex = b.get(id); if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0); b.set(id, env) },
    async delete(v, c, id) { bucket(v, c).delete(id) },
    async list(v, c) { return [...bucket(v, c).keys()] },
    async loadAll(v) { const m = store.get(v); const s: VaultSnapshot = {}; if (m) for (const [n, c] of m) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of c) r[id] = e; s[n] = r } return s },
    async saveAll(v, data) { for (const [n, recs] of Object.entries(data)) { const b = bucket(v, n); for (const [id, e] of Object.entries(recs)) b.set(id, e) } },
  }
}

function bundleCollections(dumpJson: string): string[] {
  const dump = JSON.parse(dumpJson) as { collections?: Record<string, unknown> }
  return Object.keys(dump.collections ?? {})
}

describe('#199 P1 — exportMyAccessibleData', () => {
  it('a client exports only their accessible collections, re-keyed', async () => {
    const store = makeStore()
    // Owner sets up two collections + grants a client RO on invoices only.
    const owner = await createNoydb({ store, user: 'firm', secret: 'owner-pw-long-enough' })
    const ov = await owner.openVault('acme')
    await ov.collection<{ id: string; total: number }>('invoices').put('i1', { id: 'i1', total: 100 })
    await ov.collection<{ id: string; note: string }>('secrets').put('s1', { id: 's1', note: 'internal' })
    await owner.grant('acme', {
      userId: 'client1', displayName: 'Client', role: 'client', passphrase: 'client-pw-long-enough',
      permissions: { invoices: 'ro' },
    })
    owner.close()

    // Client opens + exports their accessible scope, re-keyed to a new passphrase.
    const client = await createNoydb({ store, user: 'client1', secret: 'client-pw-long-enough' })
    const cv = await client.openVault('acme')
    const bytes = await cv.user.exportMyAccessibleData({ reKey: { passphrase: 'new-owner-pw' } })

    const { dumpJson } = await readNoydbBundle(bytes)
    const cols = bundleCollections(dumpJson)
    expect(cols).toContain('invoices')
    expect(cols).not.toContain('secrets') // not granted → not exportable
  })

  it('owner export includes everything; scope.collections narrows it', async () => {
    const store = makeStore()
    const owner = await createNoydb({ store, user: 'firm', secret: 'owner-pw-long-enough' })
    const ov = await owner.openVault('acme')
    await ov.collection<{ id: string }>('invoices').put('i1', { id: 'i1' })
    await ov.collection<{ id: string }>('secrets').put('s1', { id: 's1' })

    const all = bundleCollections((await readNoydbBundle(await ov.user.exportMyAccessibleData())).dumpJson)
    expect(all).toEqual(expect.arrayContaining(['invoices', 'secrets']))

    const narrowed = bundleCollections(
      (await readNoydbBundle(await ov.user.exportMyAccessibleData({ scope: { collections: ['invoices'] } }))).dumpJson,
    )
    expect(narrowed).toContain('invoices')
    expect(narrowed).not.toContain('secrets')
  })
})
