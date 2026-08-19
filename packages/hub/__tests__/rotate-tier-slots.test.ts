/**
 * #1125 — `rotateKeys` and `collection#tier` DEK slots.
 *
 * Elevated records live in the SAME collection as their tier-0 siblings,
 * distinguished by the unencrypted `_tier` field, and are sealed under
 * `dekKey(collection, tier)` — `docs#1`. Rotation keyed off collection NAME, so
 * it was broken in both directions at once:
 *
 *   Direction 1 — rotating `docs` met an elevated record it could not open and
 *   RETHREW. Because `revoke` rotates as its final step, revoking anyone from a
 *   vault holding a single elevated record failed outright, AFTER the keyring
 *   was already deleted. Part-applied.
 *
 *   Direction 2 — rotating `docs#1` was a SILENT no-op: `store.list(vault,
 *   "docs#1")` is empty, so nothing was re-encrypted and a revoked member who
 *   retained the tier key kept reading elevated records.
 *
 * The lead assertion is an OUTPUT-DOMAIN invariant, deliberately not consulting
 * the fix: after a revocation, NO retained key opens ANY envelope, and the owner
 * can still read everything. A fifth such surface fails there rather than
 * passing quietly — the convention #1108 and #1122 established.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { openEnvelopeJson, type EnclaveKey } from '../src/kernel/enclave/index.js'
import { parseDekKey, dekKey } from '../src/kernel/tier-visibility.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

const VAULT = 'acme'
const SECRET = 'owner-pass-correct-horse-battery-staple'

interface Doc extends Record<string, unknown> { body: string }

/** A vault with a tier-0 doc and an ELEVATED doc in the same collection. */
async function seeded() {
  const store = memoryStore()
  const db = await createNoydb({
    teamStrategy: withTeam(), tiersStrategy: withTiers(),
    store, user: 'owner', secret: SECRET,
  })
  const vault = await db.openVault(VAULT)
  const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
  await docs.put('plain', { body: 'tier-0 body' })
  await docs.put('secret', { body: 'elevated body' })
  await docs.elevate('secret', 1)
  return { store, db, vault, docs }
}

/** Every key a member held before revocation, by slot name. */
async function keysOf(vault: Awaited<ReturnType<typeof seeded>>['vault'], user: string): Promise<Map<string, EnclaveKey>> {
  const anyVault = vault as unknown as { keyring: { deks: Map<string, EnclaveKey>; userId: string } }
  const out = new Map<string, EnclaveKey>()
  if (anyVault.keyring.userId === user) for (const [k, v] of anyVault.keyring.deks) out.set(k, v)
  return out
}

/** Any (collection, id) that still opens under any of `keys`. */
async function stillReadable(
  store: NoydbStore,
  collections: readonly string[],
  keys: ReadonlyMap<string, EnclaveKey>,
): Promise<string[]> {
  const hits: string[] = []
  for (const collection of collections) {
    let ids: string[] = []
    try { ids = await store.list(VAULT, collection) } catch { continue }
    for (const id of ids) {
      const env: EncryptedEnvelope | null = await store.get(VAULT, collection, id)
      if (!env || !env._iv) continue
      for (const [name, key] of keys) {
        try {
          await openEnvelopeJson({ collection, id }, env, key)
          hits.push(`${collection}/${id} (via '${name}')`)
          break
        } catch { /* not this key */ }
      }
    }
  }
  return hits
}

describe('#1125 — parseDekKey is the exact inverse of dekKey', () => {
  it('round-trips every shape, including names that contain a #', () => {
    for (const [coll, tier] of [['docs', 0], ['docs', 1], ['docs', 12], ['a#b', 0], ['a#b', 3]] as const) {
      expect(parseDekKey(dekKey(coll, tier))).toEqual({ collection: coll, tier })
    }
  })

  it('treats a non-numeric or zero suffix as part of the name', () => {
    expect(parseDekKey('docs#x')).toEqual({ collection: 'docs#x', tier: 0 })
    expect(parseDekKey('docs#')).toEqual({ collection: 'docs#', tier: 0 })
    expect(parseDekKey('docs#0')).toEqual({ collection: 'docs#0', tier: 0 })
    expect(parseDekKey('#1')).toEqual({ collection: '#1', tier: 0 })
  })
})

describe('#1125 — Direction 1: a vault with an elevated record can be revoked', () => {
  it('revoke SUCCEEDS and is not part-applied', async () => {
    const { store, db, vault, docs } = await seeded()
    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })

    // Before the fix this threw AFTER deleting bob's keyring — part-applied.
    await expect(db.revoke(VAULT, { userId: 'bob' })).resolves.not.toThrow()

    // The owner still reads BOTH records — availability, the other half.
    expect(await docs.get('plain')).toMatchObject({ body: 'tier-0 body' })
    expect(await docs.getAtTier('secret')).toMatchObject({ body: 'elevated body' })
    expect(await store.get(VAULT, '_keyring', 'bob')).toBeNull()
  })
})

describe('#1125 — Direction 2: rotating a tier slot actually re-encrypts', () => {
  it('OUTPUT-DOMAIN INVARIANT: after revocation no retained key opens any envelope', async () => {
    const { store, db, vault } = await seeded()
    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })

    // Snapshot every key the OWNER holds before the rotation. A revoked member's
    // retained keys are the same generation, so this is the same question asked
    // of keys we can actually reach from a test.
    const retained = await keysOf(vault, 'owner')
    expect(retained.has('docs')).toBe(true)
    expect(retained.has('docs#1')).toBe(true) // the slot that used to be skipped

    await db.revoke(VAULT, { userId: 'bob' })

    const survivors = await stillReadable(store, ['docs', '_history'], retained)
    expect(survivors, `these still open under a pre-rotation key: ${survivors.join(', ')}`).toEqual([])
  })

  it('the ELEVATED record specifically is re-keyed, not just the tier-0 one', async () => {
    const { store, db, vault } = await seeded()
    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    const retained = await keysOf(vault, 'owner')
    const oldTierKey = retained.get('docs#1')!

    await db.revoke(VAULT, { userId: 'bob' })

    const env = (await store.get(VAULT, 'docs', 'secret'))!
    await expect(openEnvelopeJson({ collection: 'docs', id: 'secret' }, env, oldTierKey))
      .rejects.toThrow()
  })

  it('the owner can still read the elevated record afterwards', async () => {
    const { db, vault, docs } = await seeded()
    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    await db.revoke(VAULT, { userId: 'bob' })
    expect(await docs.getAtTier('secret')).toMatchObject({ body: 'elevated body' })
  })
})
