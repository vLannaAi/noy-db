/**
 * #1445 — removing a credential slot HIDES it. Revoking one is three steps.
 *
 * A slot blob is a bearer credential: `on-password`'s `unwrapDeksWithPassword`
 * and `on-webauthn`'s `unwrapKeyringSummary` both carry the DEK map inside the
 * blob and need no store, no keyring and no network. So a blob captured before
 * removal keeps reading every record until the DEKs themselves move.
 *
 * ⛔ TWO PREMISES FAILED ON THIS ISSUE BEFORE THE FIX WAS WRITTEN, both from
 * reading a description instead of the behaviour. They are pinned here so the
 * recipe cannot be "simplified" back into either of them:
 *
 *   1. `rotateSecret` does NOT revoke. It unwraps every DEK with the old KEK
 *      and rewraps THE SAME KEY MATERIAL under a new one. A captured blob holds
 *      DEK VALUES, and records are encrypted with DEKs — so rewrapping changes
 *      nothing the holder needs. Only `rotateKeys` calls `generateDEK()`.
 *   2. `rotateKeys` does NOT preserve credentials. It leaves `authenticators[]`
 *      byte-identical, so every remaining slot silently wraps keys that no
 *      longer exist.
 *
 * Hence the acceptance test has TWO conjuncts, and the second is what
 * distinguishes revocation from collateral damage:
 *
 *   (a) the removed slot's captured material yields no live DEKs;
 *   (b) a slot that was NOT removed still unlocks.
 *
 * A naive rotation passes (a) and fails (b), which is why (a) alone would have
 * blessed a fix that locks every other user out of the vault.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, KeyringAuthenticator } from '../src/kernel/types.js'
import { createOwnerKeyring, loadKeyring, persistKeyring, rotateKeys } from '../src/with-party/team/keyring.js'
import { rotateSecret } from '../src/with-party/team/rotate-recover.js'
import { enrollAuthenticator, removeAuthenticator, revokeAuthenticator } from '../src/with-party/team/authenticators.js'
import { generateDEK } from '../src/kernel/enclave/index.js'

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
const WRAPPED = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE='

/** The DEK's actual bytes — the thing a captured blob carries and records are sealed with. */
async function dekBytes(k: unknown): Promise<string> {
  const raw = await globalThis.crypto.subtle.exportKey('raw', k as CryptoKey)
  return Buffer.from(raw).toString('base64')
}

async function seed(store: NoydbStore) {
  const keyring = await createOwnerKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
  keyring.deks.set('invoices', await generateDEK())
  await persistKeyring(store, 'acme', keyring)
  let k = await enrollAuthenticator(store, 'acme', keyring, {
    id: 'leaked', method: 'webauthn', meta: {}, wrapped_kek: WRAPPED,
  })
  k = await enrollAuthenticator(store, 'acme', k, {
    id: 'keeper', method: 'webauthn', meta: {}, wrapped_kek: WRAPPED,
  })
  return k
}

const slotOf = (ks: readonly KeyringAuthenticator[], id: string): KeyringAuthenticator | undefined =>
  ks.find((a) => a.id === id)

describe('#1445 — the two primitives are not interchangeable', () => {
  it('rotateSecret rewraps the SAME DEKs — it cannot revoke a captured blob', async () => {
    const store = inlineMemory()
    await seed(store)
    const before = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    const captured = await dekBytes(before.deks.get('invoices'))

    await rotateSecret(store, 'acme', 'alice', { oldSecret: PHRASE, newSecret: PHRASE })

    const after = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    // ⛔ Identical. A blob holding these bytes still opens every record.
    expect(await dekBytes(after.deks.get('invoices'))).toBe(captured)
  })

  it('rotateKeys mints fresh DEKs but leaves every slot byte-identical', async () => {
    const store = inlineMemory()
    const k = await seed(store)
    const before = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    const captured = await dekBytes(before.deks.get('invoices'))
    const slotBefore = slotOf(before.authenticators, 'keeper')

    await rotateKeys(store, 'acme', k, { collections: ['invoices'] })

    const after = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    expect(await dekBytes(after.deks.get('invoices'))).not.toBe(captured)
    // ...and the surviving slot was not re-wrapped, so it now wraps a dead key.
    expect(slotOf(after.authenticators, 'keeper')).toEqual(slotBefore)
  })

  it('rotateSecret accepts an unchanged secret, so the re-wrap forces no new phrase', async () => {
    const store = inlineMemory()
    await seed(store)
    await expect(
      rotateSecret(store, 'acme', 'alice', { oldSecret: PHRASE, newSecret: PHRASE }),
    ).resolves.toBeDefined()
    await expect(loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })).resolves.toBeDefined()
  })
})

describe('#1445 — removeAuthenticator alone revokes nothing', () => {
  it('leaves the DEKs a captured blob carries completely untouched', async () => {
    const store = inlineMemory()
    const k = await seed(store)
    const captured = await dekBytes(k.deks.get('invoices'))

    await removeAuthenticator(store, 'acme', k, 'leaked')

    const after = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    expect(slotOf(after.authenticators, 'leaked')).toBeUndefined() // hidden…
    expect(await dekBytes(after.deks.get('invoices'))).toBe(captured) // …but not revoked
  })
})

