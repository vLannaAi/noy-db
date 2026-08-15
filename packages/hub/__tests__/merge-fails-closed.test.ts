/**
 * The merge fails closed against a hostile remote (#1042).
 *
 * ## What was wrong
 *
 * `applyRemote` committed store-supplied ciphertext with no verify step. A
 * remote that served a forged envelope had it written into the local store
 * FIRST; the client discovered the problem at read time, by which point its own
 * newer copy was already gone. Detection after destruction is not a defence.
 *
 * AAD (#1041) alone could not fix this: AAD is checked inside `subtle.decrypt`,
 * and the merge never decrypts — `with-sync` is DEK-free by design and
 * `check:architecture` enforces it. Hence the injected `MergeAuthority`.
 *
 * ## What these assert
 *
 * Not "an error appeared" — that is satisfiable by any throw. The property is
 * **the local copy survives**: a rejection must cost the client nothing. Each
 * case therefore checks the stored bytes afterwards, and a control proves an
 * untampered pull still applies, so a pass cannot come from the merge simply
 * refusing everything.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

interface Doc { secret: string }
const VAULT = 'acme'
const COLL = 'docs'

/**
 * Two peers over one shared remote — **sharing a keyring**, which is what makes
 * this a peer pair rather than two unrelated vaults.
 *
 * Two subtleties, both learned the hard way:
 *
 *  1. Two independent `createNoydb` calls with the same secret mint DIFFERENT
 *     collection DEKs, so B could not decrypt anything of A's and every verify
 *     would fail for the wrong reason.
 *  2. A collection's DEK is minted on its FIRST WRITE. Copying A's keyring
 *     before A writes therefore copies a keyring with no `docs` entry — B ends
 *     up keyless, `verify` cannot judge, and every forgery sails through. The
 *     first version of this fixture did exactly that and the tests "passed" by
 *     asserting nothing.
 *
 * So B is opened LAZILY, after A's writes, via `openB()`.
 */
async function peers() {
  const remote = memoryStore()
  const localA = memoryStore()
  const localB = memoryStore()

  const dbA = await createNoydb({ syncStrategy: withSync(), store: localA, sync: remote, user: 'owner', secret: 'pw' })
  const vaultA = await dbA.openVault(VAULT)

  /** Copy A's keyring onto B's device, then open B. Call AFTER A has written. */
  const openB = async () => {
    for (const id of await localA.list(VAULT, '_keyring')) {
      await localB.put(VAULT, '_keyring', id, (await localA.get(VAULT, '_keyring', id))!)
    }
    const dbB = await createNoydb({ syncStrategy: withSync(), store: localB, sync: remote, user: 'owner', secret: 'pw' })
    return { db: dbB, vault: await dbB.openVault(VAULT) }
  }

  return { remote, a: { db: dbA, vault: vaultA }, openB, localA, localB }
}

