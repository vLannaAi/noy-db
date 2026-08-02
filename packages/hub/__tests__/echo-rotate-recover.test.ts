/**
 * Echo-shaped `rotateSecret` / `recoverSecret` (#940, task 7).
 *
 * Four write sites rewrap a keyring's DEKs under a freshly-derived KEK:
 * `rotateSecret`, `recoverViaPaperCode`, `recoverViaShamir` and
 * `recoverUser`. Each of them USED to persist the next keyring file with a
 * plain `{ ...file }` spread, which:
 *
 *   - carried a STALE `echo` block across an echo→standard change (the block
 *     says "this keyring needs the echo ceremony" while the DEKs are wrapped
 *     under a string-derived KEK → `loadKeyring` refuses the string with
 *     `EchoCeremonyRequiredError` and the echo parts no longer derive the KEK:
 *     the keyring is permanently bricked), and
 *   - missed the block on a standard→echo upgrade.
 *
 * Pinned here:
 *   1. standard → echo upgrade via rotateSecret (portable + sealed reveal).
 *   2. echo → standard downgrade via rotateSecret (block REMOVED).
 *   3. tier-2 slot survives a mode-changing rotation.
 *   4. recoverSecret (paper) with echo parts ⇒ fresh portable block.
 *   5. recoverSecret (paper/shamir) with a string on an echo keyring ⇒ block gone.
 *   6. recoverUser (peer recovery) with a string on an echo keyring ⇒ block gone.
 */
import { describe, it, expect } from 'vitest'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  KeyringFile,
  KeyringAuthenticator,
} from '../src/kernel/types.js'
import { ConflictError, EchoCeremonyRequiredError, ValidationError } from '../src/kernel/errors.js'
import { WeakSecretError } from '../src/kernel/validation.js'
import { createNoydb } from '../src/kernel/noydb.js'
import {
  createOwnerKeyring,
  loadKeyring,
  persistKeyring,
  grant,
} from '../src/with-party/team/keyring.js'
import {
  rotateSecret,
  recoverSecret,
  type SlotRewrapCeremony,
} from '../src/with-party/team/rotate-recover.js'
import { recoverUser } from '../src/with-party/team/peer-recover.js'
import { buildEchoBlock } from '../src/with-party/team/echo-secret.js'
import { MemoryDeviceSealProvider } from '../src/with-party/team/device-seal.js'
import {
  savePaperRecoveryEntries,
  mintPaperRecoveryEntry,
} from '../src/with-party/team/recovery.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import { shamirRecoveryProvider } from '@noy-db/on-shamir'

// Same inline in-memory store pattern as __tests__/keyring.test.ts:17-42.
function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

// Word lengths respect DEFAULT_MIN_WORD_LENGTH = 3 (see echo-validation.test.ts).
const PARTS = { prompt: 'sono chiamato vicio', echo: 'quando ero piccolo tutti chiamavano', key: 'ciccio patata' }
const PARTS_2 = { prompt: 'come ero chiamato', echo: 'dalla nonna quando ero bambino', key: 'patata bollente' }
const STRONG_OLD = 'correct horse battery staple printer toaster'
const STRONG_NEW = 'glasses cabinet bicycle umbrella thunder velvet'
const T = 600_000

async function readKeyringFile(store: NoydbStore, vault: string, userId: string): Promise<KeyringFile> {
  const env = await store.get(vault, '_keyring', userId)
  return JSON.parse(env!._data) as KeyringFile
}

/**
 * Seed a STANDARD keyring and graft an echo block onto the stored file.
 *
 * The DEK wrapping stays string-derived — which is exactly the state a
 * spread-carried stale block leaves behind, and the state the recovery
 * paths must clean up. Same seeding trick as echo-load-keyring.test.ts:43-47;
 * used for the shamir + peer-recover sites where driving a genuine echo
 * enrollment would add a second full ceremony to the fixture without
 * changing what is under test (the block's presence in the written file).
 */
