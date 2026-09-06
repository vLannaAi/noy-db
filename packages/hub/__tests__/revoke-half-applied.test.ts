/**
 * Probe: what state does a FAILED `revoke()` leave behind? (#1077)
 *
 * `revoke()` deletes the target's keyring entry and *then* rotates
 * (`keyring.ts` — delete at the top of the loop, `rotateKeys` at the end). There
 * is no transaction and no compensation. So if rotation fails for any reason,
 * the roster entry is gone but the keys are unchanged — and rotation is the only
 * thing that makes a RETAINED copy of that keyring worthless (#1054 measured
 * exactly that).
 *
 * The sting is the retry. `revoke()` opens by reading the target's keyring and
 * throwing `NoAccessError` when it is absent — which, after a partial revoke,
 * is indistinguishable from "already revoked, nothing to do".
 *
 * Before #1075 this fired on every per-record-CEK vault, because rotation threw
 * outright on those. That path is fixed, but the ORDERING is not: any rotation
 * failure still produces this state.
 *
 * RESULT, and the two halves differ:
 *
 * - The operator-facing half is REAL and demonstrated. The retry is
 *   indistinguishable from "already revoked".
 * - The access half was NOT reproduced. A member replaying their own pre-revoke
 *   keyring snapshot reads nothing — every record throws, including ones the
 *   interrupted rotation never touched.
 *
 * The mechanism behind that is unexplained, and this test deliberately asserts
 * the OUTCOME rather than a story about why. It is evidence that this specific
 * attacker model fails, not evidence that the half-applied state is safe.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, NoAccessError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withTeam } from '../src/with-party/team/index.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../src/kernel/query/relate/index.js'

interface Doc { n: number }
const VAULT = 'acme'
const COLL = 'docs'

function memStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let vault = data.get(v); if (!vault) { vault = new Map(); data.set(v, vault) }
    let coll = vault.get(c); if (!coll) { coll = new Map(); vault.set(c, coll) }
    return coll
  }
  return {
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { const x = data.get(v)?.get(c); return x ? [...x.keys()] : [] },
    async loadAll(v) {
      const vault = data.get(v); const snap: VaultSnapshot = {}
      if (vault) for (const [n, coll] of vault) {
        if (n.startsWith('_')) continue
        const recs: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) recs[id] = e
        snap[n] = recs
      }
      return snap
    },
    async saveAll(v, snap) {
      for (const [n, recs] of Object.entries(snap)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

/** Fails the Nth write to `docs` — i.e. partway through rotation's rewrite. */
function failingRotation(inner: NoydbStore, failOnNth: number): NoydbStore {
  let writes = 0
  return {
    ...inner,
    async put(v, c, id, env, ev) {
      if (c === COLL) {
        writes++
        if (writes === failOnNth) throw new Error('EIO: rotation write failed')
      }
      return inner.put(v, c, id, env, ev)
    },
  }
}

describe('#1077 — a failed revoke() leaves a half-applied state', () => {
  it('deletes the roster entry, does NOT rotate, and the retry reads as success', async () => {
    const store = memStore()
    const owner = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: 'pw' })
    const vault = await owner.openVault(VAULT)
    for (let i = 0; i < 5; i++) await vault.collection<Doc>(COLL).put(`d${i}`, { n: i })
    await owner.grant(VAULT, {
      userId: 'mallory', displayName: 'M', role: 'operator', secret: 'm-pw', permissions: { [COLL]: 'rw' },
    })

    // Snapshot Mallory's keyring — this is the "retained copy" a revoked member
    // keeps on their own device in a local-first deployment. Deleting the
    // server-side entry does not reach it; only rotation makes it worthless.
    const retained = await store.get(VAULT, '_keyring', 'mallory')
    expect(retained, 'precondition: mallory has a keyring').toBeTruthy()

    // Revoke, with rotation failing partway.
    const breaking = failingRotation(store, 3)
    const ownerBroken = await createNoydb({ teamStrategy: withTeam(), store: breaking, user: 'owner', secret: 'pw' })
    await expect(ownerBroken.revoke(VAULT, { userId: 'mallory' })).rejects.toThrow(/EIO/)

    // 1. The roster entry IS gone — delete ran before rotation.
    expect(await store.get(VAULT, '_keyring', 'mallory')).toBeNull()

    // 2. THE RETRY NOW RESUMES (#1077 fix). It used to throw NoAccessError,
    //    because the roster entry the first attempt deleted was missing — which
    //    reads as "already revoked, nothing to do" and stopped the operator
    //    while the keys were never rotated. The failure was silent because it
    //    looked like success. An uncommitted rotation on the caller's keyring is
    //    now taken as evidence of exactly that state, and finished.
    const ownerRetry = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: 'pw' })
    await ownerRetry.revoke(VAULT, { userId: 'mallory' })

    // ...and it COMPLETED the rotation rather than merely not throwing.
    const ownerKeyring = await store.get(VAULT, '_keyring', 'owner')
    const ownerFile = JSON.parse(ownerKeyring!._data) as { pending_deks?: Record<string, string> }
    expect(ownerFile.pending_deks?.[COLL], 'retry must COMPLETE the rotation').toBeFalsy()

    // 3. ...but the rotation never completed, so the retained copy still opens
    //    the data. Restore it the way a hostile store, a replica, or the
    //    member's own device would.
    await store.put(VAULT, '_keyring', 'mallory', retained!)
    const mallory = await createNoydb({ teamStrategy: withTeam(), store, user: 'mallory', secret: 'm-pw' })
    const docs = (await mallory.openVault(VAULT)).collection<Doc>(COLL)

    // Rotation stopped partway, so the collection is split: records it reached
    // are re-keyed, records it did not are still under the old DEK and open to
    // the retained keyring. Count them rather than guessing which is which —
    // `list()` order is not insertion order.
    const outcomes: string[] = []
    for (let i = 0; i < 5; i++) {
      try { const r = await docs.get(`d${i}`); outcomes.push(r === null ? 'null' : `n=${r.n}`) }
      catch (e) { outcomes.push(`THREW:${(e as Error).constructor.name}`) }
    }
    // MEASURED, and it contradicts the hypothesis this probe was written to
    // test. Every record throws — a retained keyring grants the revoked member
    // nothing, even though rotation did not complete.
    //
    // The MECHANISM is not established. The obvious explanation — that
    // `revoke()` strips the collection from other members' keyrings first — is
    // wrong: that step lives INSIDE `rotateKeys`, after the record loop, and
    // the loop threw before reaching it. Every record throwing (including ones
    // rotation never touched) points at something shared rather than
    // per-record, but that is a hypothesis, not a finding.
    //
    // This does NOT prove the half-applied state is harmless in general. It
    // proves it is harmless for THIS attacker model (a member replaying their
    // own snapshot). A retained copy taken at a different moment, or a store
    // that also replays the owner's pre-revoke keyring, is a different
    // question and is not tested here.
    expect(outcomes.every(o => o.startsWith('THREW:')), outcomes.join(' | ')).toBe(true)
  })
})
