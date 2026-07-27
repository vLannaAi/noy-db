/**
 * Policy gate enforcement on vault.user.* — edit-own-profile +
 * view-team-profiles (#22).
 *
 * Default policy (PERSONAL_POLICY) lets all vault.user.* operations
 * succeed for a tier-1-unlocked owner — covered implicitly by the
 * existing api/lifecycle tests. This file specifically exercises
 * tightening: STRICT_POLICY requires a TOTP for edit-own-profile, and
 * a privacy-strict opt-out makes list() return only self.
 *
 * @see docs/superpowers/specs/2026-05-05-user-envelope-design.md
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import { PolicyDeniedError } from '../src/kernel/errors.js'
import { withTeam } from '../src/with-party/team/index.js'

interface TestProfile {
  profile?: { displayName?: string }
}

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'inline-memory',
    async get(c: string, col: string, id: string) { return gc(c, col).get(id) },
    async put(c: string, col: string, id: string, env: EncryptedEnvelope) { gc(c, col).set(id, env) },
    async delete(c: string, col: string, id: string) { gc(c, col).delete(id) },
    async list(c: string, col: string) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

describe('user envelope — policy gates (#22)', () => {
  // ─── edit-own-profile tightening ─────────────────────────────────────

  it('default policy: updateMe succeeds for tier-1 (secret-unlocked) owner', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ teamStrategy: withTeam(),
      store,
      user: 'alice',
      secret: 'alice-pass-2026-strong',
    })
    const vault = await db.openVault('demo')
    const written = await vault.user.updateMe<TestProfile>({
      profile: { displayName: 'Alice' },
    })
    expect(written._v).toBe(1)
  })

  it('tightening edit-own-profile to require TOTP blocks tier-1 writes without proof', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ teamStrategy: withTeam(),
      store,
      user: 'alice',
      secret: 'alice-pass-2026-strong',
      policy: {
        gates: {
          'edit-own-profile': {
            minTier: 2,
            factors: [{ anyOf: ['totp'] }],
          },
        },
      },
    })
    const vault = await db.openVault('demo')
    // No `presented` → missing factor → PolicyDeniedError.
    await expect(
      vault.user.updateMe<TestProfile>({ profile: { displayName: 'A' } }),
    ).rejects.toThrow(PolicyDeniedError)
    // Verify it's specifically the missing-factor reason.
    try {
      await vault.user.updateMe<TestProfile>({ profile: { displayName: 'A' } })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError)
      expect((err as PolicyDeniedError).gate).toBe('edit-own-profile')
      expect((err as PolicyDeniedError).reason).toBe('missing-factor')
    }
  })

  it('tightened gate accepts a fresh TOTP proof', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ teamStrategy: withTeam(),
      store,
      user: 'alice',
      secret: 'alice-pass-2026-strong',
      policy: {
        gates: {
          'edit-own-profile': {
            minTier: 2,
            factors: [{ anyOf: ['totp'] }],
          },
        },
      },
    })
    const vault = await db.openVault('demo')
    const fresh = new Date().toISOString()
    const written = await vault.user.updateMe<TestProfile>(
      { profile: { displayName: 'A' } },
      { factors: [{ kind: 'totp', mintedAt: fresh }] },
    )
    expect(written._v).toBe(1)
    expect(written.data.profile?.displayName).toBe('A')
  })

  // ─── view-team-profiles privacy-strict opt-out ───────────────────────

  it('view-team-profiles.enabled: false → list() returns only self', async () => {
    const store = inlineMemory()
    // Boot vault with default policy so we can grant a teammate.
    const setup = await createNoydb({ teamStrategy: withTeam(),
      store,
      user: 'alice',
      secret: 'alice-pass-2026-strong',
    })
    const setupVault = await setup.openVault('demo')
    await setupVault.user.updateMe<TestProfile>({ profile: { displayName: 'Alice' } })
    await setup.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      secret: 'bob-pass-2026-strong',
      initialProfile: { profile: { displayName: 'Bob' } } satisfies TestProfile,
    })
    setup.close()

    // Now reopen with privacy-strict opt-out. The on-disk policy was
    // already written; we use db.updatePolicy is not exposed — the
    // policy round-trips on subsequent opens unchanged. So instead we
    // simulate a fresh vault with the strict policy from the start.
    const store2 = inlineMemory()
    const aliceDb = await createNoydb({ teamStrategy: withTeam(),
      store: store2,
      user: 'alice',
      secret: 'alice-pass-2026-strong',
      policy: {
        gates: {
          'view-team-profiles': { minTier: 2, enabled: false },
        },
      },
    })
    const v = await aliceDb.openVault('demo')
    await v.user.updateMe<TestProfile>({ profile: { displayName: 'Alice' } })
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      secret: 'bob-pass-2026-strong',
      initialProfile: { profile: { displayName: 'Bob' } } satisfies TestProfile,
    })
    // list() under enabled: false silently returns only self.
    const visible = await v.user.list<TestProfile>()
    expect(visible.length).toBe(1)
    expect(visible[0]!.keyringId).toBe('alice')
    expect(visible[0]!.data.profile?.displayName).toBe('Alice')
  })

  it('view-team-profiles.enabled: false → get(otherKeyringId) throws PolicyDeniedError', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ teamStrategy: withTeam(),
      store,
      user: 'alice',
      secret: 'alice-pass-2026-strong',
      policy: {
        gates: {
          'view-team-profiles': { minTier: 2, enabled: false },
        },
      },
    })
    const v = await db.openVault('demo')
    await db.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      secret: 'bob-pass-2026-strong',
      initialProfile: { profile: { displayName: 'Bob' } } satisfies TestProfile,
    })
    await expect(v.user.get<TestProfile>('bob')).rejects.toThrow(PolicyDeniedError)
  })

  it('view-team-profiles disabled does NOT block reading own envelope via get(self)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ teamStrategy: withTeam(),
      store,
      user: 'alice',
      secret: 'alice-pass-2026-strong',
      policy: {
        gates: {
          'view-team-profiles': { minTier: 2, enabled: false },
        },
      },
    })
    const v = await db.openVault('demo')
    await v.user.updateMe<TestProfile>({ profile: { displayName: 'Alice' } })
    // Reading your own envelope is never gated, even when the gate is disabled.
    const me = await v.user.get<TestProfile>('alice')
    expect(me).not.toBeNull()
    expect(me!.data.profile?.displayName).toBe('Alice')
  })
})
