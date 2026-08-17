/**
 * The keyring's AUTHORITY half is unauthenticated (#1043).
 *
 * ## What this set was written to answer, and what it found instead
 *
 * #1043 left exactly one question open: *can `grant` ever mint a keyring
 * broader than the user's later standing?* — because if so, a store that
 * suppresses a `_keyring` write hands back **escalation** rather than mere
 * reinstatement, and ADR 0003's rotation argument (an old roster's DEKs cannot
 * open post-rotation records) stops covering it.
 *
 * The answer is yes (section B). But probing it surfaced something strictly
 * larger, and section A led with it:
 *
 * > **A `_keyring` file is stored in PLAINTEXT** (`_iv: ''`). `role` and
 * > `permissions` sit in the clear. Only `deks` and `canary` are wrapped
 * > under the user's KEK.
 *
 * So a hostile store did not need to keep an old file and replay it. It
 * edited one word. #1043's own text said *"the store cannot fabricate one
 * (KEK + canary must check out)"* — that was true of the **keys** and false
 * of the **role**, and the distinction was the whole finding.
 *
 * ## #1096 closed it: a vault-wide roster key + an authenticated `roster_tag`
 *
 * Every `_keyring` file now carries `roster_tag`: AES-GCM of the canonical
 * authority fields (`user_id`, `role`, `permissions`, `granted_by`,
 * `expires_at`, `export_capability`, `import_capability`) under a roster key
 * that rides `deks['_roster']` — the same channel every other DEK already
 * travels. `loadKeyring` (and every other unlock path, through the shared
 * `assertRosterAuthenticated` chokepoint in `roster-tag.ts`) verifies it
 * *after* the KEK is proven correct and *before* any read, and throws
 * {@link KeyringTamperedError} — never silently accepts — when the canary,
 * the roster key, or the tag itself is missing or does not match.
 *
 * ## The boundary, unchanged by the fix
 *
 * | | forgeable by the store? |
 * |---|---|
 * | **authority** — `role`, and every capability gated on it | **NO, as of #1096** — plaintext, but now authenticated |
 * | **confidentiality** — which collections you can decrypt | no — bounded by the AES-KW-wrapped DEKs (unchanged; #1096 only touches authority) |
 *
 * ## These rows now assert the REFUSAL — the flip IS the signal
 *
 * Same convention as the `_tier`/rewind rows in the identity harness: when a
 * gap closes, the row that used to record the vulnerability is rewritten to
 * assert the defence, not deleted — deleting it would erase the record of
 * what the attack was. Section A below still performs every forgery it did
 * before (same `forgeRole` / plaintext edits, same attacker model: a
 * hostile store, no keys); the only thing that changed is the expected
 * outcome. Section B (replay of a genuine, never-forged file) is #1097's
 * question, not #1096's, and stays green unmodified.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore, KeyringTamperedError } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const VAULT = 'acme'

async function ownerWith(store: NoydbStore) {
  const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner-01', secret: 'owner-pass-1' })
  const vault = await db.openVault(VAULT)
  await vault.collection<{ amount: number }>('invoices').put('inv-1', { amount: 100 })
  return { db, vault }
}

/** The store rewrites the one plaintext word. No key, no prior file. */
async function forgeRole(store: NoydbStore, userId: string, role: string): Promise<void> {
  const env = (await store.get(VAULT, '_keyring', userId))!
  await store.put(VAULT, '_keyring', userId, {
    ...env,
    _data: env._data.replace(/"role":"[a-z]+"/, `"role":"${role}"`),
  })
}

/** Parse a keyring file's plaintext JSON, mutate it, and write it back. */
async function editKeyringFile(
  store: NoydbStore,
  userId: string,
  mutate: (file: Record<string, unknown>) => void,
): Promise<void> {
  const env = (await store.get(VAULT, '_keyring', userId))!
  const file = JSON.parse(env._data) as Record<string, unknown>
  mutate(file)
  await store.put(VAULT, '_keyring', userId, { ...env, _data: JSON.stringify(file) })
}

/** Assert a rejection is specifically the #1096 tamper verdict, by class + reason — never message text. */
async function expectTampered(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(KeyringTamperedError)
  await expect(promise).rejects.toMatchObject({ code: 'KEYRING_TAMPERED', details: { reason } })
}

