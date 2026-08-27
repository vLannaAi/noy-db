import { describe, it, expect } from 'vitest'
import { rosterCanonical, mintRosterTag, verifyRosterTag } from '../src/with-party/team/roster-tag.js'
import { assertRosterEpochCurrent, nextRosterEpoch } from '../src/with-party/team/roster-epoch.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import { KeyringTamperedError } from '../src/kernel/errors.js'

const base = {
  user_id: 'bob', role: 'admin' as const,
  permissions: { invoices: 'rw' as const },
  granted_by: 'owner-01',
  deks: { invoices: 'WRAPPED-1' },
}

/**
 * #1097 — a NARROWING re-grant leaves a replayable broader keyring.
 *
 * There is no role-change API, so narrowing means calling `grant` again with a
 * lower role, and that write overwrites in place. The previous BROADER file was
 * legitimately minted by this vault, so a store that kept a copy can re-serve
 * it: the KEK unwraps, the canary checks out, the roster tag verifies — because
 * none of that is a claim about being CURRENT — and the replayed file restores
 * the higher role, usably.
 *
 * The rotation half already shipped and converts live access back to stale
 * access. It cannot touch the ROLE, because role gates capabilities not keys.
 */
describe('the epoch is bound into the authenticated canonical (#1097)', () => {
  it('a present epoch changes the canonical, so a store cannot strip it', () => {
    expect(rosterCanonical({ ...base, roster_epoch: 3 })).not.toBe(rosterCanonical(base))
  })

  it('distinguishes epoch 3 from epoch 4 — a rewind is not silently equal', () => {
    expect(rosterCanonical({ ...base, roster_epoch: 3 }))
      .not.toBe(rosterCanonical({ ...base, roster_epoch: 4 }))
  })

  it('BACKWARD COMPATIBLE: a file with no epoch canonicalises exactly as before', () => {
    // The load-bearing property, pinned to the literal string rather than to a
    // round-trip. If this changed, every keyring written before the epoch
    // existed would fail its roster tag and every existing vault would become
    // unopenable — a format break with no migration story. `stable()` drops
    // `undefined`, so binding the epoch CONDITIONALLY contributes nothing when
    // it is absent. Binding it as `?? null`, the shape every other optional
    // field uses, would have taken exactly that cost.
    expect(rosterCanonical(base)).toBe(
      '{"dek_slots":["invoices"],"expires_at":null,"export_capability":null,' +
      '"granted_by":"owner-01","import_capability":null,"pending_dek_slots":[],' +
      '"permissions":{"invoices":"rw"},"role":"admin","user_id":"bob"}',
    )
  })

  it('an old tag still verifies under the new canonicalisation', async () => {
    const rosterKey = await generateDEK()
    const tag = await mintRosterTag(base, rosterKey)      // minted with no epoch
    expect(await verifyRosterTag(base as never, tag, rosterKey)).toBe(true)
  })

  it('stripping a present epoch breaks the tag', async () => {
    const rosterKey = await generateDEK()
    const tag = await mintRosterTag({ ...base, roster_epoch: 3 }, rosterKey)
    expect(await verifyRosterTag(base as never, tag, rosterKey)).toBe(false)
  })
})

describe('assertRosterEpochCurrent — absence is NOT epoch zero (#1097)', () => {
  it('accepts a file at exactly the expected epoch', () => {
    expect(() => assertRosterEpochCurrent(5, 5, 'bob')).not.toThrow()
  })

  it('accepts a file NEWER than expected — the anchor is a floor, not an equality', () => {
    // An out-of-band anchor is minted at a moment in time and the roster may
    // legitimately move on. Requiring equality would refuse healthy vaults
    // after any grant or revoke, which is how a security check gets switched off.
    expect(() => assertRosterEpochCurrent(6, 5, 'bob')).not.toThrow()
  })

  it('REFUSES a rewound file', () => {
    expect(() => assertRosterEpochCurrent(4, 5, 'bob')).toThrow(KeyringTamperedError)
    expect(() => assertRosterEpochCurrent(4, 5, 'bob')).toThrow(/rewound/)
  })

  it('REFUSES a file with NO epoch when one is expected, and says so distinctly', () => {
    // Treating absence as 0 would accept every pre-epoch file — exactly the
    // replay this exists to refuse. And reporting it as a REWIND would accuse
    // the store of an attack that may not have happened.
    expect(() => assertRosterEpochCurrent(undefined, 5, 'bob')).toThrow(/absent/)
  })

  it('is a no-op when the caller expects nothing', () => {
    // Opt-in: a deployment with no second channel has nothing to compare
    // against, and is exactly as exposed as it was before.
    expect(() => assertRosterEpochCurrent(undefined, undefined, 'bob')).not.toThrow()
    expect(() => assertRosterEpochCurrent(3, undefined, 'bob')).not.toThrow()
  })
})

describe('nextRosterEpoch is monotonic (#1097)', () => {
  it('starts a fresh line at 1, never 0', () => {
    // 0 is falsy, and "has an epoch" must never be confusable with a falsy check.
    expect(nextRosterEpoch(undefined)).toBe(1)
  })

  it('always advances', () => {
    for (const n of [1, 2, 41]) expect(nextRosterEpoch(n)).toBeGreaterThan(n)
  })

  it('the output always satisfies a comparison against the input', () => {
    // Ties the two halves together rather than trusting they agree: whatever
    // this mints must pass the check that refuses a rewind.
    for (const n of [undefined, 1, 7]) {
      expect(() => assertRosterEpochCurrent(nextRosterEpoch(n), (n ?? 0) + 1, 'bob')).not.toThrow()
    }
  })
})

import { createNoydb, memoryStore, withTeam } from '../src/index.js'

/**
 * The end-to-end property. The unit tests above prove the pieces; this proves
 * the field is actually FILLED by a real roster write — the failure mode being
 * a mechanism that ships inert and reads as "nothing to report".
 */
describe('a real roster write advances the epoch (#1097)', () => {
  const secret = 'x'.repeat(32)

  async function epochOf(store: ReturnType<typeof memoryStore>, vault: string, userId: string) {
    const env = await store.get(vault, '_keyring', userId)
    return env ? (JSON.parse(env._data) as { roster_epoch?: number }).roster_epoch : undefined
  }

  it('a brand-new vault starts its roster line at 1', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret, user: 'owner' })
    await db.openVault('v1', { create: true })
    expect(await epochOf(store, 'v1', 'owner')).toBe(1)
  })

  it('a NARROWING re-grant advances the epoch — the #1097 case', async () => {
    const store = memoryStore()
    const db = await createNoydb({ teamStrategy: withTeam(), store, secret, user: 'owner' })
    await db.openVault('v1', { create: true })

    await db.grant('v1', { userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1' })
    const broad = await epochOf(store, 'v1', 'bob')

    // Narrowing is expressed as a re-grant at a lower role and overwrites in
    // place — which is what leaves the broader file replayable.
    await db.grant('v1', { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })
    const narrow = await epochOf(store, 'v1', 'bob')

    expect(broad).toBeDefined()
    expect(narrow).toBeGreaterThan(broad as number)

    // And the replayed BROADER file is now refusable against the current floor.
    expect(() => assertRosterEpochCurrent(broad, narrow as number, 'bob'))
      .toThrow(/rewound/)
  })
})
