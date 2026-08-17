/**
 * After a revocation, NO retained key may open ANY stored envelope (#1108).
 *
 * ## The defect
 *
 * `rotateKeys` re-keyed by collection NAME, which assumes DEK-name and
 * collection-name are 1:1. They are not:
 *
 * - a `_history` snapshot is filed under `_history` but sealed under its
 *   **source** collection's DEK;
 * - `_ledger_deltas` is sealed under the `_ledger` DEK.
 *
 * So revocation rotated the live records and left every prior version readable
 * under the key the revoked member kept. For a history-enabled collection that
 * is substantially its whole content — the newest version was denied and
 * v1…v(n−1) were not. #1054 removed `rotateKeys: false` precisely to make
 * revocation meaningful; it was meaningful for one version per record.
 *
 * ## Why row 1 is written as an INVARIANT and not as a list of surfaces
 *
 * The bug was not that someone mis-implemented `_history`. It was that rotation
 * consulted a **registry of collection names** that nobody updated when a
 * service started sealing envelopes under a borrowed DEK. A test that checked
 * `_history` and `_ledger_deltas` specifically would reproduce that exact
 * failure mode: it would pass while a third surface leaked.
 *
 * So row 1 asks the question in the **output domain** — *does any retained key
 * open anything?* — and deliberately does not import or mirror the fix's table.
 * A service that adds a fourth such surface fails HERE, without anyone having
 * remembered this file exists.
 *
 * That is the same lesson the peer-floor work landed on: an assertion about the
 * result finds the cases nobody pictured; an enumeration of known inputs finds
 * only the ones already imagined.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { openEnvelopeJson, type EnclaveKey } from '../src/kernel/enclave/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const VAULT = 'acme'

/**
 * Every collection this suite could plausibly populate. Listing collections is
 * NOT in the six-method store contract, and `loadAll` excludes `_`-prefixed
 * ones, so an exhaustive sweep is not available — this is the widest net the
 * contract allows, and it is deliberately wider than the fix's own table.
 */
const SWEEP = [
  'docs', 'notes',
  '_history', '_ledger', '_ledger_deltas', '_users', '_meta', '_schemas',
  '_vec', '_ft', '_blobs', '_blob_index', '_blob_chunks', '_versions',
]

/** Which `(collection, id)` envelopes does any key in `keys` still open? */
async function readableWith(
  store: NoydbStore,
  keys: ReadonlyMap<string, EnclaveKey>,
): Promise<string[]> {
  const hits: string[] = []
  for (const collection of SWEEP) {
    let ids: string[] = []
    try { ids = await store.list(VAULT, collection) } catch { continue }
    for (const id of ids) {
      const env = await store.get(VAULT, collection, id)
      if (!env || !env._iv) continue // no sealed body — nothing to open
      for (const [keyName, key] of keys) {
        try {
          await openEnvelopeJson({ collection, id }, env, key)
          hits.push(`${collection}/${id} (via '${keyName}')`)
          break
        } catch { /* not this key */ }
      }
    }
  }
  return hits
}

async function seeded() {
  const store = memoryStore()
  const db = await createNoydb({
    teamStrategy: withTeam(),
    historyStrategy: withHistory(),
    store, user: 'owner', secret: 'owner-pass-1',
  })
  const vault = await db.openVault(VAULT)
  // Two collections, each with a superseded version, so a per-collection filter
  // bug shows up as a partial pass rather than a clean one. History needs no
  // per-collection option — passing `historyStrategy` is what enables it.
  const docs = vault.collection<{ n: number }>('docs')
  await docs.put('d1', { n: 1 })
  await docs.put('d1', { n: 2 })
  const notes = vault.collection<{ n: number }>('notes')
  await notes.put('n1', { n: 9 })
  await notes.put('n1', { n: 10 })

  await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
  const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
  // The keys bob walks away with — captured BEFORE revocation, which is the
  // whole point: revocation cannot take back a key he already holds, it can
  // only make that key open nothing.
  const retained = new Map((await bobDb.openVault(VAULT))._introspectState().keyring.deks)
  return { store, db, retained }
}

describe('#1108 — revocation leaves no readable residue', () => {
  it('1. THE INVARIANT: after revoke, no retained key opens ANY envelope', async () => {
    const { store, db, retained } = await seeded()

    // Control: before revoking, the retained keys DO open things — otherwise
    // this asserts nothing and would pass against an empty vault.
    expect((await readableWith(store, retained)).length).toBeGreaterThan(0)

    await db.revoke(VAULT, { userId: 'bob' })

    const residue = await readableWith(store, retained)
    expect(residue, `retained keys still open:\n  ${residue.join('\n  ')}`).toEqual([])
  })

  it('2. the owner can still read everything — rotation re-keyed rather than destroyed', async () => {
    // The failure mode a too-eager fix would produce: making the residue
    // unreadable by breaking it. The data must survive under the NEW keys.
    const { store, db } = await seeded()
    await db.revoke(VAULT, { userId: 'bob' })

    const owner = await createNoydb({
      teamStrategy: withTeam(), historyStrategy: withHistory(),
      store, user: 'owner', secret: 'owner-pass-1',
    })
    const vault = await owner.openVault(VAULT)
    const docs = vault.collection<{ n: number }>('docs')
    expect(await docs.get('d1')).toEqual({ n: 2 })
    // and the prior version is still recoverable through the history API
    expect(await docs.getVersion('d1', 1)).toEqual({ n: 1 })
  })

  it('3. a SECOND revocation is still clean — rotation is repeatable', async () => {
    // Guards the resume/idempotency path: derived surfaces go through the same
    // `rekeyEnvelopeIfNeeded`, which returns null for anything already under the
    // new key. A second pass must neither leak nor corrupt.
    const { store, db, retained } = await seeded()
    await db.revoke(VAULT, { userId: 'bob' })

    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'admin', secret: 'carol-pass-1' })
    const carolDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'carol', secret: 'carol-pass-1' })
    const carolKeys = new Map((await carolDb.openVault(VAULT))._introspectState().keyring.deks)
    await db.revoke(VAULT, { userId: 'carol' })

    expect(await readableWith(store, carolKeys)).toEqual([])
    expect(await readableWith(store, retained)).toEqual([])
  })
})