describe('#1043/#1096 A — the plaintext ROLE was forgeable; roster_tag now refuses the forgery at load', () => {
  it('1. the file really is plaintext — `_iv` is empty, `role` is readable, and `roster_tag` rides along', async () => {
    // Stated as a fact of the format rather than left implicit, because every
    // row below follows from it and a future change to encrypt the file should
    // fail HERE first, loudly, rather than silently making the rest vacuous.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const env = (await store.get(VAULT, '_keyring', 'bob'))!
    expect(env._iv).toBe('')
    expect(env._data).toContain('"role":"viewer"')
    expect(env._data).toContain('roster_tag')
    // The keys, by contrast, are wrapped — this is the half that holds.
    expect(env._data).not.toContain('bob-pass-1')
  })

  it('2. editing that word is now REFUSED at load, before the promoted role can be read at all', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    // Control first: a genuine viewer is refused, so what follows cannot pass
    // because granting happens to be unguarded.
    const asViewer = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expect(
      asViewer.grant(VAULT, { userId: 'm', displayName: 'M', role: 'viewer', secret: 'm-pass-1' }),
    ).rejects.toThrow()

    await forgeRole(store, 'bob', 'admin')

    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    // The forged role no longer matches the tag minted over the genuine one —
    // openVault (which loads the keyring) refuses before any grant is possible.
    await expectTampered(forged.openVault(VAULT), 'roster-tag-mismatch')
  })

  it('3. a forged-then-refused admin cannot revoke a genuine user — the availability angle is closed too', async () => {
    // Worth its own row: revocation needed no keys at all, so this was
    // reachable even by a forged role that inherited a nearly empty DEK map.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'client', secret: 'bob-pass-1', permissions: { invoices: 'ro' } })
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    // Control: the genuine `client` bob is refused.
    const asClient = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expect(asClient.revoke(VAULT, { userId: 'carol' })).rejects.toThrow()
    expect(await store.get(VAULT, '_keyring', 'carol')).not.toBeNull()

    await forgeRole(store, 'bob', 'admin')
    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    // The forged bob cannot even open the vault, so carol's keyring survives —
    // no revoke call is ever reachable.
    await expectTampered(forged.openVault(VAULT), 'roster-tag-mismatch')
    expect(await store.get(VAULT, '_keyring', 'carol')).not.toBeNull()
  })

  it('4. THE BOUND THAT HOLDS: refusal happens at load, before any DEK is ever handed to a forged role', async () => {
    // This is what keeps the finding at "authority forgery" rather than "total
    // compromise", and it is exactly the property #1096 must not trade away.
    // `role` is plaintext; `deks` are AES-KW-wrapped under the user's KEK, and
    // the store holds no KEK — that bound is independently pinned by
    // roster-tag.test.ts's wrong-key row and by the grant-time wrap rules, so
    // it is not re-proven here. What this row shows is that the DEK question
    // is now moot for a forged role: `assertRosterAuthenticated` runs BEFORE
    // any collection read is reachable, so a forged role never gets far enough
    // to attempt decrypting `secrets` with the DEKs it actually holds.
    const store = memoryStore()
    const { db, vault } = await ownerWith(store)
    await vault.collection<{ amount: number }>('secrets').put('s-1', { amount: 42 })
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'client', secret: 'bob-pass-1', permissions: { invoices: 'ro' } })

    await forgeRole(store, 'bob', 'admin')
    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expectTampered(forged.openVault(VAULT), 'roster-tag-mismatch')
  })

  it('5. deleting `roster_tag` outright is refused, not treated as an old/legacy file', async () => {
    // No-legacy policy: an absent tag is the store opting out of verification
    // by deleting a plaintext field, not evidence of a pre-#1096 file.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    await editKeyringFile(store, 'bob', (file) => {
      delete file.roster_tag
    })

    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expectTampered(forged.openVault(VAULT), 'roster-tag-missing')
  })

  it('6. deleting `canary` outright is refused before the roster check is even reached', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    await editKeyringFile(store, 'bob', (file) => {
      delete file.canary
    })

    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expectTampered(forged.openVault(VAULT), 'canary-missing')
  })

  it('7. transplanting a GENUINE admin roster_tag onto another member\'s file is refused — `user_id` is bound', async () => {
    // Not a hypothetical grab-bag: this is exactly the shape of attack a
    // store CAN mount without any key — reuse a real, validly-minted tag by
    // moving it to a different file. `user_id` inside the canonical string
    // is what stops it.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'alice', displayName: 'Alice', role: 'admin', secret: 'alice-pass-1' })
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const aliceEnv = (await store.get(VAULT, '_keyring', 'alice'))!
    const aliceTag = (JSON.parse(aliceEnv._data) as { roster_tag: unknown }).roster_tag

    await editKeyringFile(store, 'bob', (file) => {
      file.roster_tag = aliceTag
    })

    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expectTampered(forged.openVault(VAULT), 'roster-tag-mismatch')
  })

  it('8. editing `permissions` — not `role` — is refused the same way', async () => {
    // The canonical string covers the whole authority tuple, not just role;
    // this row is what pins that down rather than assuming it from the code.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'client', secret: 'bob-pass-1', permissions: { invoices: 'ro' } })

    await editKeyringFile(store, 'bob', (file) => {
      file.permissions = { invoices: 'rw', salaries: 'rw' }
    })

    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expectTampered(forged.openVault(VAULT), 'roster-tag-mismatch')
  })

  // ── LAUNDERING: the refusal above is worthless if another flow re-signs it ──
  //
  // Every row above proves a forged file is refused AT LOAD. These two prove it
  // STAYS refused — because the flows that legitimately rewrite someone else's
  // roster hold the roster key, and a read-modify-restamp that skipped
  // verification would hand a forged file a genuine tag. That converts a
  // detected forgery into an undetectable one, using the fix's own key.

  it('9. a forged role is NOT laundered by a revoke of a DIFFERENT user', async () => {
    // `revoke` rotates, and rotation rewrites EVERY other member's file. So the
    // owner doing something entirely unrelated to bob is the trigger.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })
    await db.grant(VAULT, { userId: 'carol', displayName: 'Carol', role: 'operator', permissions: { invoices: 'rw' }, secret: 'carol-pass-1' })

    await forgeRole(store, 'bob', 'admin')

    // The revoke must not silently succeed while re-signing bob's forgery.
    await expect(db.revoke(VAULT, { userId: 'carol' })).rejects.toBeInstanceOf(KeyringTamperedError)

    // The load-time refusal still stands — nothing re-signed it.
    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expectTampered(forged.openVault(VAULT), 'roster-tag-mismatch')
  })

  it('10. a forged role is NOT laundered by peer-recovering the forged member', async () => {
    // The sharpest shape: the forgery INDUCES ITS OWN TRIGGER. Forging bob's
    // role locks bob out, and an admin's natural remedy for a locked-out member
    // is recovery — which rewraps under a fresh secret and restamps. Without
    // verification, the attacker gets a genuinely-signed admin bob by making
    // the legitimate owner press the button.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    await forgeRole(store, 'bob', 'admin')

    await expect(
      db.team.recoverUser(VAULT, { userId: 'bob', secret: 'temp-recovery-pass-1', allowWeakSecret: true }),
    ).rejects.toBeInstanceOf(KeyringTamperedError)

    // And the temp secret was never minted, so nothing new opens the vault.
    const viaTemp = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'temp-recovery-pass-1' })
    await expect(viaTemp.openVault(VAULT)).rejects.toThrow()
  })
})

