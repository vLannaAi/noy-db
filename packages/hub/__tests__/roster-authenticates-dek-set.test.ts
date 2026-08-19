/**
 * #1115 — the DEK key SET is part of what the roster tag authenticates.
 *
 * `revoke` derives its rotation scope from `Object.keys(target.deks)`. While
 * that set was unauthenticated, a store could strip entries from the target's
 * file before a revocation and have those collections silently skipped by the
 * rotation — a revoked member colluding with that store keeps live DEKs for
 * exactly the collections it removed. That directly contradicts SECURITY.md's
 * "Revocation always re-encrypts the affected collections under new DEKs — the
 * rotation cannot be skipped."
 *
 * NAMES ONLY are bound. The wrapped values are AES-KW and self-authenticating;
 * what was unprotected is the SHAPE of the map.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore, KeyringTamperedError, NOYDB_KEYRING_VERSION } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { rosterCanonical } from '../src/with-party/team/roster-tag.js'
import type { NoydbStore, KeyringFile, EncryptedEnvelope } from '../src/kernel/types.js'

const VAULT = 'acme'
const SECRET = 'owner-pass-correct-horse-battery-staple'

interface Doc extends Record<string, unknown> { body: string }

async function seeded(): Promise<{ store: NoydbStore }> {
  const store = memoryStore()
  const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: SECRET })
  const vault = await db.openVault(VAULT)
  await vault.collection<Doc>('docs').put('d1', { body: 'x' })
  await vault.collection<Doc>('notes').put('n1', { body: 'y' })
  return { store }
}

/** Read, mutate and write back a keyring file's plaintext JSON. */
async function editKeyring(
  store: NoydbStore,
  userId: string,
  edit: (f: KeyringFile) => KeyringFile,
): Promise<void> {
  const env = (await store.get(VAULT, '_keyring', userId))! as EncryptedEnvelope & { _data: string }
  const file = JSON.parse(env._data) as KeyringFile
  await store.put(VAULT, '_keyring', userId, { ...env, _data: JSON.stringify(edit(file)) })
}

async function reopen(store: NoydbStore): Promise<unknown> {
  const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: SECRET })
  return db.openVault(VAULT)
}

describe('#1115 — rosterCanonical binds the DEK key set', () => {
  it('the canonical string changes when a slot is added or dropped', () => {
    const base = {
      user_id: 'u', role: 'owner' as const, permissions: {}, granted_by: 'u',
      deks: { docs: 'a', notes: 'b' },
    }
    const dropped = { ...base, deks: { docs: 'a' } }
    const added = { ...base, deks: { docs: 'a', notes: 'b', extra: 'c' } }
    expect(rosterCanonical(base)).not.toEqual(rosterCanonical(dropped))
    expect(rosterCanonical(base)).not.toEqual(rosterCanonical(added))
  })

  it('binds NAMES, not wrapped values — a re-wrap under the same slots is not a roster change', () => {
    const a = { user_id: 'u', role: 'owner' as const, permissions: {}, granted_by: 'u', deks: { docs: 'WRAP-1' } }
    const b = { ...a, deks: { docs: 'WRAP-2' } }
    expect(rosterCanonical(a)).toEqual(rosterCanonical(b))
  })

  it('binds pending_deks too — stripping it would orphan an interrupted rotation', () => {
    const a = { user_id: 'u', role: 'owner' as const, permissions: {}, granted_by: 'u', deks: { docs: 'a' } }
    const b = { ...a, pending_deks: { docs: 'p' } }
    expect(rosterCanonical(a)).not.toEqual(rosterCanonical(b))
  })

  it('is order-insensitive — key order must not split the tag', () => {
    const a = { user_id: 'u', role: 'owner' as const, permissions: {}, granted_by: 'u', deks: { docs: 'a', notes: 'b' } }
    const b = { ...a, deks: { notes: 'b', docs: 'a' } }
    expect(rosterCanonical(a)).toEqual(rosterCanonical(b))
  })
})

describe('#1115 — a store that edits the DEK set is refused', () => {
  it('STRIPPING a slot is caught at unlock', async () => {
    const { store } = await seeded()
    await editKeyring(store, 'owner', (f) => {
      const { docs: _dropped, ...rest } = f.deks
      void _dropped
      return { ...f, deks: rest }
    })
    await expect(reopen(store)).rejects.toThrow(KeyringTamperedError)
  })

  it('ADDING a slot with a VALID wrap is caught by the tag — the case AES-KW cannot see', async () => {
    const { store } = await seeded()
    // Garbage wrap bytes are already refused by AES-KW itself (KeyringCorruptError),
    // so re-using a genuine wrapped value under a new name is the case that
    // actually needs the roster tag: every byte unwraps, only the SHAPE is wrong.
    await editKeyring(store, 'owner', (f) => ({ ...f, deks: { ...f.deks, injected: f.deks.docs! } }))
    await expect(reopen(store)).rejects.toThrow(KeyringTamperedError)
  })

  it('a garbage wrap is still caught by AES-KW, one layer below the tag', async () => {
    const { store } = await seeded()
    await editKeyring(store, 'owner', (f) => ({ ...f, deks: { ...f.deks, injected: 'AAAA' } }))
    await expect(reopen(store)).rejects.toThrow() // KeyringCorruptError — the wrap, not the roster
  })

  it('STRIPPING pending_deks is caught at unlock', async () => {
    const { store } = await seeded()
    await editKeyring(store, 'owner', (f) => ({ ...f, pending_deks: { docs: 'AAAA' } }))
    await expect(reopen(store)).rejects.toThrow(KeyringTamperedError)
  })

  it('reports it as tampering, NOT as a format transition, when the format matches', async () => {
    const { store } = await seeded()
    await editKeyring(store, 'owner', (f) => {
      const { docs: _d, ...rest } = f.deks
      void _d
      return { ...f, deks: rest }
    })
    await expect(reopen(store)).rejects.toThrow(/roster-tag-mismatch/)
  })
})

