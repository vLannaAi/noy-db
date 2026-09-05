/**
 * #1426 — a security-removal API must never resolve without removing.
 *
 * `UnlockedKeyring.authenticators` is a snapshot. A tier-3 PIN-resumed
 * (or session-restored, or wrap-DEKs tier-2) keyring carries an EMPTY
 * one alongside `kek === null`, because that session never unwrapped
 * the KEK and so never read the slots. `removeAuthenticator` used to
 * filter that empty list, find nothing to drop, and return a
 * successful no-op — leaving the credential on disk and still able to
 * unlock the vault.
 *
 * The asymmetry that made it sharp: a tier-2 password-resumed session
 * has a NON-empty list, so it reaches `persistKeyring` and fails loudly
 * on the null KEK. Same nominal capability, opposite failure modes —
 * one refuses, one lies.
 *
 * Pinned here:
 *   1. remove @ kek=null + empty list → throws, slot survives on disk.
 *   2. remove @ kek=null + populated list → throws with the SAME error
 *      class (the two tiers now agree).
 *   3. update @ kek=null → "not visible", not the misleading "not found".
 *   4. enroll @ kek=null → refuses before the duplicate-id decision.
 *   5. tier-1 removal still genuinely removes.
 *   6. tier-1 removal of an absent slot is still a quiet, idempotent
 *      no-op — the guard must not turn idempotency into an error.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createOwnerKeyring, loadKeyring, persistKeyring } from '../src/with-party/team/keyring.js'
import type { UnlockedKeyring } from '../src/with-party/team/keyring.js'
import {
  enrollAuthenticator,
  removeAuthenticator,
  updateAuthenticator,
} from '../src/with-party/team/authenticators.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import { ValidationError } from '../src/kernel/errors.js'

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
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const PHRASE = 'correct horse battery staple printer toaster'
const WRAPPED_KEK = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE='

/** Enrol one slot at tier 1 and return the persisted, unlocked keyring. */
async function withOneSlot(store: NoydbStore): Promise<UnlockedKeyring> {
  const keyring = await createOwnerKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
  keyring.deks.set('invoices', await generateDEK())
  await persistKeyring(store, 'acme', keyring)
  return enrollAuthenticator(store, 'acme', keyring, {
    id: 'password',
    method: 'webauthn',
    meta: { credentialId: 'cred-pw' },
    wrapped_kek: WRAPPED_KEK,
  })
}

/**
 * The shape a tier-3 PIN resume hands back: DEKs are live, but the KEK
 * was never unwrapped, so the slot list was never read.
 */
function asTier3Resume(keyring: UnlockedKeyring): UnlockedKeyring {
  return { ...keyring, kek: null, authenticators: [] }
}

describe('#1426 — slot decisions taken from a keyring that cannot see the slot list', () => {
  it('refuses removal at tier 3 instead of reporting a successful no-op, and the slot survives', async () => {
    const store = inlineMemory()
    const enrolled = await withOneSlot(store)

    await expect(
      removeAuthenticator(store, 'acme', asTier3Resume(enrolled), 'password'),
    ).rejects.toThrow(ValidationError)

    // The point of the issue: the credential is still there and still usable.
    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    expect(reloaded.authenticators.map((a) => a.id)).toEqual(['password'])
  })

  it('gives tier-3 and tier-2 resumed sessions the SAME failure, not opposite ones', async () => {
    const store = inlineMemory()
    const enrolled = await withOneSlot(store)

    // Tier 3: empty list — used to short-circuit and resolve.
    const tier3 = removeAuthenticator(store, 'acme', asTier3Resume(enrolled), 'password')
    // Tier 2 (wrap-DEKs): list populated, KEK still null — always threw.
    const tier2 = removeAuthenticator(store, 'acme', { ...enrolled, kek: null }, 'password')

    await expect(tier3).rejects.toThrow(ValidationError)
    await expect(tier2).rejects.toThrow(ValidationError)
  })

  it('reports update as not-visible rather than not-found', async () => {
    const store = inlineMemory()
    const enrolled = await withOneSlot(store)

    await expect(
      updateAuthenticator(store, 'acme', asTier3Resume(enrolled), 'password', {
        meta: { nickname: 'x' },
      }),
    ).rejects.toThrow(/not readable from this session/)
  })

  it('refuses enrollment before the duplicate-id decision', async () => {
    const store = inlineMemory()
    const enrolled = await withOneSlot(store)

    // Re-enrolling an id that DOES exist on disk: the empty snapshot would
    // have seen no duplicate and gone on to persist a keyring with the real
    // slot missing from it.
    await expect(
      enrollAuthenticator(store, 'acme', asTier3Resume(enrolled), {
        id: 'password',
        method: 'webauthn',
        meta: {},
        wrapped_kek: WRAPPED_KEK,
      }),
    ).rejects.toThrow(/not readable from this session/)
  })

  it('still removes for real at tier 1', async () => {
    const store = inlineMemory()
    const enrolled = await withOneSlot(store)

    await removeAuthenticator(store, 'acme', enrolled, 'password')

    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    expect(reloaded.authenticators).toEqual([])
  })

  it('keeps tier-1 removal of an absent slot a quiet no-op', async () => {
    const store = inlineMemory()
    const enrolled = await withOneSlot(store)

    const same = await removeAuthenticator(store, 'acme', enrolled, 'never-enrolled')

    expect(same).toBe(enrolled)
    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    expect(reloaded.authenticators.map((a) => a.id)).toEqual(['password'])
  })
})