describe('#1445 — revokeAuthenticator satisfies BOTH conjuncts', () => {
  it('(a) the revoked slot is gone and its captured DEKs are dead, (b) the other slot is re-wrapped and live', async () => {
    const store = inlineMemory()
    const k = await seed(store)
    const before = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    const capturedDek = await dekBytes(before.deks.get('invoices'))
    const keeperBefore = slotOf(before.authenticators, 'keeper')!

    // A ceremony stands in for the credential's own re-wrap. The real ones need
    // the password / a live WebAuthn assertion; what matters here is that it
    // receives the NEW DEK set and produces a slot around it.
    let ceremonySawDek = ''
    const rewrapped = await revokeAuthenticator(store, 'acme', k, {
      slotId: 'leaked',
      secret: PHRASE,
      slotCeremonies: {
        keeper: async (ctx) => {
          ceremonySawDek = await dekBytes(ctx.newDeks.get('invoices'))
          return { id: 'keeper', method: 'webauthn', meta: { rewrapped: true }, wrapped_kek: WRAPPED }
        },
      },
    })
    expect(rewrapped).toBeDefined()

    const after = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })

    // (a) revoked: slot gone, and the DEK a captured blob carries is no longer live.
    expect(slotOf(after.authenticators, 'leaked')).toBeUndefined()
    expect(await dekBytes(after.deks.get('invoices'))).not.toBe(capturedDek)

    // (b) NOT collateral damage: the untouched slot survives, and it was
    //     re-wrapped around the new keys rather than left holding dead ones.
    const keeperAfter = slotOf(after.authenticators, 'keeper')
    expect(keeperAfter).toBeDefined()
    expect(keeperAfter!.meta['rewrapped']).toBe(true)
    expect(ceremonySawDek).toBe(await dekBytes(after.deks.get('invoices')))
    expect(keeperAfter).not.toEqual(keeperBefore)
  })

  it('THE ORDER IS LOAD-BEARING: swapping steps 2 and 3 makes step 3 undo step 2', async () => {
    // Raised by noy-db-on as a question. `rotateSecret`'s ceremonies re-wrap
    // around whatever DEKs are CURRENT, so running them before `rotateKeys`
    // seals the remaining slots around the values that are about to be
    // replaced — the re-wrap silently targets the wrong generation.
    //
    // ⛔ Both orders satisfy conjunct (a): the DEK changes either way. Only
    // conjunct (b) separates them, which is the whole reason (b) exists.
    const store = inlineMemory()
    const k = await seed(store)
    const stale = await dekBytes(k.deks.get('invoices'))

    // WRONG ORDER: remove, re-wrap, THEN rotate.
    const next = await removeAuthenticator(store, 'acme', k, 'leaked')
    let ceremonySawDek = ''
    await rotateSecret(store, 'acme', next.userId, {
      oldSecret: PHRASE, newSecret: PHRASE,
      slotCeremonies: {
        keeper: async (ctx) => {
          ceremonySawDek = await dekBytes(ctx.newDeks.get('invoices'))
          return { id: 'keeper', method: 'webauthn', meta: {}, wrapped_kek: WRAPPED }
        },
      },
    })
    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    await rotateKeys(store, 'acme', reloaded, { collections: ['invoices'] })

    const after = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    const live = await dekBytes(after.deks.get('invoices'))

    // (a) still passes — the key did move.
    expect(live).not.toBe(stale)
    // (b) FAILS: the ceremony sealed 'keeper' around the pre-rotation value, so
    //     the surviving credential now wraps a key nothing is encrypted with.
    expect(ceremonySawDek).toBe(stale)
    expect(ceremonySawDek).not.toBe(live)
  })

  it('a slot with NO ceremony is dropped, not left silently holding dead keys', async () => {
    // rotateSecret's existing behaviour (#29 / PR5), and the honest outcome:
    // after the rotation its blob wraps keys that no longer exist.
    const store = inlineMemory()
    const k = await seed(store)

    await revokeAuthenticator(store, 'acme', k, { slotId: 'leaked', secret: PHRASE })

    const after = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    expect(after.authenticators.map((a) => a.id)).toEqual([])
  })

  it('refuses from a session that cannot see the slot list (#1426 guard still first)', async () => {
    const store = inlineMemory()
    const k = await seed(store)
    await expect(
      revokeAuthenticator(store, 'acme', { ...k, kek: null, authenticators: [] }, {
        slotId: 'leaked', secret: PHRASE,
      }),
    ).rejects.toThrow(/not readable from this session/)

    // And nothing moved: a refused revoke must not have rotated anything.
    const after = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    expect(after.authenticators.map((a) => a.id).sort()).toEqual(['keeper', 'leaked'])
  })
})
