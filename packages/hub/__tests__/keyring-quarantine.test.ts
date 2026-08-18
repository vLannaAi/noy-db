/**
 * #1121 — the in-band remedy for an unverifiable `_keyring` file.
 *
 * ## What was left open
 *
 * #1096 authenticated the roster; #1114 stopped one bad file freezing `revoke`
 * and `rotateKeys` vault-wide. Neither made the bad file REMOVABLE: `revoke`
 * reads the target's own `role` to decide whether the caller may revoke them,
 * so it cannot act on a file it will not trust. The repair was "edit the store
 * directly" — which a zero-knowledge product should be reluctant to require and
 * which a consumer of a remote or daemon-hosted store may not be able to do.
 *
 * ## Why a named operation rather than relaxing `revoke`
 *
 * A conditional inside `revoke` ("sometimes verify the target, sometimes not")
 * is the guard-weakening ADR 0003 warns about: the safe path would grow a
 * parameter that turns it into the dangerous one. `quarantineKeyring` is a
 * separate operation with its own contract, so `revoke`'s invariant stays
 * absolute and the dangerous act is named in the call site and the audit trail.
 *
 * ## The property that keeps it from being a backdoor
 *
 * Quarantine REFUSES a file that verifies. Without that, it would be a way to
 * delete any keyring while ignoring `canRevoke` — including an owner's, which
 * `revoke` protects unconditionally. Because it acts only on files that already
 * fail authentication, it can safely ignore the claimed `role` — and it MUST,
 * since a store that forges `"role":"owner"` would otherwise make its victim
 * permanently unremovable. That row is the point of the whole feature.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { KeyringTamperedError, PermissionDeniedError, ValidationError } from '../src/kernel/errors.js'
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

describe('#1121 verifyRoster — which file is bad, without trial and error', () => {
  it('a healthy roster reports every member CHECKED and none unverified', async () => {
    // The count first. "unverified is empty" is also true of a sweep that
    // examined nothing, which is the #1044 defect one subsystem over.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    const result = await db.verifyRoster(VAULT)

    expect(result.checked).toBe(3) // owner + bob + carol
    expect(result.unverified).toEqual([])
  })

  it('NAMES the bad file and its reason, and still checks the rest', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    await forgeRole(store, 'carol', 'admin')

    const result = await db.verifyRoster(VAULT)

    expect(result.checked).toBe(3)
    expect(result.unverified).toEqual([{ userId: 'carol', reason: 'roster-tag-mismatch' }])
  })

  it('reports a STRIPPED tag distinctly from a mismatched one', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const env = (await store.get(VAULT, '_keyring', 'bob'))!
    const file = JSON.parse(env._data) as Record<string, unknown>
    delete file.roster_tag
    await store.put(VAULT, '_keyring', 'bob', { ...env, _data: JSON.stringify(file) })

    const result = await db.verifyRoster(VAULT)
    expect(result.unverified).toEqual([{ userId: 'bob', reason: 'roster-tag-missing' }])
  })
})

describe('#1121 quarantineKeyring — removing what cannot be verified', () => {
  it('THE POINT: removes a forged file that `revoke` refuses to touch', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    await forgeRole(store, 'carol', 'admin')

    // The control: `revoke` still refuses, which is why this API exists.
    await expect(db.revoke(VAULT, { userId: 'carol' })).rejects.toThrow(KeyringTamperedError)

    await db.quarantineKeyring(VAULT, 'carol')

    expect(await store.get(VAULT, '_keyring', 'carol')).toBeNull()
    // And the roster is clean again — the diagnostic and the remedy agree.
    expect((await db.verifyRoster(VAULT)).unverified).toEqual([])
  })

  it('IGNORES the claimed role — a file forged to `owner` is still removable', async () => {
    // Without this the feature is worthless: `canRevoke` refuses any target
    // whose role reads `owner`, so a store would make its victim permanently
    // unremovable by forging the one word the remedy consulted.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'mallory', displayName: 'M', role: 'viewer', secret: 'mallory-pass-1' })

    await forgeRole(store, 'mallory', 'owner')

    await db.quarantineKeyring(VAULT, 'mallory')
    expect(await store.get(VAULT, '_keyring', 'mallory')).toBeNull()
  })

  it('REFUSES a file that verifies — it is not a backdoor around `canRevoke`', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    await expect(db.quarantineKeyring(VAULT, 'bob')).rejects.toThrow(ValidationError)
    expect(await store.get(VAULT, '_keyring', 'bob')).not.toBeNull()
  })

  it('is OWNER-ONLY — an admin cannot quarantine', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'alice', displayName: 'A', role: 'admin', secret: 'alice-pass-1' })
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    await forgeRole(store, 'carol', 'admin')

    const asAdmin = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: 'alice-pass-1' })
    await expect(asAdmin.quarantineKeyring(VAULT, 'carol')).rejects.toThrow(PermissionDeniedError)
    expect(await store.get(VAULT, '_keyring', 'carol')).not.toBeNull()
  })

  it('refuses to quarantine the CALLER — that is a vault-bricking foot-gun', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await expect(db.quarantineKeyring(VAULT, 'owner-01')).rejects.toThrow(ValidationError)
  })

  it('ROTATES, so a member holding retained DEKs cannot read on after removal', async () => {
    // Deleting the file alone is not a revocation: the store can decline the
    // delete, and the member may already hold unwrapped DEKs. Quarantine
    // therefore rotates, exactly as `revoke` does.
    const store = memoryStore()
    const { db, vault } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    const before = (await store.get(VAULT, 'invoices', 'inv-1'))!._data

    await forgeRole(store, 'carol', 'admin')
    const result = await db.quarantineKeyring(VAULT, 'carol')

    expect(result.rotated).toContain('invoices')
    // The ciphertext changed — the record was genuinely re-keyed, not just relabelled.
    expect((await store.get(VAULT, 'invoices', 'inv-1'))!._data).not.toBe(before)
    // And the owner can still read it.
    expect(await vault.collection<{ amount: number }>('invoices').get('inv-1')).toEqual({ amount: 100 })
  })

  it('rotates the CALLER superset, not the target file (a store must not shrink the scope)', async () => {
    // #1115: the deks key-set is unauthenticated, so a store can strip entries
    // from the target's file. Deriving the rotation scope from it would let the
    // store choose which collections survive a quarantine.
    const store = memoryStore()
    const { db, vault } = await ownerWith(store)
    await vault.collection<{ n: number }>('salaries').put('s-1', { n: 1 })
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    await forgeRole(store, 'carol', 'admin')
    // The store now also strips `salaries` from carol's DEK map.
    const env = (await store.get(VAULT, '_keyring', 'carol'))!
    const file = JSON.parse(env._data) as { deks: Record<string, string> }
    delete file.deks.salaries
    await store.put(VAULT, '_keyring', 'carol', { ...env, _data: JSON.stringify(file) })

    const result = await db.quarantineKeyring(VAULT, 'carol')

    // Both rotate, because the scope came from the OWNER's keyring. Asserted as
    // containment rather than equality: the owner also holds reserved DEKs
    // (`_users` and friends), and over-rotating is the safe direction.
    expect(result.rotated).toContain('invoices')
    expect(result.rotated).toContain('salaries')
  })
})

/**
 * Rows added after an adversarial review of the first draft. Each one is a
 * defect that review found with a probe, not a hypothetical — recorded here so
 * the fix cannot silently regress.
 */
