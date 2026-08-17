/**
 * A hostile store cannot alter, relocate, re-tier or re-author a record (#1041).
 *
 * ## Why this file exists
 *
 * Every other test in the suite proves the product works when nothing is
 * attacking it. This one proves the property the work was DONE for. Without it,
 * "AAD is bound" is a claim nothing executes — and the whole point of ADR 0003
 * is that a claim nothing executes is how this codebase's defects survive.
 *
 * Each case tampers with a stored envelope exactly the way an untrusted backend
 * could — it never sees a key, only ciphertext and plaintext metadata — and
 * asserts the client REFUSES it. `SECURITY.md`'s replacement sentence is the
 * spec: *a store cannot alter, relocate, re-tier, re-author or rewind any
 * record it serves; without `withVaultHead()` it can still withhold or omit.*
 *
 * ## Every row must be able to fail
 *
 * A row that passes because nothing was actually tampered with is worthless, so
 * each one first proves the UNtampered record reads back correctly. That is the
 * "the gate is capable of failing" standard the peer-floor work established:
 * "it threw" and "it threw for the reason I think" are different claims.
 *
 * **`_v` joined the tuple in #1093, and rows 9–11 say exactly what that did
 * and did not buy.** A stale body can no longer be RELABELLED as the current
 * version (10) and a version can no longer be inflated (11) — so a rollback can
 * never win a convergence comparison. A store re-serving a genuine old version
 * *at its own number* still succeeds (9), because that is withholding the newer
 * one, which is `withVaultHead()`'s job and not AAD's.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

interface Doc { secret: string }
const VAULT = 'acme'
const COLL = 'docs'
const OTHER = 'other'

/** A fresh client over the same bytes — a cold read, never a cache hit. */
async function coldRead(store: NoydbStore, collection = COLL, id = 'd1'): Promise<Doc | null> {
  const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
  return (await db.openVault(VAULT)).collection<Doc>(collection).get(id)
}

async function seed(): Promise<{ store: NoydbStore; env: EncryptedEnvelope }> {
  const store = memoryStore()
  const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
  const vault = await db.openVault(VAULT)
  await vault.collection<Doc>(COLL).put('d1', { secret: 'the eagle lands at dawn' })
  await vault.collection<Doc>(OTHER).put('placeholder', { secret: 'unrelated' })
  const env = (await store.get(VAULT, COLL, 'd1'))!
  return { store, env }
}