describe('#1043 B — the original question: a replay is ESCALATION, not reinstatement', () => {
  // #1096 authenticates the roster against ITSELF — a genuine, never-forged
  // file's role/permissions still agree with its own tag, so a replayed old
  // file (never edited, just re-served) verifies cleanly and these rows stay
  // green. Detecting THAT — a store re-serving a stale-but-genuine roster —
  // is #1097's question (a vault-head / monotonic-epoch mechanism), not
  // #1096's, and is explicitly out of scope here.

  it('9. a re-grant NARROWS standing in place, so a broader file legitimately existed', async () => {
    // The premise the whole question rests on. If narrowing required
    // revoke-then-grant (which rotates), there would be no broader file to
    // keep. It does not: `grant` overwrites unconditionally.
    const store = memoryStore()
    const { db } = await ownerWith(store)

    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1' })
    const asAdmin = (await store.get(VAULT, '_keyring', 'bob'))!
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })
    const asViewer = (await store.get(VAULT, '_keyring', 'bob'))!

    expect(asViewer).not.toEqual(asAdmin)
    const bobNow = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    expect((await bobNow.openVault(VAULT))._introspectState().keyring.role).toBe('viewer')
  })

  it('10. replaying the pre-narrowing file restores the higher role', async () => {
    // Nothing in the load path asks "is this the current roster?" — no epoch,
    // no monotonic marker, no signature over "this is version N". #1096's
    // roster_tag authenticates the FILE's own contents, not its recency.
    const store = memoryStore()
    const { db } = await ownerWith(store)

    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1' })
    const asAdmin = (await store.get(VAULT, '_keyring', 'bob'))!
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    await store.put(VAULT, '_keyring', 'bob', asAdmin)

    const bob = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    expect((await bob.openVault(VAULT))._introspectState().keyring.role).toBe('admin')
  })

  it('11. rotation does NOT bound the replay — the restored DEKs are current', async () => {
    // Precisely where ADR 0003's rotation argument stops applying, and the
    // reason this needed probing rather than reasoning about.
    //
    // For a REVOKED member the argument holds: revocation rotates, so an old
    // roster's DEKs open nothing written since. A NARROWING re-grant rotates
    // nothing — the collection DEKs are untouched — so the replayed file opens
    // data added AFTER the narrowing. That is live access, not stale access.
    const store = memoryStore()
    const { db, vault } = await ownerWith(store)

    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1' })
    const asAdmin = (await store.get(VAULT, '_keyring', 'bob'))!
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    await vault.collection<{ amount: number }>('invoices').put('inv-2', { amount: 999 })

    await store.put(VAULT, '_keyring', 'bob', asAdmin)
    const replayed = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    const bv = await replayed.openVault(VAULT)
    expect(await bv.collection<{ amount: number }>('invoices').get('inv-2')).toEqual({ amount: 999 })
  })
})