async function graftEchoBlock(store: NoydbStore, vault: string, userId: string): Promise<void> {
  const env = await store.get(vault, '_keyring', userId)
  const file = JSON.parse(env!._data) as KeyringFile
  const withEcho = { ...file, echo: await buildEchoBlock(PARTS, { kind: 'none' }) }
  await store.put(vault, '_keyring', userId, { ...env!, _data: JSON.stringify(withEcho) })
}

describe('rotateSecret across secret modes (#940)', () => {
  it('standard → echo upgrade: echo block appears, parts unlock, old string refused', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'owner', secret: STRONG_OLD })
    await db.openVault('acme')
    db.close()

    await rotateSecret(store, 'acme', 'owner', { oldSecret: STRONG_OLD, newSecret: PARTS })

    const file = await readKeyringFile(store, 'acme', 'owner')
    expect(file.echo?.v).toBe(1)
    expect(file.echo?.reveal.kind).toBe('portable')

    await expect(loadKeyring(store, 'acme', { userId: 'owner', secret: PARTS })).resolves.toBeDefined()
    await expect(
      loadKeyring(store, 'acme', { userId: 'owner', secret: STRONG_OLD }),
    ).rejects.toThrow(EchoCeremonyRequiredError)
  }, T)

  it('echoOptions.deviceSeal produces a sealed reveal', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'owner', secret: STRONG_OLD })
    await db.openVault('acme')
    db.close()

    const seal = new MemoryDeviceSealProvider({ id: 'test:dev' })
    await rotateSecret(store, 'acme', 'owner', {
      oldSecret: STRONG_OLD,
      newSecret: PARTS,
      echoOptions: { deviceSeal: seal, maskHint: 'la parola della nonna' },
    })

    const file = await readKeyringFile(store, 'acme', 'owner')
    expect(file.echo?.reveal.kind).toBe('sealed')
    if (file.echo?.reveal.kind === 'sealed') expect(file.echo.reveal.provider_hint).toBe('test:dev')
    expect(file.echo?.mask_hint).toBe('la parola della nonna')
    await expect(loadKeyring(store, 'acme', { userId: 'owner', secret: PARTS })).resolves.toBeDefined()
  }, T)

  it('echo → standard downgrade: echo block removed, string unlocks again', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'owner', secretMode: 'echo', secret: PARTS })
    await db.openVault('acme')
    db.close()

    await rotateSecret(store, 'acme', 'owner', { oldSecret: PARTS, newSecret: STRONG_NEW })

    const file = await readKeyringFile(store, 'acme', 'owner')
    expect(file.echo).toBeUndefined()
    await expect(
      loadKeyring(store, 'acme', { userId: 'owner', secret: STRONG_NEW }),
    ).resolves.toBeDefined()
  }, T)

  it('echo → echo rotation re-mints the block; the OLD parts stop working', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'owner', secretMode: 'echo', secret: PARTS })
    await db.openVault('acme')
    db.close()

    const before = await readKeyringFile(store, 'acme', 'owner')
    await rotateSecret(store, 'acme', 'owner', { oldSecret: PARTS, newSecret: PARTS_2 })
    const after = await readKeyringFile(store, 'acme', 'owner')

    expect(after.echo).toBeDefined()
    expect(after.echo?.prompt_verifier).not.toBe(before.echo?.prompt_verifier)
    await expect(loadKeyring(store, 'acme', { userId: 'owner', secret: PARTS_2 })).resolves.toBeDefined()
    await expect(loadKeyring(store, 'acme', { userId: 'owner', secret: PARTS })).rejects.toThrow()
  }, T)

  it('refuses a string oldSecret on an echo keyring (deriveKekForKeyring guard)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'owner', secretMode: 'echo', secret: PARTS })
    await db.openVault('acme')
    db.close()

    await expect(
      rotateSecret(store, 'acme', 'owner', { oldSecret: STRONG_OLD, newSecret: STRONG_NEW }),
    ).rejects.toThrow(EchoCeremonyRequiredError)
  }, T)

  it('preserves a tier-2 slot across a standard → echo rotation', async () => {
    // Ported from pr5-rotate-preserve-slots.test.ts ('preserves a wrap-DEKs
    // slot via ceremony'), with `newSecret` swapped for echo parts — proves a
    // mode-changing rotation still composes with tier-2 slot rewrapping.
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', { userId: 'alice', secret: STRONG_OLD })
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    const slot: KeyringAuthenticator = {
      id: 'password',
      method: 'password',
      enrolled_at: '2026-01-01T00:00:00Z',
      enrolled_via_tier: 1,
      wrapKind: 'deks',
      wrapped_deks: 'OLDWRAPPEDDEKSBASE64',
      iv: 'OLDIVBASE64',
      meta: { salt: 'OLDSALT', minLength: 12 },
    }
    const env = await store.get('acme', '_keyring', 'alice')
    const file = JSON.parse(env!._data) as KeyringFile
    await store.put('acme', '_keyring', 'alice', {
      ...env!,
      _data: JSON.stringify({ ...file, authenticators: [slot] }),
    })

    const passwordCeremony: SlotRewrapCeremony = async ({ oldSlot }) => ({
      id: oldSlot.id,
      method: 'password',
      wrapKind: 'deks',
      wrapped_deks: 'NEWWRAPPEDDEKSBASE64',
      iv: 'NEWIVBASE64',
      meta: { salt: 'NEWSALT', minLength: 14 },
    })

    await rotateSecret(store, 'acme', 'alice', {
      oldSecret: STRONG_OLD,
      newSecret: PARTS,
      slotCeremonies: { password: passwordCeremony },
    })

    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: PARTS })
    expect(reloaded.authenticators).toHaveLength(1)
    const kept = reloaded.authenticators[0]!
    expect(kept.id).toBe('password')
    if (kept.wrapKind === 'deks') {
      expect(kept.wrapped_deks).toBe('NEWWRAPPEDDEKSBASE64')
    } else {
      throw new Error('expected wrap-DEKs slot')
    }
  }, T)

  it('rotateSecret echoSecretPolicy applies to the new parts', async () => {
    // PARTS.prompt ('sono chiamato vicio') is exactly 3 words — passes the
    // echo default floor but fails an explicit { minWords: 4 } override, and
    // the keyring must be left untouched by the rejected rotation.
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'owner', secret: STRONG_OLD })
    await db.openVault('acme')
    db.close()
    const before = await readKeyringFile(store, 'acme', 'owner')

    await expect(
      rotateSecret(store, 'acme', 'owner', {
        oldSecret: STRONG_OLD,
        newSecret: PARTS,
        echoSecretPolicy: { prompt: { minWords: 4 } },
      }),
    ).rejects.toThrow(WeakSecretError)

    const after = await readKeyringFile(store, 'acme', 'owner')
    expect(after).toEqual(before)
    await expect(loadKeyring(store, 'acme', { userId: 'owner', secret: STRONG_OLD })).resolves.toBeDefined()
  }, T)

  it('malformed echo parts as newSecret throw at the chokepoint — no keyring is minted', async () => {
    // `allowWeakSecret: true` bypasses the validation layer, so the ONLY
    // thing standing between a malformed parts object and a bricked keyring
    // is the encodeEchoParts type guard in the enclave.
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'owner', secret: STRONG_OLD })
    await db.openVault('acme')
    db.close()
    const before = await readKeyringFile(store, 'acme', 'owner')

    await expect(
      rotateSecret(store, 'acme', 'owner', {
        oldSecret: STRONG_OLD,
        newSecret: { prompt: 'sono chiamato vicio', key: 'ciccio patata' } as never,
        allowWeakSecret: true,
      }),
    ).rejects.toThrow(ValidationError)

    const after = await readKeyringFile(store, 'acme', 'owner')
    expect(after.echo).toBeUndefined()
    expect(after.salt).toBe(before.salt)
    await expect(loadKeyring(store, 'acme', { userId: 'owner', secret: STRONG_OLD })).resolves.toBeDefined()
  }, T)
})