describe('#1041 — an untrusted store cannot alter, relocate, re-tier or re-author', () => {
  it('0. CONTROL: an untouched record reads back — so every refusal below is caused by the tampering', async () => {
    const { store } = await seed()
    expect(await coldRead(store)).toEqual({ secret: 'the eagle lands at dawn' })
  })

  it('1. RELOCATE across collections — the same bytes served under another collection', async () => {
    const { store, env } = await seed()
    // The store copies d1's envelope verbatim into `other`. No key needed: it
    // is moving ciphertext, which is all it ever holds.
    await store.put(VAULT, OTHER, 'd1', env)
    await expect(coldRead(store, OTHER)).rejects.toThrow()
  })

  it('2. RELOCATE within a collection — served under a different record id', async () => {
    const { store, env } = await seed()
    await store.put(VAULT, COLL, 'd2', env)
    await expect(coldRead(store, COLL, 'd2')).rejects.toThrow()
  })

  // ⚠️ MEASURED, and it CORRECTS ADR 0003's harness table.
  //
  // The ADR lists "flip `_tier` to hide a record → rejected → D2". That is
  // wrong, and this row is what found it. Raising `_tier` does NOT reach AAD at
  // all: the tier-0 read gate gives up on any envelope claiming `_tier > 0`
  // BEFORE decrypting (`collection.ts` treats elevated as missing), so the
  // record comes back `null`.
  //
  // And it cannot be fixed by reordering. A reader holding only the tier-0 DEK
  // has no way to tell a GENUINELY elevated record from a faked one — both fail
  // to open under the key it has. So an upward re-tier is **withholding**, not
  // alteration, and withholding is exactly what `SECURITY.md` still concedes
  // without `withVaultHead()` (#1044).
  //
  // Recorded as the real behaviour rather than deleted, because a row asserting
  // a defence that does not exist is worse than no row.
  it('3a. RE-TIER UP is WITHHOLDING, not alteration — the record is hidden, and AAD cannot see it', async () => {
    const { store, env } = await seed()
    await store.put(VAULT, COLL, 'd1', { ...env, _tier: 2 })
    // Not a throw. The tier gate returns "absent" before any key is used.
    expect(await coldRead(store)).toBeNull()
  })

  it('3b. RE-TIER DOWN is refused — a tier-N body cannot be passed off as tier 0', async () => {
    // The direction that DOES reach crypto: an elevated record relabelled as
    // tier 0 is decrypted with the tier-0 DEK, which is not the key it was
    // sealed under, so it fails closed.
    const store = memoryStore()
    const db = await createNoydb({ tiersStrategy: withTiers(), store, user: 'owner', secret: 'pw' })
    const vault = await db.openVault(VAULT)
    const tiered = vault.collection<Doc>(COLL, { tiers: [0, 1] })
    await tiered.put('d1', { secret: 'sensitive' })
    await tiered.elevate('d1', 1)
    const elevated = (await store.get(VAULT, COLL, 'd1'))!
    const { _tier, _elevatedBy, ...relabelled } = elevated
    void _tier; void _elevatedBy
    await store.put(VAULT, COLL, 'd1', relabelled as EncryptedEnvelope)
    await expect(coldRead(store)).rejects.toThrow()
  })

  it('4. RE-AUTHOR — forging `_by` to misattribute a record', async () => {
    const { store, env } = await seed()
    await store.put(VAULT, COLL, 'd1', { ...env, _by: 'mallory' })
    await expect(coldRead(store)).rejects.toThrow()
  })

  it('5. STRIP `_by` — removing provenance rather than forging it', async () => {
    // Deletion has to fail too. AAD folds "absent" and "present" through a
    // presence flag precisely so dropping a field is not a free edit.
    const { store, env } = await seed()
    const { _by, ...stripped } = env
    void _by
    await store.put(VAULT, COLL, 'd1', stripped as EncryptedEnvelope)
    await expect(coldRead(store)).rejects.toThrow()
  })

  it('6. SPLICE — another record’s body under this record’s metadata', async () => {
    const { store } = await seed()
    const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
    await (await db.openVault(VAULT)).collection<Doc>(COLL).put('d2', { secret: 'a different secret' })
    const d1 = (await store.get(VAULT, COLL, 'd1'))!
    const d2 = (await store.get(VAULT, COLL, 'd2'))!
    // Same collection, same author, same tier — only the body is swapped in.
    await store.put(VAULT, COLL, 'd1', { ...d1, _iv: d2._iv, _data: d2._data })
    await expect(coldRead(store)).rejects.toThrow()
  })

  it('7. `_noydb` is inert — editing it changes nothing, because nothing reads it', async () => {
    // Recorded as a POSITIVE result, not an omission. ADR 0003 deletes the
    // format-downgrade lever by having no second format and no reader that
    // branches on the marker. This asserts that: the record still opens.
    const { store, env } = await seed()
    await store.put(VAULT, COLL, 'd1', { ...env, _noydb: 99 } as unknown as EncryptedEnvelope)
    expect(await coldRead(store)).toEqual({ secret: 'the eagle lands at dawn' })
  })

  // ⚠️ MEASURED, and it narrows what #1093 may claim — the same correction
  // row 3a made for `_tier`, found the same way.
  //
  // A plain re-serve of the genuine v1 still OPENS. It has to: the envelope is
  // internally consistent, sealed at `_v: 1` and labelled `_v: 1`, and a reader
  // arriving fresh has nothing to compare it against. AAD binds a body to the
  // version it claims; it cannot know which version *should* have been served.
  // That is absence, and absence is the vault head's job (#1044).
  //
  // What binding `_v` buys is stated in row 10, and it is the half that
  // matters: the stale copy authenticates ONLY AS ITSELF, so it can never be
  // dressed up to outrank the current one. A rollback that cannot win the
  // version race cannot displace anything.
  it('9. a plain re-serve of an OLD version still opens — it is withholding, not forgery', async () => {
    const { store } = await seed()
    const v1 = (await store.get(VAULT, COLL, 'd1'))!
    const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
    await (await db.openVault(VAULT)).collection<Doc>(COLL).put('d1', { secret: 'the second version' })

    // Control: the CURRENT record reads back, so what follows is the rewind
    // and not a broken fixture.
    expect(await coldRead(store)).toEqual({ secret: 'the second version' })

    await store.put(VAULT, COLL, 'd1', v1)
    // Not a throw. It is a real record, served at its real version — the store
    // is hiding v2, which no per-envelope check can see.
    expect(await coldRead(store)).toEqual({ secret: 'the eagle lands at dawn' })
  })

  it('10. REWIND-WITH-RESTAMP — the old body relabelled at the current version', async () => {
    // The smarter form: serve the stale body but stamp it `_v: 2` so a
    // version-comparing check sees nothing odd. It defeats every defence that
    // reasons about the metadata, and it is exactly what AAD is for — the
    // relabelling is what breaks it.
    const { store } = await seed()
    const v1 = (await store.get(VAULT, COLL, 'd1'))!
    const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
    await (await db.openVault(VAULT)).collection<Doc>(COLL).put('d1', { secret: 'the second version' })
    const v2 = (await store.get(VAULT, COLL, 'd1'))!

    await store.put(VAULT, COLL, 'd1', { ...v1, _v: v2._v })
    await expect(coldRead(store)).rejects.toThrow()
  })

  it('11. VERSION INFLATION — bumping `_v` on the current record, to outrank a peer', async () => {
    // The push direction of the same lever: inflate a version so this copy wins
    // every convergence comparison. Refused for the same reason — `_v` is no
    // longer a number the store may choose.
    const { store, env } = await seed()
    await store.put(VAULT, COLL, 'd1', { ...env, _v: env._v + 99 })
    await expect(coldRead(store)).rejects.toThrow()
  })

  it('8. `_ts` stays advisory — clock correction is not a tamper event', async () => {
    // Deliberately excluded from the tuple. Binding it would make a legitimate
    // timestamp fix undecryptable, so this pins the exclusion as intended
    // rather than forgotten.
    const { store, env } = await seed()
    await store.put(VAULT, COLL, 'd1', { ...env, _ts: '2099-01-01T00:00:00.000Z' })
    expect(await coldRead(store)).toEqual({ secret: 'the eagle lands at dawn' })
  })
})
