/**
 * Showcase 70 — User envelope: per-principal profile + preferences
 *
 * What you'll learn
 * ─────────────────
 * Every keyring in a vault gets its own `_users/<keyringId>` envelope,
 * encrypted under a vault-shared `_users` DEK. The envelope holds
 * whatever profile + preferences shape your app defines (hub does NOT
 * commit to a schema beyond `userId === keyringId`). Three method
 * families on `vault.user.*`:
 *
 *  - **Write-self**: `me()`, `updateMe(patch)`, `setMe(payload)` — the
 *    own-only write rule is *structural*: there is no API method to
 *    write someone else's envelope.
 *  - **Read-anyone**: `get(keyringId)`, `list()` — see teammates'
 *    profiles. Gated by `view-team-profiles` (default `minTier: 2`),
 *    with a privacy-strict opt-out (`enabled: false` → list returns
 *    only self).
 *  - **Lifecycle hooks**: admins can pre-fill a teammate's first
 *    envelope at grant time via `initialProfile`; once the user
 *    activates, the own-only rule kicks in.
 *
 * Why it matters
 * ──────────────
 * Before this feature, "where do user preferences live?" had three
 * unsatisfying answers in noy-db: (1) a regular collection, (2) the
 * keyring file, or (3) at the app layer. Each had a tradeoff. The
 * `_users/<keyringId>` envelope nails the use case: hub-owned plumbing
 * (storage, sync, history, lifecycle, encryption), app-owned schema.
 * The own-only write rule is the first structural authorization
 * boundary in noy-db — policy can only tighten it, never relax it.
 *
 * Prerequisites
 * ─────────────
 *   - Showcase 00 — Hello vault
 *   - Showcase 06 — Multi-user grant / revoke
 *   - Showcase 22 — on-passphrase
 *
 * What to read next
 * ─────────────────
 *   - recipe-user-preferences (the reference profile/preferences shape)
 *   - docs/subsystems/user-envelope.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → user-envelope
 */

import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  PolicyDeniedError,
  listUsersWithEnvelopes,
  USER_ENVELOPE_COLLECTION,
} from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface AppProfile {
  profile?: { displayName?: string; locale?: string }
  preferences?: { theme?: 'light' | 'dark' }
  app?: Record<string, unknown>
}