describe('#1121 — what the review of the first draft found', () => {
  it('verifyRoster REPORTS an unparseable file instead of dying on it', async () => {
    // The diagnostic exists for vaults where something is already wrong, and
    // the first draft threw SyntaxError on a truncated file — failing on the
    // single case it most needed to name, and reproducing the vault-wide
    // freeze #1114 removed, inside the tool built to end it.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const env = (await store.get(VAULT, '_keyring', 'bob'))!
    await store.put(VAULT, '_keyring', 'bob', { ...env, _data: env._data.slice(0, 40) })

    const result = await db.verifyRoster(VAULT)
    expect(result.unverified).toEqual([{ userId: 'bob', reason: 'unparseable' }])
    // Still counted, and the healthy members were still checked.
    expect(result.checked).toBe(2)
  })

  it('quarantine can REMOVE an unparseable file — the most literally unauthenticatable one', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const env = (await store.get(VAULT, '_keyring', 'bob'))!
    await store.put(VAULT, '_keyring', 'bob', { ...env, _data: env._data.slice(0, 40) })

    const result = await db.quarantineKeyring(VAULT, 'bob')
    expect(result.reason).toBe('unparseable')
    expect(await store.get(VAULT, '_keyring', 'bob')).toBeNull()
  })

  it('REPORTS who else it de-provisioned — a quarantine rotates broadly', async () => {
    // The first draft discarded rotateKeys' findings, so the operator learned
    // about the other members it had just locked out as unrelated NoAccessErrors
    // later on.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    await forgeRole(store, 'carol', 'admin')
    const result = await db.quarantineKeyring(VAULT, 'carol')

    // bob keeps his keyring but loses the rotated collections until re-granted.
    expect(result.needsRegrant.some((r) => r.userId === 'bob' && r.collection === 'invoices')).toBe(true)
  })

  it('names OTHER forged members it met while rotating', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })
    await db.grant(VAULT, { userId: 'dave', displayName: 'D', role: 'viewer', secret: 'dave-pass-1' })

    await forgeRole(store, 'carol', 'admin')
    await forgeRole(store, 'dave', 'admin')

    const result = await db.quarantineKeyring(VAULT, 'carol')
    expect(result.alsoUnverified.map((u) => u.userId)).toEqual(['dave'])
  })

  it('an INTERRUPTED quarantine resumes instead of reporting not-found', async () => {
    // #1077's shape: delete-then-rotate has no transaction, so a store error in
    // between leaves the file gone and the keys un-rotated. The first draft
    // threw NoAccessError on retry, which reads as "already done" — the failure
    // looking exactly like success.
    let failNextPut = false
    const inner = memoryStore()
    const flaky: NoydbStore = {
      ...inner,
      async put(vault, collection, id, env) {
        if (failNextPut && collection === 'invoices') throw new Error('store offline')
        return inner.put(vault, collection, id, env)
      },
    }
    const db = await createNoydb({ teamStrategy: withTeam(), store: flaky, user: 'owner-01', secret: 'owner-pass-1' })
    const vault = await db.openVault(VAULT)
    await vault.collection<{ amount: number }>('invoices').put('inv-1', { amount: 100 })
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })
    await forgeRole(flaky, 'carol', 'admin')

    failNextPut = true
    await expect(db.quarantineKeyring(VAULT, 'carol')).rejects.toThrow('store offline')
    failNextPut = false

    // The retry finishes the job rather than claiming there is nothing to do.
    const resumed = await db.quarantineKeyring(VAULT, 'carol')
    expect(resumed.rotated.length).toBeGreaterThan(0)
  })
})
