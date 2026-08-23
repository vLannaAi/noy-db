/**
 * `ExportFormat` is an OPEN union — a third-party `NoydbFormat` can be
 * GRANTED, not merely checked.
 *
 * The regression this pins: `ExportFormat` was a closed union of the nine
 * formats hub ships bindings for, while `NoydbFormat.id` is a `string`. A
 * package outside this repo could therefore reach `assertCanExport` (the
 * gate is a runtime `Array.includes`) but its id could never appear in an
 * `exportCapability` grant without a type error — so the only way to
 * authorise it was the `'*'` wildcard, which grants every format at once.
 *
 * The two `format as never` casts in `port/as/active.ts` hid this: they
 * made hub's own call site compile while leaving every consumer stuck.
 */

import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ExportFormat } from '../src/kernel/types.js'
import type { NoydbFormat } from '../src/port/as/types.js'
import { withFormats } from '../src/port/as/active.js'
import { ExportCapabilityError } from '../src/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withTeam } from '../src/with-party/team/index.js'

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

/** A format hub has never heard of — the whole point of the test. */
const asGsheet = (): NoydbFormat<string> => ({
  id: 'gsheet',
  extension: 'gsheet',
  mimeType: 'application/vnd.google-apps.spreadsheet',
  tier: 'plaintext',
  encode: chunks => JSON.stringify(chunks.map(c => c.collection)),
})

async function seed(plaintext: readonly ExportFormat[]) {
  const adapter = toMemory()
  const opts = { formatsStrategy: withFormats(), teamStrategy: withTeam(), store: adapter, user: 'owner', secret: 'pw' }
  const db = await createNoydb(opts)
  const v = await db.openVault('acme')
  await v.collection<{ id: string }>('invoices').put('i1', { id: 'i1' })
  await db.grant('acme', {
    userId: 'owner', displayName: 'Owner', role: 'owner', secret: 'pw',
    exportCapability: { plaintext },
  })
  await db.close()
  const db2 = await createNoydb(opts)
  return { vault: await db2.openVault('acme') }
}

describe('ExportFormat is open — third-party format ids', () => {
  it('a grant naming an id hub does not ship TYPECHECKS and authorises', async () => {
    // If `ExportFormat` were closed this line would not compile — which is
    // the defect, not a style point. The assertion below is secondary.
    const { vault } = await seed(['gsheet'])
    await expect(vault.export(asGsheet(), {})).resolves.toContain('invoices')
  })

  it('the gate still refuses an unrelated grant — open does not mean ungated', async () => {
    const { vault } = await seed(['csv'])
    await expect(vault.export(asGsheet(), {})).rejects.toBeInstanceOf(ExportCapabilityError)
  })

  it('a typo in a grant typechecks and then FAILS CLOSED at runtime', async () => {
    // The stated cost of the open union. It fails in the safe direction:
    // the gate is an exact-match lookup, so `'gsheeet'` authorises nothing.
    const { vault } = await seed(['gsheeet'])
    await expect(vault.export(asGsheet(), {})).rejects.toBeInstanceOf(ExportCapabilityError)
  })

  it('a format declaring a BLANK id throws TypeError, not ExportCapabilityError', async () => {
    // Reachable through the public API: `NoydbFormat.id` is a `string`, so a
    // third-party binding can ship `id: ''`. Without the guard it reaches the
    // gate, misses the allowlist, and reports a capability problem — sending
    // the reader to the keyring to fix a bug that is in the format.
    const { vault } = await seed(['*'])
    const broken = { ...asGsheet(), id: '' }
    await expect(vault.export(broken, {})).rejects.toBeInstanceOf(TypeError)
  })

  it("'*' still grants a format hub has never heard of", async () => {
    const { vault } = await seed(['*'])
    await expect(vault.export(asGsheet(), {})).resolves.toContain('invoices')
  })
})