describe('Showcase 70 — User envelope', () => {
  it('owner edits their own profile via vault.user.updateMe', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026' })
    const vault = await db.openVault('demo')

    // First call: envelope is created with _v=1.
    const written = await vault.user.updateMe<AppProfile>({
      profile: { displayName: 'Alice', locale: 'en-US' },
      preferences: { theme: 'dark' },
    })
    expect(written.keyringId).toBe('alice')
    expect(written._v).toBe(1)

    // updateMe deep-merges; setMe replaces.
    const merged = await vault.user.updateMe<AppProfile>({
      preferences: { theme: 'light' }, // only theme changes
    })
    expect(merged.data.profile?.displayName).toBe('Alice')
    expect(merged.data.preferences?.theme).toBe('light')
    expect(merged._v).toBe(2)

    db.close()
  })

  it('admin pre-fills a teammate profile via grant({ initialProfile })', async () => {
    const store = memory()
    const aliceDb = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026' })
    await aliceDb.openVault('demo')

    // Admin pre-fills Bob's display name + locale at invite time.
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026',
      initialProfile: {
        profile: { displayName: 'Bob the Auditor', locale: 'fr-FR' },
        preferences: { theme: 'dark' },
      } satisfies AppProfile,
    })
    aliceDb.close()

    // Bob activates. He sees the pre-filled values and can take over.
    const bobDb = await createNoydb({ store, user: 'bob', secret: 'bob-pass-2026' })
    const bobVault = await bobDb.openVault('demo')
    const me = await bobVault.user.me<AppProfile>()
    expect(me?.data.profile?.displayName).toBe('Bob the Auditor')
    expect(me?.data.profile?.locale).toBe('fr-FR')

    // Bob updates — once activated, only Bob can write Bob's envelope.
    await bobVault.user.updateMe<AppProfile>({
      profile: { displayName: 'Bob' }, // strip the "the Auditor" suffix
    })
    const after = await bobVault.user.me<AppProfile>()
    expect(after?.data.profile?.displayName).toBe('Bob')
    expect(after?.data.profile?.locale).toBe('fr-FR') // preserved
    bobDb.close()
  })

  it('cross-principal reads work: alice reads bob\'s profile', async () => {
    const store = memory()
    const aliceDb = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026' })
    const aliceVault = await aliceDb.openVault('demo')
    // Alice writes her own envelope first — the owner's envelope is
    // created on first `updateMe`, not at vault open. Granted users
    // get a seeded envelope at grant time (see prior test).
    await aliceVault.user.updateMe<AppProfile>({ profile: { displayName: 'Alice' } })
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026',
      initialProfile: { profile: { displayName: 'Bob' } } satisfies AppProfile,
    })

    const bobProfile = await aliceVault.user.get<AppProfile>('bob')
    expect(bobProfile?.data.profile?.displayName).toBe('Bob')

    // list() returns every persisted envelope in the vault.
    const everyone = await aliceVault.user.list<AppProfile>()
    expect(everyone.map((e) => e.keyringId).sort()).toEqual(['alice', 'bob'])
    aliceDb.close()
  })

  it('privacy-strict: view-team-profiles.enabled=false → list() returns only self', async () => {
    const store = memory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'alice-pass-2026',
      policy: {
        gates: {
          'view-team-profiles': { minTier: 2, enabled: false },
        },
      },
    })
    await db.openVault('demo')
    await db.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026',
      initialProfile: { profile: { displayName: 'Bob' } } satisfies AppProfile,
    })
    const aliceVault = await db.openVault('demo')
    await aliceVault.user.updateMe<AppProfile>({ profile: { displayName: 'Alice' } })

    // Privacy-strict: list() silently returns only self.
    const visible = await aliceVault.user.list<AppProfile>()
    expect(visible.length).toBe(1)
    expect(visible[0]!.keyringId).toBe('alice')

    // Privacy-strict: get(other) throws PolicyDeniedError.
    await expect(aliceVault.user.get<AppProfile>('bob')).rejects.toBeInstanceOf(PolicyDeniedError)

    // But reading your own envelope is never gated.
    const me = await aliceVault.user.get<AppProfile>('alice')
    expect(me?.data.profile?.displayName).toBe('Alice')
    db.close()
  })

  it('cascade-revoke deletes user envelopes alongside keyrings', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026' })
    await db.openVault('demo')
    // alice → bob (admin) → carol (admin granted by bob).
    await db.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: 'bob-pass-2026',
      initialProfile: { profile: { displayName: 'Bob' } } satisfies AppProfile,
    })
    db.close()

    const bobDb = await createNoydb({ store, user: 'bob', secret: 'bob-pass-2026' })
    await bobDb.openVault('demo')
    await bobDb.grant('demo', {
      userId: 'carol',
      displayName: 'Carol',
      role: 'admin',
      passphrase: 'carol-pass-2026',
      initialProfile: { profile: { displayName: 'Carol' } } satisfies AppProfile,
    })
    bobDb.close()

    // Owner revokes bob with default cascade='strict' → carol goes too.
    const aliceDb2 = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026' })
    const v = await aliceDb2.openVault('demo')
    expect(await v.user.get<AppProfile>('bob')).not.toBeNull()
    expect(await v.user.get<AppProfile>('carol')).not.toBeNull()

    await aliceDb2.revoke('demo', { userId: 'bob' })
    aliceDb2.close()

    // Re-open to verify both envelopes are gone.
    const refreshed = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026' })
    const r = await refreshed.openVault('demo')
    expect(await r.user.get<AppProfile>('bob')).toBeNull()
    expect(await r.user.get<AppProfile>('carol')).toBeNull()
    refreshed.close()
  })

  it('listUsersWithEnvelopes joins keyring metadata + envelope data in one pass', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026' })
    const v = await db.openVault('demo')
    await v.user.updateMe<AppProfile>({
      profile: { displayName: 'Alice', locale: 'en-US' },
      preferences: { theme: 'dark' },
    })
    await db.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'operator',
      passphrase: 'bob-pass-2026',
      permissions: { invoices: 'rw' },
      initialProfile: {
        profile: { displayName: 'Bob the Auditor' },
        preferences: { theme: 'light' },
      } satisfies AppProfile,
    })

    // Internal helper exposed for admin-UI use cases. Pulls keyring
    // info (role, permissions, createdAt) + envelope data side by side.
    const dek = await (v as unknown as {
      getDEK: (c: string) => Promise<CryptoKey>
    }).getDEK(USER_ENVELOPE_COLLECTION)
    const rows = await listUsersWithEnvelopes<AppProfile>(store, 'demo', dek)

    expect(rows.length).toBe(2)
    const byId = new Map(rows.map((r) => [r.user.userId, r]))
    expect(byId.get('alice')!.user.role).toBe('owner')
    expect(byId.get('alice')!.envelope!.data.profile?.displayName).toBe('Alice')
    expect(byId.get('bob')!.user.role).toBe('operator')
    expect(byId.get('bob')!.envelope!.data.profile?.displayName).toBe('Bob the Auditor')
    db.close()
  })
})
