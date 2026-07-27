/**
 * User-list visibility (#122) — per-user hidden flag + vault-level
 * directory toggle.
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/user-envelope.md → Directory visibility
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import {
  DirectoryDisabledError,
  PermissionDeniedError,
} from '../../src/kernel/errors.js'
import { listUsersWithEnvelopes } from '../../src/with-party/team/keyring.js'
import { USER_ENVELOPE_COLLECTION } from '../../src/kernel/constants.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'
import { withTeam } from '../../src/with-party/team/index.js'

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

async function getDek(vault: unknown): Promise<CryptoKey> {
  return (vault as { getDEK: (c: string) => Promise<CryptoKey> }).getDEK(USER_ENVELOPE_COLLECTION)
}

describe('User-list visibility (#122)', () => {
  it('hidden users are filtered from listUsersWithEnvelopes by default', async () => {
    const store = inlineMemory()
    const aliceDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: 'alice-pass-2026-strong' })
    const v = await aliceDb.openVault('demo')
    await v.user.updateMe({ profile: { displayName: 'Alice' } })
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026-strong',
    })

    // Bob marks himself hidden.
    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-2026-strong' })
    const bobV = await bobDb.openVault('demo')
    await bobV.user.setMyVisibility({ hidden: true })
    expect(await bobV.user.getMyVisibility()).toEqual({ hidden: true })

    const dek = await getDek(v)

    // Default listing (any role) hides bob.
    const visibleViewer = await listUsersWithEnvelopes(store, 'demo', dek, 'viewer')
    expect(visibleViewer.map((r) => r.user.userId).sort()).toEqual(['alice'])

    const visibleOwner = await listUsersWithEnvelopes(store, 'demo', dek, 'owner')
    expect(visibleOwner.map((r) => r.user.userId).sort()).toEqual(['alice'])

    // Owner with { includeHidden: true } sees bob.
    const allOwner = await listUsersWithEnvelopes(store, 'demo', dek, 'owner', {
      includeHidden: true,
    })
    expect(allOwner.map((r) => r.user.userId).sort()).toEqual(['alice', 'bob'])

    aliceDb.close()
    bobDb.close()
  })

  it('{ includeHidden: true } requires admin/owner role', async () => {
    const store = inlineMemory()
    const aliceDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: 'alice-pass-2026-strong' })
    const v = await aliceDb.openVault('demo')
    await v.user.updateMe({ profile: { displayName: 'Alice' } })
    const dek = await getDek(v)

    await expect(
      listUsersWithEnvelopes(store, 'demo', dek, 'operator', { includeHidden: true }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(
      listUsersWithEnvelopes(store, 'demo', dek, 'viewer', { includeHidden: true }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(
      listUsersWithEnvelopes(store, 'demo', dek, 'client', { includeHidden: true }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)

    // admin and owner are allowed.
    await expect(
      listUsersWithEnvelopes(store, 'demo', dek, 'admin', { includeHidden: true }),
    ).resolves.toBeDefined()
    await expect(
      listUsersWithEnvelopes(store, 'demo', dek, 'owner', { includeHidden: true }),
    ).resolves.toBeDefined()

    aliceDb.close()
  })

  it('directory disabled throws DirectoryDisabledError for non-admin', async () => {
    const store = inlineMemory()
    const aliceDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: 'alice-pass-2026-strong' })
    const v = await aliceDb.openVault('demo')
    await v.user.updateMe({ profile: { displayName: 'Alice' } })

    expect(await aliceDb.getDirectoryEnabled('demo')).toBe(true)
    await aliceDb.setDirectoryEnabled('demo', false)
    expect(await aliceDb.getDirectoryEnabled('demo')).toBe(false)

    const dek = await getDek(v)

    // Non-privileged callers blocked.
    await expect(
      listUsersWithEnvelopes(store, 'demo', dek, 'viewer'),
    ).rejects.toBeInstanceOf(DirectoryDisabledError)
    await expect(
      listUsersWithEnvelopes(store, 'demo', dek, 'operator'),
    ).rejects.toBeInstanceOf(DirectoryDisabledError)
    await expect(
      listUsersWithEnvelopes(store, 'demo', dek, 'client'),
    ).rejects.toBeInstanceOf(DirectoryDisabledError)

    // Owner / admin still allowed.
    await expect(listUsersWithEnvelopes(store, 'demo', dek, 'owner')).resolves.toBeDefined()
    await expect(listUsersWithEnvelopes(store, 'demo', dek, 'admin')).resolves.toBeDefined()

    aliceDb.close()
  })

  it('setDirectoryEnabled requires owner', async () => {
    const store = inlineMemory()
    const aliceDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: 'alice-pass-2026-strong' })
    await aliceDb.openVault('demo')
    await aliceDb.grant('demo', {
      userId: 'admin1',
      displayName: 'Admin One',
      role: 'admin',
      passphrase: 'admin1-pass-2026-strong',
    })

    const adminDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'admin1', secret: 'admin1-pass-2026-strong' })
    await adminDb.openVault('demo')

    // Admin (not owner) cannot toggle the directory.
    await expect(adminDb.setDirectoryEnabled('demo', false)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )

    // Owner can.
    await expect(aliceDb.setDirectoryEnabled('demo', false)).resolves.toBeUndefined()
    expect(await aliceDb.getDirectoryEnabled('demo')).toBe(false)

    aliceDb.close()
    adminDb.close()
  })

  it('revoke deletes the visibility sidecar (no leak to re-granted userId)', async () => {
    const store = inlineMemory()
    const aliceDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: 'alice-pass-2026-strong' })
    const v = await aliceDb.openVault('demo')
    await v.user.updateMe({ profile: { displayName: 'Alice' } })

    // Grant bob, bob marks self hidden.
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'operator',
      passphrase: 'bob-pass-2026-strong',
    })
    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-2026-strong' })
    const bobV = await bobDb.openVault('demo')
    await bobV.user.setMyVisibility({ hidden: true })
    expect(await bobV.user.getMyVisibility()).toEqual({ hidden: true })
    bobDb.close()

    // Owner revokes bob, then re-grants the same userId.
    await aliceDb.revoke('demo', { userId: 'bob' })
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob (fresh)',
      role: 'operator',
      passphrase: 'bob-pass-redux-2026-strong',
    })

    // Fresh listing — bob is NOT hidden anymore. The sidecar from the
    // revoked principal did not leak to the re-granted userId.
    const dek = await getDek(v)
    const visible = await listUsersWithEnvelopes(store, 'demo', dek, 'owner')
    expect(visible.map((r) => r.user.userId).sort()).toEqual(['alice', 'bob'])

    // And no orphaned visibility doc remains.
    const bobAfter = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-redux-2026-strong' })
    const bobAfterV = await bobAfter.openVault('demo')
    expect(await bobAfterV.user.getMyVisibility()).toEqual({ hidden: false })

    aliceDb.close()
    bobAfter.close()
  })

  it('peer-recovery preserves the hidden flag', async () => {
    const store = inlineMemory()
    const aliceDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: 'alice-pass-2026-strong' })
    await aliceDb.openVault('demo')
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026-strong',
    })

    // Bob marks himself hidden.
    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-2026-strong' })
    const bobV = await bobDb.openVault('demo')
    await bobV.user.setMyVisibility({ hidden: true })
    bobDb.close()

    // Alice peer-recovers Bob (resets passphrase but preserves identity).
    await aliceDb.team.recoverUser('demo', {
      userId: 'bob',
      passphrase: 'temp-bob-recovered-2026-strong',
    })

    // Bob re-opens with the temp passphrase. Visibility doc survived.
    const bobAfter = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'temp-bob-recovered-2026-strong' })
    const bobAfterV = await bobAfter.openVault('demo')
    expect(await bobAfterV.user.getMyVisibility()).toEqual({ hidden: true })

    aliceDb.close()
    bobAfter.close()
  })
})
