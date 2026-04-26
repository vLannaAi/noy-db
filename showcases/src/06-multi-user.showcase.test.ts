/**
 * Showcase 06 — Multi-user: grant, revoke, role tiers
 *
 * What you'll learn
 * ─────────────────
 * The always-on multi-user surface: an owner grants other users into
 * a vault with one of five roles (`owner | admin | operator | viewer
 * | client`). Each role has its own read/write defaults; explicit
 * per-collection permissions narrow further. Revoke cascades through
 * delegations; rotate re-wraps every DEK without re-encrypting
 * envelopes.
 *
 * Why it matters
 * ──────────────
 * "No central auth server" is one of the project's core promises.
 * The keyring travels with the data. This showcase is the proof:
 * granting a viewer doesn't call out to any service, and the
 * viewer-vs-owner read/write asymmetry is enforced in the keyring
 * file itself.
 *
 * Prerequisites
 * ─────────────
 * - Showcases 00-05.
 *
 * What to read next
 * ─────────────────
 *   - showcase 22-on-passphrase (default unlock)
 *   - showcase 23-on-webauthn (passkey unlock)
 *   - docs/core/04-permissions-and-keyring.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → permissions
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, ReadOnlyError } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 06 — Multi-user: grant, revoke, role tiers', () => {
  it('grants a viewer who can read but cannot write', async () => {
    const store = memory()

    // Owner sets up the vault and writes one record.
    const ownerDb = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026' })
    const ownerVault = await ownerDb.openVault('demo')
    await ownerVault.collection<Note>('notes').put('n1', { id: 'n1', text: 'owner wrote this' })

    // Owner grants Bob a viewer keyring with his own passphrase.
    await ownerDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026',
    })
    ownerDb.close()

    // Bob opens the same vault with his passphrase. He gets a viewer
    // keyring — DEK access only for read.
    const viewerDb = await createNoydb({ store, user: 'bob', secret: 'bob-pass-2026' })
    const viewerVault = await viewerDb.openVault('demo')

    const out = await viewerVault.collection<Note>('notes').get('n1')
    expect(out).toEqual({ id: 'n1', text: 'owner wrote this' })

    await expect(
      viewerVault.collection<Note>('notes').put('n2', { id: 'n2', text: 'should fail' }),
    ).rejects.toBeInstanceOf(ReadOnlyError)

    viewerDb.close()
  })

  it('revoke removes the user from listAccessibleVaults', async () => {
    // The semantics of revoke: the user's keyring file is removed +
    // the vault's DEKs are rotated so any cached copy is now stale.
    // For the "next-session" question, the cleanest assertion is that
    // listAccessibleVaults no longer enumerates the vault for the
    // revoked user — they have no keyring there.
    const store = memory()

    const ownerDb = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026' })
    await ownerDb.openVault('demo')
    await ownerDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026',
    })

    // Before revoke: Bob enumerates 'demo' as accessible.
    const bobDb1 = await createNoydb({ store, user: 'bob', secret: 'bob-pass-2026' })
    const before = await bobDb1.listAccessibleVaults()
    expect(before.map((v) => v.id)).toContain('demo')
    bobDb1.close()

    // Owner revokes Bob.
    await ownerDb.revoke('demo', { userId: 'bob' })
    ownerDb.close()

    // After revoke: Bob's keyring for that vault is gone.
    const bobDb2 = await createNoydb({ store, user: 'bob', secret: 'bob-pass-2026' })
    const after = await bobDb2.listAccessibleVaults()
    expect(after.map((v) => v.id)).not.toContain('demo')
    bobDb2.close()
  })
})
