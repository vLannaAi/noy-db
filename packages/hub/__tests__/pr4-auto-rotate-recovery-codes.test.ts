/**
 * PR4 — auto-rotate remaining recovery codes (#36).
 *
 * After a successful paper-recovery, the hub-level
 * `db.recoverPassphrase` defaults to replacing ALL remaining recovery
 * entries with freshly-minted ones. This closes the window where a
 * leaked-or-stolen recovery sheet has 7 still-valid codes after the
 * user reset their phrase.
 *
 * Pinned behaviors:
 *   1. Default auto-rotation — uses 1 of 8 codes; remaining 7 are
 *      replaced; `newCodes` array of length 7 returned.
 *   2. Old remaining codes are invalid post-rotation — the original 7
 *      codes that the user did NOT consume can no longer recover.
 *   3. New codes round-trip — using one of the `newCodes` works for
 *      a subsequent `db.recoverPassphrase`.
 *   4. Opt-out — `rotateRemainingCodes: false` preserves the
 *      previous behavior (only the matched code burned).
 *   5. Custom code count — `newCodeCount: 10` mints exactly 10 codes
 *      regardless of remaining-count.
 *   6. Custom generator — `codeGenerator` callback overrides the
 *      default ULID format.
 *   7. Empty case — single-code enrollment + recovery returns empty
 *      `newCodes` (nothing to rotate).
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import { generateULID, mintPaperRecoveryEntry, loadPaperRecoveryEntries, type PaperRecoveryEntry } from '../src/index.js'
import { InvalidKeyError } from '../src/kernel/errors.js'

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

const ALICE_PHRASE = 'correct horse battery staple printer toaster'
const PHRASE_AFTER_RECOVERY_1 = 'glasses cabinet bicycle umbrella thunder velvet'
const PHRASE_AFTER_RECOVERY_2 = 'evergreen marble lantern apricot velvet thunder'

/** Helper: enroll N recovery codes for the current keyring. */
async function enrollCodes(db: Noydb, vault: string, count: number, codePrefix: string): Promise<string[]> {
  const keyring = await db.team.getKeyring(vault)
  const codes: string[] = []
  const entries: PaperRecoveryEntry[] = []
  for (let i = 0; i < count; i++) {
    const code = `${codePrefix}${i.toString().padStart(3, '0')}AAAAAAA`.toUpperCase()
    codes.push(code)
    entries.push(await mintPaperRecoveryEntry(keyring.deks, code, `${codePrefix}-${i}`))
  }
  await db.team.enrollRecovery(vault, { profile: 'paper', entries })
  return codes
}

