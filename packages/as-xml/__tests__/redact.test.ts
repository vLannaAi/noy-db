/**
 * as-xml `redact` option — classified/sensitivity-aware export via
 * `applyListProjection`.
 *
 * Follows the same in-memory NoydbStore + owner-grant pattern as
 * `as-xml.test.ts`, wrapped in a local `makeVault()` helper since the
 * neighboring tests each build the vault inline per-suite.
 */

import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { withFormats } from '@noy-db/hub/as'
import { ConflictError, createNoydb, classified } from '@noy-db/hub'
import { asXml } from '../src/index.js'
import { withTeam } from '@noy-db/hub/team'

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
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

/**
 * Builds a fresh vault whose owner already holds the `plaintext: ['xml']`
 * export grant (mirrors `as-xml.test.ts`'s `seed()` + grant dance:
 * the grant must be persisted and the vault reopened before the new
 * capability is visible on the session).
 */
async function makeVault() {
  const adapter = toMemory()
  const db = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
  await db.openVault('acme')
  await db.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'owner-pass',
    exportCapability: { plaintext: ['xml'] },
  })
  await db.close()

  const db2 = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
  return db2.openVault('acme')
}

describe('as-xml redact', () => {
  it('redact: true masks classified fields and keeps riders', async () => {
    const v = await makeVault()
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await c.put('r1', { pan: '4242424242424242', total: 9 })
    const xml = await v.export(asXml(), { collections: ['cards'], redact: true })
    expect(xml).toContain('•••• 4242')
    expect(xml).not.toContain('4242424242424242')
  })

  it('redact: { sensitivity: "omit" } drops plain pii-tagged columns', async () => {
    const v = await makeVault()
    const c = v.collection('people', { fieldMeta: { note: { label: 'N', sensitivity: 'pii' } } })
    await c.put('p1', { name: 'x', note: 'private' })
    const xml = await v.export(asXml(), { collections: ['people'], redact: { sensitivity: 'omit' } })
    expect(xml).not.toContain('private')
    expect(xml).toContain('x')
  })
})