describe('#1042 — applyRemote verifies before committing', () => {
  it('0. CONTROL: an untampered pull still applies — the gate is not refusing everything', async () => {
    const { remote, a, openB, localB } = await peers()
    await a.vault.collection<Doc>(COLL).put('d1', { secret: 'genuine' })
    await a.db.push(VAULT)
    const b = await openB()

    const result = await b.db.pull(VAULT)
    expect(result.errors).toEqual([])
    expect(await localB.get(VAULT, COLL, 'd1')).not.toBeNull()
    void remote
  })

  it('1. a RELOCATED envelope is rejected, and the local copy is untouched', async () => {
    const { remote, a, openB, localB } = await peers()
    // A writes first so the collection DEK exists to copy; then B joins and
    // makes its own genuine d1.
    await a.vault.collection<Doc>(COLL).put('d2', { secret: 'theirs' })
    await a.db.push(VAULT)
    const b = await openB()
    await b.vault.collection<Doc>(COLL).put('d1', { secret: 'mine, newer' })

    const before = await localB.get(VAULT, COLL, 'd1')

    // The hostile store serves d2's bytes under d1 — a relocation, which is all
    // ciphertext-level access allows. It never needs a key.
    const d2 = (await remote.get(VAULT, COLL, 'd2'))!
    await remote.put(VAULT, COLL, 'd1', { ...d2, _v: (before!._v ?? 0) + 5 })

    const result = await b.db.pull(VAULT)

    // Rejected...
    expect(result.errors.length).toBeGreaterThan(0)
    // ...and — the property that matters — B's own record is byte-identical.
    // Before #1042 the forged envelope was committed first and B's copy lost.
    expect(await localB.get(VAULT, COLL, 'd1')).toEqual(before)
  })

  it('2. a RE-AUTHORED envelope is rejected and does not overwrite', async () => {
    const { remote, a, openB, localB } = await peers()
    await a.vault.collection<Doc>(COLL).put('d1', { secret: 'theirs' })
    await a.db.push(VAULT)
    const b = await openB()
    await b.vault.collection<Doc>(COLL).put('d1', { secret: 'mine' })

    const before = await localB.get(VAULT, COLL, 'd1')
    const served = (await remote.get(VAULT, COLL, 'd1'))!
    await remote.put(VAULT, COLL, 'd1', { ...served, _by: 'mallory', _v: (before!._v ?? 0) + 5 })

    const result = await b.db.pull(VAULT)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(await localB.get(VAULT, COLL, 'd1')).toEqual(before)
  })

  it('3. ONE poisoned record does not halt the sync — the rest still apply', async () => {
    // A hostile store would like a single forgery to stop replication entirely.
    // Rejection is per-entry: the bad one lands in `errors`, the good ones land
    // in the store.
    const { remote, a, openB, localB } = await peers()
    await a.vault.collection<Doc>(COLL).put('good-1', { secret: 'one' })
    await a.vault.collection<Doc>(COLL).put('bad', { secret: 'two' })
    await a.vault.collection<Doc>(COLL).put('good-2', { secret: 'three' })
    await a.db.push(VAULT)
    const b = await openB()

    const good1 = (await remote.get(VAULT, COLL, 'good-1'))!
    await remote.put(VAULT, COLL, 'bad', good1) // 'bad' now serves good-1's bytes

    const result = await b.db.pull(VAULT)

    expect(result.errors.length).toBe(1)
    expect(await localB.get(VAULT, COLL, 'good-1')).not.toBeNull()
    expect(await localB.get(VAULT, COLL, 'good-2')).not.toBeNull()
    expect(await localB.get(VAULT, COLL, 'bad')).toBeNull()
  })

  it('4. the rejection names the record, so an operator can act on it', async () => {
    // A generic "sync failed" is indistinguishable from a network blip. This is
    // an integrity event and has to read like one.
    const { remote, a, openB } = await peers()
    await a.vault.collection<Doc>(COLL).put('d1', { secret: 'one' })
    await a.vault.collection<Doc>(COLL).put('d2', { secret: 'two' })
    await a.db.push(VAULT)
    const b = await openB()
    const d2 = (await remote.get(VAULT, COLL, 'd2'))!
    await remote.put(VAULT, COLL, 'd1', d2)

    const result = await b.db.pull(VAULT)
    expect(result.errors[0]?.message).toMatch(/docs\/d1/)
    expect(result.errors[0]?.message).toMatch(/does not authenticate/i)
  })

  it('5. RESIDUE, stated not hidden: a peer with NO key for the collection accepts unverified', async () => {
    // B has never written to `docs`, so it holds no DEK for it and cannot judge
    // what it is given. It accepts — deliberately.
    //
    // Rejecting instead would break replication of data a peer legitimately
    // holds but this client is not cleared to read, turning a confidentiality
    // boundary into a replication failure. The forged record is inert here: B
    // cannot decrypt it either, and — the part that matters — it displaced
    // nothing, because B had no copy to lose.
    //
    // Closing this needs the vault head (#1044), which detects substitution
    // without holding the key. Asserted so the boundary cannot move silently.
    const { remote, a, openB, localB } = await peers()
    // B joins knowing only `docs`. A then writes a SECOND collection, whose DEK
    // B never receives — the realistic shape of "data this peer is not cleared
    // to read".
    await a.vault.collection<Doc>(COLL).put('seed', { secret: 'x' })
    await a.db.push(VAULT)
    const b = await openB()

    const OTHER = 'restricted'
    await a.vault.collection<Doc>(OTHER).put('good-1', { secret: 'one' })
    await a.vault.collection<Doc>(OTHER).put('bad', { secret: 'two' })
    await a.db.push(VAULT)
    const good1 = (await remote.get(VAULT, OTHER, 'good-1'))!
    await remote.put(VAULT, OTHER, 'bad', good1)

    const result = await b.db.pull(VAULT)
    expect(result.errors).toEqual([])                              // no key → no judgement
    expect(await localB.get(VAULT, OTHER, 'bad')).not.toBeNull()   // accepted…
    await expect(b.vault.collection<Doc>(OTHER).get('bad')).rejects.toThrow() // …but unreadable
  })

  it('6. a tombstone still replicates — it carries no sealed body to verify', async () => {
    // The gate must not break erasure propagation, which is the one thing that
    // MUST cross a sync boundary even when unverifiable.
    const { a, openB, localB } = await peers()
    await a.vault.collection<Doc>(COLL).put('d1', { secret: 'gone soon' })
    await a.db.push(VAULT)
    const b = await openB()
    await b.db.pull(VAULT)
    await a.vault.collection<Doc>(COLL).delete('d1')
    await a.db.push(VAULT)

    const result = await b.db.pull(VAULT)
    expect(result.errors).toEqual([])
    expect(await (b.vault.collection<Doc>(COLL)).get('d1')).toBeNull()
    void localB
  })
})