describe('db.recoverPassphrase auto-rotate (#36)', () => {
  it('default: rotates 7 remaining codes after consuming 1 of 8', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    const enrolled = await enrollCodes(db, 'acme', 8, 'CODEA')

    const result = await db.team.recoverPassphrase('acme', {
      newPassphrase: PHRASE_AFTER_RECOVERY_1,
      recoveryProof: { profile: 'paper', payload: { code: enrolled[0]! } },
    })

    expect(result.newCodes).toHaveLength(7)
    // Newly minted entries are persisted (the post-burn entries are replaced).
    const post = await loadPaperRecoveryEntries(store, 'acme')
    expect(post).toHaveLength(7)
  }, 120_000)

  it('original remaining codes are invalid after rotation', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    const enrolled = await enrollCodes(db, 'acme', 4, 'CODEB')

    await db.team.recoverPassphrase('acme', {
      newPassphrase: PHRASE_AFTER_RECOVERY_1,
      recoveryProof: { profile: 'paper', payload: { code: enrolled[0]! } },
    })

    // Trying to use enrolled[1] (an ORIGINAL remaining code) now fails —
    // it was wiped by auto-rotation.
    const reopen = await createNoydb({ store, user: 'alice', secret: PHRASE_AFTER_RECOVERY_1 })
    await reopen.openVault('acme')
    await expect(
      reopen.team.recoverPassphrase('acme', {
        newPassphrase: PHRASE_AFTER_RECOVERY_2,
        recoveryProof: { profile: 'paper', payload: { code: enrolled[1]! } },
      }),
    ).rejects.toBeInstanceOf(InvalidKeyError)
  }, 180_000)

  it('newCodes round-trip through a subsequent recovery', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    const enrolled = await enrollCodes(db, 'acme', 3, 'CODEC')

    const { newCodes } = await db.team.recoverPassphrase('acme', {
      newPassphrase: PHRASE_AFTER_RECOVERY_1,
      recoveryProof: { profile: 'paper', payload: { code: enrolled[0]! } },
    })
    expect(newCodes).toHaveLength(2)

    // Re-open under the new phrase and use one of the new codes
    // for a second recovery — proves the new entries are valid.
    const reopen = await createNoydb({ store, user: 'alice', secret: PHRASE_AFTER_RECOVERY_1 })
    await reopen.openVault('acme')
    await expect(
      reopen.team.recoverPassphrase('acme', {
        newPassphrase: PHRASE_AFTER_RECOVERY_2,
        recoveryProof: { profile: 'paper', payload: { code: newCodes[0]! } },
      }),
    ).resolves.toMatchObject({ newCodes: expect.any(Array) })
  }, 180_000)

  it('opt-out: rotateRemainingCodes:false preserves the original behavior', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    const enrolled = await enrollCodes(db, 'acme', 4, 'CODED')

    const result = await db.team.recoverPassphrase('acme', {
      newPassphrase: PHRASE_AFTER_RECOVERY_1,
      recoveryProof: { profile: 'paper', payload: { code: enrolled[0]! } },
      rotateRemainingCodes: false,
    })

    expect(result.newCodes).toHaveLength(0)

    // Original remaining 3 codes are still valid (opt-out preserved
    // pre-#36 behavior).
    const post = await loadPaperRecoveryEntries(store, 'acme')
    expect(post).toHaveLength(3)

    // And one of those original codes still works.
    const reopen = await createNoydb({ store, user: 'alice', secret: PHRASE_AFTER_RECOVERY_1 })
    await reopen.openVault('acme')
    await expect(
      reopen.team.recoverPassphrase('acme', {
        newPassphrase: PHRASE_AFTER_RECOVERY_2,
        recoveryProof: { profile: 'paper', payload: { code: enrolled[1]! } },
        rotateRemainingCodes: false,
      }),
    ).resolves.toMatchObject({ newCodes: expect.any(Array) })
  }, 180_000)

  it('newCodeCount: 10 mints exactly 10 codes regardless of remaining-count', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    const enrolled = await enrollCodes(db, 'acme', 3, 'CODEE')

    const { newCodes } = await db.team.recoverPassphrase('acme', {
      newPassphrase: PHRASE_AFTER_RECOVERY_1,
      recoveryProof: { profile: 'paper', payload: { code: enrolled[0]! } },
      newCodeCount: 10,
    })

    expect(newCodes).toHaveLength(10)
    const post = await loadPaperRecoveryEntries(store, 'acme')
    expect(post).toHaveLength(10)
  }, 180_000)

  it('codeGenerator override produces codes in the consumer\'s format', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    const enrolled = await enrollCodes(db, 'acme', 3, 'CODEF')

    let counter = 0
    const codeGenerator = () => `CUSTOMCODE${(counter++).toString().padStart(2, '0')}AAAA`

    const { newCodes } = await db.team.recoverPassphrase('acme', {
      newPassphrase: PHRASE_AFTER_RECOVERY_1,
      recoveryProof: { profile: 'paper', payload: { code: enrolled[0]! } },
      codeGenerator,
    })

    expect(newCodes).toHaveLength(2)
    expect(newCodes[0]).toBe('CUSTOMCODE00AAAA')
    expect(newCodes[1]).toBe('CUSTOMCODE01AAAA')
  }, 180_000)

  it('empty case: single-code enrollment + recovery returns empty newCodes', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    const enrolled = await enrollCodes(db, 'acme', 1, 'CODEG')

    const { newCodes } = await db.team.recoverPassphrase('acme', {
      newPassphrase: PHRASE_AFTER_RECOVERY_1,
      recoveryProof: { profile: 'paper', payload: { code: enrolled[0]! } },
    })

    expect(newCodes).toHaveLength(0)
    const post = await loadPaperRecoveryEntries(store, 'acme')
    expect(post).toHaveLength(0)
  }, 120_000)
})