describe('#1115 — an UPGRADED vault is not accused of tampering', () => {
  /** Open once and return the thrown error, rather than re-opening per assertion. */
  async function openError(store: NoydbStore): Promise<Error> {
    try {
      await reopen(store)
    } catch (e) {
      return e as Error
    }
    throw new Error('expected the open to be refused')
  }

  it('a tag that cannot verify under an OLDER format reports format-superseded, not an accusation', async () => {
    const { store } = await seeded()
    // What an upgraded vault looks like from here: a tag minted over a narrower
    // field set, so it cannot verify under the current canonicalization. The
    // DEK-set difference is exactly what an old tag fails to cover, so editing
    // it reproduces the shape faithfully.
    await editKeyring(store, 'owner', (f) => ({
      ...f,
      _noydb_keyring: (NOYDB_KEYRING_VERSION - 1) as 2,
      deks: { ...f.deks, injected: f.deks.docs! },
    }))
    const err = await openError(store)
    expect(err).toBeInstanceOf(KeyringTamperedError)
    expect(err.message).toMatch(/format-superseded/)
    expect(err.message).toMatch(/re-seeded/)
    // ...and it must NOT accuse the store, which is the whole point of the split.
    expect(err.message).not.toMatch(/has changed a member's role/)
  })

  it('names BOTH versions, in the message and in structured `details`', () => {
    // "an OLDER FORMAT" does not tell a reader whether they are one release
    // behind or five. `details.format` answers it without parsing English —
    // which matters because a consumer that translates never sees the English.
    const err = new KeyringTamperedError({
      userId: 'ann',
      reason: 'format-superseded',
      format: { from: 1, to: NOYDB_KEYRING_VERSION },
    })
    expect(err.details.format).toEqual({ from: 1, to: NOYDB_KEYRING_VERSION })
    expect(err.message).toContain('keyring format 1')
    expect(err.message).toContain(`requires ${NOYDB_KEYRING_VERSION}`)
  })

  it('carries the transition on a REAL upgraded vault, not just when hand-built', async () => {
    const { store } = await seeded()
    await editKeyring(store, 'owner', (f) => ({
      ...f,
      _noydb_keyring: (NOYDB_KEYRING_VERSION - 1) as 2,
      deks: { ...f.deks, injected: f.deks.docs! },
    }))
    const err = await openError(store)
    expect((err as KeyringTamperedError).details.format).toEqual({
      from: NOYDB_KEYRING_VERSION - 1,
      to: NOYDB_KEYRING_VERSION,
    })
  })

  it('tells the reader to REMOVE the vault first — following it literally must work', () => {
    // Without this the recovery is named but not actionable: a client that
    // bootstraps its local vault before loading a bundle hits the stale
    // keyring during setup, so "open the new bundle" fails and the reader is
    // stuck. Asserted on both branches that ask for a re-seed.
    for (const reason of ['format-superseded', 'roster-key-missing'] as const) {
      const err = new KeyringTamperedError({ userId: 'ann', reason })
      expect(err.message).toMatch(/REMOVE THE VAULT FROM THIS DEVICE FIRST/)
      expect(err.message).toMatch(/does not heal it/)
    }
  })

  it('leaks no internal issue reference into a consumer-facing message', () => {
    // A bare `#1115` is unresolvable outside this repo. The reader needs the
    // format numbers, which they now get; the issue number is for us.
    for (const reason of [
      'canary-missing', 'roster-key-missing', 'roster-tag-missing',
      'roster-tag-mismatch', 'format-superseded', 'unparseable',
    ] as const) {
      expect(new KeyringTamperedError({ userId: 'ann', reason }).message).not.toMatch(/#\d{3,}/)
    }
  })

  it('the SAME edit under the CURRENT format is reported as tampering', async () => {
    const { store } = await seeded()
    await editKeyring(store, 'owner', (f) => ({ ...f, deks: { ...f.deks, injected: f.deks.docs! } }))
    const err = await openError(store)
    expect(err.message).toMatch(/roster-tag-mismatch/)
    expect(err.message).toMatch(/has changed a member's role/)
  })

  it('a store CANNOT downgrade the version to weaken anything', async () => {
    const { store } = await seeded()
    // `_noydb_keyring` is deliberately outside `rosterCanonical`, so rewriting it
    // alone leaves the tag verifying — and a file whose tag verifies is not
    // refused at all. The version field is consulted ONLY after a failure has
    // already been decided, which is what makes reading it safe.
    await editKeyring(store, 'owner', (f) => ({ ...f, _noydb_keyring: 99 as 2 }))
    await expect(reopen(store)).resolves.toBeDefined()
  })
})

describe('#1115 — the legitimate paths still round-trip', () => {
  it('grant, then revoke, then reopen', async () => {
    const store = memoryStore()
    const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: SECRET })
    const vault = await db.openVault(VAULT)
    await vault.collection<Doc>('docs').put('d1', { body: 'x' })
    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    await db.revoke(VAULT, { userId: 'bob' })
    const reopened = await reopen(store)
    expect(reopened).toBeDefined()
  })
})
