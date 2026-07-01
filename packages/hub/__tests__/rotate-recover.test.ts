/**
 * rotatePassphrase + recoverPassphrase (paper profile) — issue #10.
 *
 * Covers:
 *   - rotate happy path (old phrase + new phrase → reads still work)
 *   - rotate rejects weak new phrase
 *   - rotate rejects wrong old phrase (InvalidKeyError)
 *   - recover paper happy path: code → new phrase → reads work, code burned
 *   - recover paper rejects unknown code (InvalidKeyError)
 *   - recover non-paper profiles throw RecoveryProfileNotImplementedError
 *   - createNoydb without a recovery profile throws RecoveryNotEnrolledError when
 *     `recover-passphrase` gate is enabled (default)
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createOwnerKeyring, loadKeyring } from '../src/with-party/team/keyring.js'
import {
  rotatePassphrase,
  recoverPassphrase,
  type RecoveryProof,
} from '../src/with-party/team/rotate-recover.js'
import {
  savePaperRecoveryEntries,
  mintPaperRecoveryEntry,
  loadPaperRecoveryEntries,
} from '../src/with-party/team/recovery.js'
import { generateDEK } from '../src/kernel/enclave/crypto.js'
import { persistKeyring } from '../src/with-party/team/keyring.js'
import { WeakPassphraseError } from '../src/validation.js'
import { InvalidKeyError } from '../src/errors.js'
import { RecoveryProfileNotImplementedError } from '../src/policy/errors.js'

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
    async get(c, col, id) { return gc(c, col).get(id) },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { gc(c, col).delete(id) },
    async list(c, col) { return [...gc(c, col).keys()] },
    async loadAll(c) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      const comp = store.get(c) ?? new Map()
      for (const [col, recs] of comp) {
        out[col] = Object.fromEntries(recs)
      }
      return out
    },
    async saveAll(c, data: Record<string, Record<string, EncryptedEnvelope>>) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [col, recs] of Object.entries(data)) {
        comp.set(col, new Map(Object.entries(recs)))
      }
      store.set(c, comp)
    },
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const STRONG_OLD = 'correct horse battery staple printer toaster'
const STRONG_NEW = 'glasses cabinet bicycle umbrella thunder velvet'

describe('rotatePassphrase', () => {
  it('rotates from old phrase to new and lets the user re-unlock', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', STRONG_OLD)
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    await rotatePassphrase(store, 'acme', 'alice', {
      oldPassphrase: STRONG_OLD,
      newPassphrase: STRONG_NEW,
    })

    await expect(loadKeyring(store, 'acme', 'alice', STRONG_OLD)).rejects.toBeInstanceOf(InvalidKeyError)

    const reloaded = await loadKeyring(store, 'acme', 'alice', STRONG_NEW)
    expect(reloaded.userId).toBe('alice')
  }, 60_000)

  it('rejects a weak new phrase', async () => {
    const store = inlineMemory()
    await createOwnerKeyring(store, 'acme', 'alice', STRONG_OLD)
    await expect(
      rotatePassphrase(store, 'acme', 'alice', {
        oldPassphrase: STRONG_OLD,
        newPassphrase: 'abc',
      }),
    ).rejects.toBeInstanceOf(WeakPassphraseError)
  })

  it('rejects a wrong old phrase', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', STRONG_OLD)
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)
    await expect(
      rotatePassphrase(store, 'acme', 'alice', {
        oldPassphrase: 'wrong horse battery staple printer toaster',
        newPassphrase: STRONG_NEW,
      }),
    ).rejects.toBeInstanceOf(InvalidKeyError)
  }, 60_000)
})

describe('recoverPassphrase (paper profile)', () => {
  async function buildVaultWithPaperRecovery(): Promise<{
    store: NoydbStore
    code: string
  }> {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', STRONG_OLD)

    // Add one DEK so the rewrap path actually rewraps something.
    const dek = await generateDEK()
    keyring.deks.set('invoices', dek)
    keyring.deks.set('clients', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    const code = 'TESTCODE12345'
    const entry = await mintPaperRecoveryEntry(keyring.deks, code, 'entry-001')
    await savePaperRecoveryEntries(store, 'acme', [entry])
    return { store, code }
  }

  it('recovers via a paper code, unlocks with the new phrase, burns the code', async () => {
    const { store, code } = await buildVaultWithPaperRecovery()

    await recoverPassphrase(undefined, store, 'acme', 'alice', {
      newPassphrase: STRONG_NEW,
      recoveryProof: { profile: 'paper', payload: { code } },
    })

    const reloaded = await loadKeyring(store, 'acme', 'alice', STRONG_NEW)
    expect(reloaded.userId).toBe('alice')

    // Code was burned — second use must fail with no entries left.
    await expect(
      recoverPassphrase(undefined, store, 'acme', 'alice', {
        newPassphrase: 'glasses cabinet bicycle umbrella thunder oranges',
        recoveryProof: { profile: 'paper', payload: { code } },
      }),
    ).rejects.toThrow()
  }, 60_000)

  it('issue #84: burn happens before keyring rewrite — failed rewrite leaves code BURNED, old phrase intact', async () => {
    // Pre-fix ordering (write keyring → burn code) made store-side failure
    // between the two writes leave the consumed code reusable: keyring is
    // already on the new passphrase, but the burn step never landed. After
    // #84, burn comes first — so a failure on the keyring write leaves the
    // user on their OLD passphrase with the code GONE.
    const { store, code } = await buildVaultWithPaperRecovery()

    // Wrap the store: every put to `_keyring` fails. The recovery call's
    // first `_keyring` put is the rewrap (the initial create has already
    // happened in buildVaultWithPaperRecovery via persistKeyring on the
    // unwrapped base). The burn write is a put to `_meta/recovery-paper`,
    // not `_keyring`, so it succeeds.
    const wrapped: NoydbStore = {
      ...(store as NoydbStore),
      async put(c, col, id, env, ev) {
        if (col === '_keyring') throw new Error('simulated store failure on keyring write')
        return store.put(c, col, id, env, ev)
      },
    } as NoydbStore

    await expect(
      recoverPassphrase(undefined, wrapped, 'acme', 'alice', {
        newPassphrase: STRONG_NEW,
        recoveryProof: { profile: 'paper', payload: { code } },
      }),
    ).rejects.toThrow()

    // Code is GONE — burned before the failing keyring write.
    const remaining = await loadPaperRecoveryEntries(store, 'acme')
    expect(remaining).toHaveLength(0)

    // Old passphrase still works — the keyring was never rewritten.
    const reloaded = await loadKeyring(store, 'acme', 'alice', STRONG_OLD)
    expect(reloaded.userId).toBe('alice')
  }, 60_000)

  it('rejects an unknown paper code', async () => {
    const { store } = await buildVaultWithPaperRecovery()
    await expect(
      recoverPassphrase(undefined, store, 'acme', 'alice', {
        newPassphrase: STRONG_NEW,
        recoveryProof: { profile: 'paper', payload: { code: 'WRONGCODE0000' } },
      }),
    ).rejects.toBeInstanceOf(InvalidKeyError)
  }, 60_000)

  it('shamir profile dispatches to the Shamir handler (#196 slice 1)', async () => {
    // As of #196 slice 1 the shamir profile is wired end-to-end.
    // Full positive coverage lives in shamir-recovery.test.ts.
    // Here we just verify the dispatch — calling with no enrolled
    // Shamir entry surfaces a NoAccessError from the Shamir handler,
    // not a RecoveryProfileNotImplementedError from the dispatch
    // guard. (Garbage share strings would fail decoding before reaching
    // the no-entries check, so we use a syntactically valid share.)
    const store = inlineMemory()
    await createOwnerKeyring(store, 'acme', 'alice', STRONG_OLD)
    await expect(
      recoverPassphrase(undefined, store, 'acme', 'alice', {
        newPassphrase: STRONG_NEW,
        recoveryProof: {
          profile: 'shamir',
          // Two well-formed-but-meaningless share strings; they will
          // decode but combine to a secret matching no enrolled entry.
          payload: { shares: [
            'SHAMIR_S1_K2N3__AAEEAAAA-AAAA-AAAA-AAAA-AAAA-AAAA',
            'SHAMIR_S2_K2N3__AAIEAAAA-AAAA-AAAA-AAAA-AAAA-AAAA',
          ] },
        },
      }),
      // No Shamir entries → NoAccessError (or the provider-missing error) from
      // the handler; a strict RecoveryProfileNotImplementedError would mean the
      // dispatch is broken.
    ).rejects.not.toBeInstanceOf(RecoveryProfileNotImplementedError)
  })

  it('createNoydb({ requireRecovery: true }) throws when no recovery is enrolled', async () => {
    const { createNoydb } = await import('../src/noydb.js')
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: STRONG_OLD,
      requireRecovery: true,
    })
    await expect(db.openVault('acme')).rejects.toThrow(/recovery profile not enrolled/i)
  })

  it('createNoydb({ requireRecovery: true }) accepts when paper recovery is pre-enrolled', async () => {
    const { createNoydb } = await import('../src/noydb.js')
    const store = inlineMemory()
    // Pre-enrol paper-recovery entries directly via the storage helper.
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', STRONG_OLD)
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)
    const { mintPaperRecoveryEntry } = await import('../src/with-party/team/recovery.js')
    const entry = await mintPaperRecoveryEntry(keyring.deks, 'TESTCODE12345', 'entry-001')
    await savePaperRecoveryEntries(store, 'acme', [entry])

    const db = await createNoydb({
      store,
      user: 'alice',
      secret: STRONG_OLD,
      requireRecovery: true,
    })
    const vault = await db.openVault('acme')
    expect(vault).toBeDefined()
  }, 60_000)

  it('throws RecoveryProfileNotImplementedError for multi-channel and admin-mediated', async () => {
    const store = inlineMemory()
    await createOwnerKeyring(store, 'acme', 'alice', STRONG_OLD)
    await expect(
      recoverPassphrase(undefined, store, 'acme', 'alice', {
        newPassphrase: STRONG_NEW,
        recoveryProof: { profile: 'multi-channel', payload: { proofs: [] } } as unknown as RecoveryProof,
      }),
    ).rejects.toBeInstanceOf(RecoveryProfileNotImplementedError)

    await expect(
      recoverPassphrase(undefined, store, 'acme', 'alice', {
        newPassphrase: STRONG_NEW,
        recoveryProof: { profile: 'admin-mediated', payload: { token: 'x' } } as unknown as RecoveryProof,
      }),
    ).rejects.toBeInstanceOf(RecoveryProfileNotImplementedError)
  })
})

