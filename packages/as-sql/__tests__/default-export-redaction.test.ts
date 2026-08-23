/**
 * as-sql default (non-`redact`) export of classified fields — pinning
 * deliberate output (#629 Task 9 review finding, fix wave 1).
 *
 * Before #629 Task 9, `vault.exportStream()` handed classified fields
 * through as live `SealedHandle` instances; `as-sql`'s default (no
 * `redact` option) path never calls `applyListProjection`, so those
 * instances flowed straight into `inferType`/`formatLiteral`. Because
 * a `SealedHandle` is an object, `inferType` fell through to `'jsonb'`
 * and `formatLiteral` emitted `JSON.stringify(value)` — which itself
 * only redacted via `SealedHandle.toJSON()` — producing a quoted-JSON
 * literal (`'"[sealed]"'`) under a `JSONB` column.
 *
 * #629 Task 9 flipped `exportStream()` to redact non-exportable via
 * fields on the record itself (a plain `'[sealed]'` string, no longer
 * a revealable `SealedHandle`). That changes `as-sql`'s DEFAULT output
 * for classified-field collections: the column infers as `TEXT` (a
 * string was observed, not an object) and the row literal is the bare
 * string `'[sealed]'`. The controller ruled this new output intentional
 * and correct — the old bytes were a downstream echo of an accident,
 * and shipping a live, revealable `SealedHandle` into the export path
 * was itself the hazard the flip closes. This test pins the new output
 * as deliberate policy so it can never regress silently again.
 *
 * Reuses the same in-memory store + owner-grant `makeVault()` pattern
 * as `redact.test.ts` in this directory.
 */

import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { withFormats } from '@noy-db/hub/as'
import { ConflictError, createNoydb, classified } from '@noy-db/hub'
import { asSql } from '../src/index.js'
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
 * Builds a fresh vault whose owner already holds the `plaintext: ['sql']`
 * export grant (mirrors `redact.test.ts`'s `makeVault()`).
 */
async function makeVault() {
  const adapter = toMemory()
  const db = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
  await db.openVault('acme')
  await db.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'owner-pass',
    exportCapability: { plaintext: ['sql'] },
  })
  await db.close()

  const db2 = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
  return db2.openVault('acme')
}

describe('as-sql default export (no redact option) — classified field posture', () => {
  it("default export emits deliberate '[sealed]' redaction (posture: exportable=false) — intentional output change in #629", async () => {
    const v = await makeVault()
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await c.put('r1', { pan: '4242424242424242', total: 9 })

    const sql = await v.export(asSql(), {}) // no `redact` option — the default export path

    // Schema: classified field now infers as TEXT (a plain string observed),
    // not JSONB (which is what a SealedHandle object used to infer as).
    expect(sql).toMatch(/"pan"\s+TEXT/)
    expect(sql).not.toContain('JSONB')

    // Data: the row literal is the bare marker string, not a JSON-stringified
    // SealedHandle (which pre-#629-flip rendered as the quoted `'"[sealed]"'`).
    expect(sql).toContain("'[sealed]'")
    expect(sql).not.toContain('\'"[sealed]"\'')
    expect(sql).not.toContain('4242424242424242')
  })
})
