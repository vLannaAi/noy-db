/**
 * Team-subsystem integration for user envelopes (#23).
 *
 * Verifies the joined enumeration `listUsersWithEnvelopes()` returns
 * keyring summaries paired with their decrypted user envelopes — the
 * canonical "render team-member list with profile data" path for
 * admin UIs.
 *
 * Presence `displayName`: not tested here. The existing
 * `team/presence.ts` already takes a generic payload `P`, so apps
 * just include `displayName` (sourced from
 * `vault.user.me<MyShape>().data.profile.displayName`) inside their
 * presence payload. No hub change needed; the recipe in #24
 * demonstrates the pattern.
 *
 * @see docs/superpowers/specs/2026-05-05-user-envelope-design.md
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import { listUsersWithEnvelopes } from '../src/with-party/team/keyring.js'
import { USER_ENVELOPE_COLLECTION } from '../src/kernel/meta/user-envelope/index.js'

interface TestProfile {
  profile?: { displayName?: string; locale?: string }
  preferences?: { theme?: 'light' | 'dark' }
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

describe('team integration — listUsersWithEnvelopes (#23)', () => {
  let store: NoydbStore
  let aliceDb: Noydb

  beforeEach(async () => {
    store = inlineMemory()
    aliceDb = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026-strong' })
    const v = await aliceDb.openVault('demo')
    await v.user.updateMe<TestProfile>({
      profile: { displayName: 'Alice', locale: 'en-US' },
      preferences: { theme: 'dark' },
    })
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'operator',
      passphrase: 'bob-pass-2026-strong',
      permissions: { invoices: 'rw' },
      initialProfile: {
        profile: { displayName: 'Bob the Auditor', locale: 'fr-FR' },
        preferences: { theme: 'light' },
      } satisfies TestProfile,
    })
    await aliceDb.grant('demo', {
      userId: 'carol',
      displayName: 'Carol',
      role: 'viewer',
      passphrase: 'carol-pass-2026-strong',
      // No initialProfile — empty seed envelope.
    })
  })

  it('returns one row per keyring, each paired with its envelope', async () => {
    const v = await aliceDb.openVault('demo')
    // Get the _users DEK by reading my own envelope first (caches the
    // DEK in the keyring). Then use the same DEK to read all envelopes.
    const me = await v.user.me<TestProfile>()
    expect(me).not.toBeNull()
    // Reach into the vault's lazy DEK resolver — public API doesn't
    // expose this, but tests can import the helper directly.
    const dek = await (v as unknown as {
      getDEK: (c: string) => Promise<CryptoKey>
    }).getDEK(USER_ENVELOPE_COLLECTION)

    const rows = await listUsersWithEnvelopes<TestProfile>(store, 'demo', dek, 'owner')
    expect(rows.length).toBe(3)

    const byId = new Map(rows.map((r) => [r.user.userId, r]))
    expect(byId.get('alice')!.envelope!.data.profile?.displayName).toBe('Alice')
    expect(byId.get('alice')!.user.role).toBe('owner')

    expect(byId.get('bob')!.envelope!.data.profile?.displayName).toBe('Bob the Auditor')
    expect(byId.get('bob')!.user.role).toBe('operator')

    // Carol has the empty seed envelope (data === {}).
    expect(byId.get('carol')!.envelope!.data).toEqual({})
    expect(byId.get('carol')!.user.role).toBe('viewer')
  })

  it('returns envelope: null for keyrings predating the user-envelope feature', async () => {
    // Simulate a "legacy" keyring by deleting the auto-created envelope
    // from the store after grant (mimicking a vault written before
    // this feature landed).
    await store.delete('demo', USER_ENVELOPE_COLLECTION, 'carol')

    const v = await aliceDb.openVault('demo')
    const dek = await (v as unknown as {
      getDEK: (c: string) => Promise<CryptoKey>
    }).getDEK(USER_ENVELOPE_COLLECTION)

    const rows = await listUsersWithEnvelopes<TestProfile>(store, 'demo', dek, 'owner')
    const carol = rows.find((r) => r.user.userId === 'carol')!
    expect(carol.envelope).toBeNull()
    // The keyring info is still present so the caller can fall back
    // to the keyring's display_name.
    expect(carol.user.displayName).toBe('Carol')
  })
})

describe('team integration — presence pattern documentation (#23)', () => {
  it('apps put displayName in their presence payload P (no hub change)', () => {
    // This test documents the intended pattern: hub does not introspect
    // the user envelope to populate presence. Apps source displayName
    // from vault.user.me<MyShape>().data.profile.displayName and pass
    // it as part of the generic payload P.
    //
    // Pseudocode (the real flow lives in showcase #70 / recipe):
    //
    //   const me = await vault.user.me<MyShape>()
    //   await collection.presence().update({
    //     displayName: me?.data.profile?.displayName,
    //     editingRecordId: 'invoice-42',
    //   })
    //
    // The presence subscriber receives PresencePeer<{ displayName, ...}>
    // and renders accordingly. Hub remains payload-agnostic.
    expect(true).toBe(true)
  })
})
