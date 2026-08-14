/**
 * #1074 part 2 — an interrupted rotation must be resumable, not fatal.
 *
 * The old `rotateKeys` generated the new DEK **in memory**, re-encrypted every
 * record, and persisted the keyring **last**. Interrupt it and the
 * already-rewritten records were sealed under a key that was never saved:
 * permanently unreadable, not merely un-migrated.
 *
 * These tests interrupt a real rotation — the store throws partway through the
 * loop — and then resume it. Asserting the *ordering* by reading the code's
 * shape would prove nothing; crash-safety claimed without a crash is exactly
 * the unexecuted claim this milestone exists to end.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withTeam } from '../src/with-party/team/index.js'

interface Doc { n: number }

const VAULT = 'acme'
const COLL = 'docs'

/** A store that throws on the Nth write to `docs`, simulating a kill mid-loop. */
function flakyStore(failOnNthDocWrite: number | null): NoydbStore & { docWrites: number } {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let vault = data.get(v); if (!vault) { vault = new Map(); data.set(v, vault) }
    let coll = vault.get(c); if (!coll) { coll = new Map(); vault.set(c, coll) }
    return coll
  }
  const store = {
    docWrites: 0,
    async get(v: string, c: string, id: string) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v: string, c: string, id: string, env: EncryptedEnvelope, ev?: number) {
      if (c === COLL) {
        store.docWrites++
        if (failOnNthDocWrite !== null && store.docWrites === failOnNthDocWrite) {
          throw new Error('EIO: simulated kill mid-rotation')
        }
      }
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
  return store as NoydbStore & { docWrites: number }
}

async function seed(store: NoydbStore, count: number) {
  const owner = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: 'pw' })
  const vault = await owner.openVault(VAULT)
  const docs = vault.collection<Doc>(COLL)
  for (let i = 0; i < count; i++) await docs.put(`d${i}`, { n: i })
  await owner.grant(VAULT, { userId: 'mallory', displayName: 'M', role: 'operator', secret: 'm-pw', permissions: { [COLL]: 'rw' } })
  return owner
}

async function readAll(store: NoydbStore, count: number): Promise<Array<number | string>> {
  const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: 'pw' })
  const docs = (await db.openVault(VAULT)).collection<Doc>(COLL)
  const out: Array<number | string> = []
  for (let i = 0; i < count; i++) {
    try { out.push((await docs.get(`d${i}`))?.n ?? 'MISSING') }
    catch (e) { out.push(`THREW:${(e as Error).constructor.name}`) }
  }
  return out
}

describe('#1074 part 2 — interrupted rotation is resumable', () => {
  it('1. baseline: an uninterrupted revoke-with-rotation leaves everything readable', async () => {
    const store = flakyStore(null)
    const owner = await seed(store, 6)
    await owner.revoke(VAULT, { userId: 'mallory' })
    expect(await readAll(store, 6)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('2. THE TEST: kill the rotation mid-loop, then resume — no record is lost', async () => {
    const store = flakyStore(null)
    const owner = await seed(store, 6)

    // Kill partway through the rotation's rewrite loop.
    const killing = flakyStoreWrap(store, 3)
    const ownerOnKilling = await createNoydb({ teamStrategy: withTeam(), store: killing, user: 'owner', secret: 'pw' })
    await expect(ownerOnKilling.revoke(VAULT, { userId: 'mallory' })).rejects.toThrow(/EIO/)

    // Resume by re-running the same operation against a healthy store.
    const ownerAgain = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: 'pw' })
    await ownerAgain.rotate(VAULT, [COLL])

    // Every record readable, none lost. Before the fix the records the killed
    // run had already rewritten were sealed under a DEK that was never
    // persisted, so this list came back full of decryption failures.
    expect(await readAll(store, 6)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('3. the pending key is persisted BEFORE any record is rewritten', async () => {
    // The property the fix rests on: if the key only appeared after the loop,
    // an interruption would strand every record the loop had touched.
    const store = flakyStore(null)
    await seed(store, 4)
    const killing = flakyStoreWrap(store, 1) // die on the very first rewrite

    const db = await createNoydb({ teamStrategy: withTeam(), store: killing, user: 'owner', secret: 'pw' })
    await expect(db.rotate(VAULT, [COLL])).rejects.toThrow(/EIO/)

    const keyringRaw = await store.get(VAULT, '_keyring', 'owner')
    expect(keyringRaw, 'owner keyring must exist').toBeTruthy()
    const file = JSON.parse(keyringRaw!._data) as { pending_deks?: Record<string, string> }
    expect(file.pending_deks?.[COLL], 'pending DEK must be on disk before the loop runs').toBeTruthy()
  })

  it('4. a completed rotation clears the pending marker', async () => {
    const store = flakyStore(null)
    const owner = await seed(store, 3)
    await owner.rotate(VAULT, [COLL])

    const keyringRaw = await store.get(VAULT, '_keyring', 'owner')
    const file = JSON.parse(keyringRaw!._data) as { pending_deks?: Record<string, string> }
    expect(file.pending_deks?.[COLL], 'a committed rotation must leave no pending marker').toBeFalsy()
  })
})

/** Wraps an existing store so the Nth write to `docs` throws. */
function flakyStoreWrap(inner: NoydbStore, failOnNth: number): NoydbStore {
  let writes = 0
  return {
    ...inner,
    async put(v, c, id, env, ev) {
      if (c === COLL) {
        writes++
        if (writes === failOnNth) throw new Error('EIO: simulated kill mid-rotation')
      }
      return inner.put(v, c, id, env, ev)
    },
  }
}