describe('recoverSecret across secret modes (#940)', () => {
  async function seedPaper(userSecret: string): Promise<{ store: NoydbStore; code: string }> {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', { userId: 'alice', secret: userSecret })
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)
    const code = 'TESTCODE12345'
    const entry = await mintPaperRecoveryEntry(keyring.deks, code, 'entry-001')
    await savePaperRecoveryEntries(store, 'acme', [entry])
    return { store, code }
  }

  it('paper recovery to echo parts: a fresh portable block appears and the parts unlock', async () => {
    const { store, code } = await seedPaper(STRONG_OLD)

    await recoverSecret(undefined, store, 'acme', 'alice', {
      newSecret: PARTS,
      recoveryProof: { profile: 'paper', payload: { code } },
    })

    const file = await readKeyringFile(store, 'acme', 'alice')
    expect(file.echo?.v).toBe(1)
    expect(file.echo?.reveal.kind).toBe('portable')

    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: PARTS })
    expect(reloaded.userId).toBe('alice')
    await expect(
      loadKeyring(store, 'acme', { userId: 'alice', secret: STRONG_OLD }),
    ).rejects.toThrow(EchoCeremonyRequiredError)
  }, T)

  it('paper recovery to a string on a previously-echo keyring drops the stale block', async () => {
    const { store, code } = await seedPaper(STRONG_OLD)
    await graftEchoBlock(store, 'acme', 'alice')

    await recoverSecret(undefined, store, 'acme', 'alice', {
      newSecret: STRONG_NEW,
      recoveryProof: { profile: 'paper', payload: { code } },
    })

    const file = await readKeyringFile(store, 'acme', 'alice')
    expect(file.echo).toBeUndefined()
    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: STRONG_NEW })
    expect(reloaded.userId).toBe('alice')
  }, T)

  it('shamir recovery to a string on an echo keyring drops the stale block', async () => {
    // Real shamir flow (enrol → recover) on a genuine echo keyring.
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secretMode: 'echo',
      secret: PARTS,
      shamirRecovery: shamirRecoveryProvider(),
    })
    await db.openVault('acme')
    const { shares } = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3 })

    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: { profile: 'shamir', payload: { shares: [shares![0]!, shares![1]!] } },
    })
    db.close()

    const file = await readKeyringFile(store, 'acme', 'alice')
    expect(file.echo).toBeUndefined()
    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: STRONG_NEW })
    expect(reloaded.userId).toBe('alice')
  }, T)

  it('shamir recovery to echo parts mints a fresh block', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: STRONG_OLD,
      shamirRecovery: shamirRecoveryProvider(),
    })
    await db.openVault('acme')
    const { shares } = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3 })

    await db.team.recoverSecret('acme', {
      newSecret: PARTS,
      recoveryProof: { profile: 'shamir', payload: { shares: [shares![0]!, shares![1]!] } },
    })
    db.close()

    const file = await readKeyringFile(store, 'acme', 'alice')
    expect(file.echo?.reveal.kind).toBe('portable')
    await expect(loadKeyring(store, 'acme', { userId: 'alice', secret: PARTS })).resolves.toBeDefined()
  }, T)
})

describe('recoverUser (peer recovery) on an echo keyring (#940)', () => {
  it('drops the stale echo block — the recovered user gets a STANDARD keyring', async () => {
    // `RecoverUserOptions.secret` is a string by design (widening peer
    // recovery to echo parts is out of scope for task 7), so the only correct
    // outcome is a standard keyring: the temp secret is a single-use bridge
    // and the recipient picks their own shape via `rotateSecret`.
    const store = inlineMemory()
    const alice = await createOwnerKeyring(store, 'acme', { userId: 'alice', secret: STRONG_OLD })
    alice.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', alice)
    await grant(store, 'acme', alice, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      secret: STRONG_NEW,
    })
    await graftEchoBlock(store, 'acme', 'bob')

    const temp = 'temporary umbrella cabinet bicycle thunder velvet glasses'
    await recoverUser(store, 'acme', alice, { userId: 'bob', secret: temp })

    const file = await readKeyringFile(store, 'acme', 'bob')
    expect(file.echo).toBeUndefined()
    const reloaded = await loadKeyring(store, 'acme', { userId: 'bob', secret: temp })
    expect(reloaded.userId).toBe('bob')
    expect(reloaded.role).toBe('admin')
  }, T)
})
