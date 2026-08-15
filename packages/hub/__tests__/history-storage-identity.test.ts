/**
 * A history snapshot is sealed against its STORAGE identity (#1041).
 *
 * ## The decision these tests lock in
 *
 * A snapshot is a *copy*, so two identities are available: the live record it
 * copies (`collection`/`recordId`), or where its bytes actually land
 * (`_history`/`historyId(...)`). They are not equivalent under attack.
 *
 * Binding the LIVE identity makes a snapshot's AAD **indistinguishable from the
 * live record's at the same version** — an untrusted store could serve a
 * history entry *as the current record* and the client would accept it. Storage
 * identity closes that, and also stops entries being relocated within
 * `_history`.
 *
 * ## What can and cannot be asserted yet
 *
 * AAD is not switched on (that is #1041's one-line change inside
 * `buildRecordEnvelope`), so "which identity is bound" is not yet *observable*
 * from an envelope. What IS observable, and is the property that makes the
 * eventual binding correct, is that **the identity the writer seals against and
 * the location `saveHistory` writes to are the same derivation**. If those ever
 * diverge, every history snapshot becomes undecryptable the day AAD lands —
 * silently, and only for records that have history.
 *
 * So these assert the shared derivation, against a store that records exactly
 * where bytes were put. Asserting it by reading the code would prove nothing.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory, historyIdentity } from '../src/with-commit/history/index.js'
import { NO_HISTORY } from '../src/with-commit/history/strategy.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

interface Doc { n: number }
const VAULT = 'acme'
const COLL = 'docs'

/** Memory store that records every (collection, id) it was written at. */
function recordingStore(): NoydbStore & { puts: Array<{ c: string; id: string }> } {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const puts: Array<{ c: string; id: string }> = []
  const gc = (v: string, c: string) => {
    let vault = data.get(v); if (!vault) { vault = new Map(); data.set(v, vault) }
    let coll = vault.get(c); if (!coll) { coll = new Map(); vault.set(c, coll) }
    return coll
  }
  const store = {
    puts,
    async get(v: string, c: string, id: string) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v: string, c: string, id: string, env: EncryptedEnvelope, ev?: number) {
      puts.push({ c, id })
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v: string, c: string, id: string) { data.get(v)?.get(c)?.delete(id) },
    async list(v: string, c: string) { const x = data.get(v)?.get(c); return x ? [...x.keys()] : [] },
    async loadAll(v: string) {
      const vault = data.get(v); const snap: VaultSnapshot = {}
      if (vault) for (const [n, coll] of vault) {
        if (n.startsWith('_')) continue
        const recs: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) recs[id] = e
        snap[n] = recs
      }
      return snap
    },
    async saveAll(v: string, snap: VaultSnapshot) {
      for (const [n, recs] of Object.entries(snap)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
  return store as NoydbStore & { puts: Array<{ c: string; id: string }> }
}

describe('#1041 — history snapshots seal against their storage identity', () => {
  it('1. THE PROPERTY: the snapshot lands exactly where historyIdentity() says', async () => {
    const store = recordingStore()
    const db = await createNoydb({ historyStrategy: withHistory(), store, user: 'owner', secret: 'pw' })
    const docs = (await db.openVault(VAULT)).collection<Doc>(COLL)

    await docs.put('d1', { n: 1 })   // v1, no prior → no snapshot
    await docs.put('d1', { n: 2 })   // overwrites v1 → snapshots v1

    // The snapshot of version 1 must sit at the identity the writer sealed
    // against. Computed independently here, not read back from the store.
    const expected = historyIdentity(COLL, 'd1', 1)
    expect(store.puts).toContainEqual({ c: expected.collection, id: expected.id })
    expect(expected.collection).toBe('_history')
  })

  it('2. it is NOT the live identity — the two must not be confusable', async () => {
    // The whole point of the decision: a snapshot must not be addressable the
    // way the live record is, or a store could serve one as the other.
    const ident = historyIdentity(COLL, 'd1', 1)
    expect(ident.collection).not.toBe(COLL)
    expect(ident.id).not.toBe('d1')
  })

  it('3. version is part of the identity, so two snapshots never collide', async () => {
    const a = historyIdentity(COLL, 'd1', 1)
    const b = historyIdentity(COLL, 'd1', 2)
    expect(a.id).not.toBe(b.id)
  })

  it('4. collection is part of it, so same-id records in different collections differ', async () => {
    expect(historyIdentity('a', 'x', 1).id).not.toBe(historyIdentity('b', 'x', 1).id)
  })

  it('5. every snapshot version is reachable and correct after several writes', async () => {
    const store = recordingStore()
    const db = await createNoydb({ historyStrategy: withHistory(), store, user: 'owner', secret: 'pw' })
    const docs = (await db.openVault(VAULT)).collection<Doc>(COLL)
    for (let n = 1; n <= 4; n++) await docs.put('d1', { n })

    // Versions 1..3 are snapshotted (4 is live). Each must be at its own
    // storage identity — this is what breaks if the derivations ever diverge.
    for (const v of [1, 2, 3]) {
      const { collection, id } = historyIdentity(COLL, 'd1', v)
      expect(await store.get(VAULT, collection, id), `history v${v} missing`).toBeTruthy()
    }
  })

  it('6. THE CHANGE ITSELF: the writer CONSULTS historyIdentity before sealing', async () => {
    // Tests 1-5 pass with or without #1041's restructure, because `saveHistory`
    // always PUT snapshots at this location — it derived the id afterwards from
    // `envelope._v`. What the restructure changed is that the writer now asks
    // for the identity BEFORE sealing, which is the only thing that makes the
    // eventual AAD binding correct. So assert the call, not just the location.
    const real = withHistory()
    const asked: Array<[string, string, number]> = []
    const spy = {
      ...real,
      historyIdentity: (c: string, r: string, v: number) => {
        asked.push([c, r, v])
        return real.historyIdentity(c, r, v)
      },
    }
    const store = recordingStore()
    const db = await createNoydb({ historyStrategy: spy, store, user: 'owner', secret: 'pw' })
    const docs = (await db.openVault(VAULT)).collection<Doc>(COLL)

    await docs.put('d1', { n: 1 })
    expect(asked, 'a first write has no prior version, so nothing is sealed').toEqual([])

    await docs.put('d1', { n: 2 })
    // Asked for the identity of the version being SNAPSHOTTED (v1), not the one
    // being written (v2) — sealing a snapshot under the live version's identity
    // would collide with the next snapshot.
    expect(asked).toContainEqual([COLL, 'd1', 1])
  })

  it('7. NO_HISTORY still answers historyIdentity — it must never return a sentinel', async () => {
    // The stub's saveHistory is a no-op, so nothing is sealed. But a caller that
    // reads the identity without writing must not get a fake: a sentinel here
    // would seal real envelopes against a location nothing writes to.
    expect(NO_HISTORY.historyIdentity(COLL, 'd1', 1)).toEqual(historyIdentity(COLL, 'd1', 1))
  })
})
