/**
 * End-to-end proof of `secretMode: 'echo'` (spec
 * design-history/2026-08-02-echo-secret-design.md, #940).
 *
 * This is the positive coverage of the `deriveEchoKey` dispatch leg in
 * `loadKeyring`/`deriveKekForKeyring`: a vault is CREATED under echo parts,
 * data is written, and a fresh `createNoydb` REOPENS it with the same parts
 * and reads that data back. AG-1 (no single string is key-equivalent) is
 * proven negatively in the same test.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, KeyringFile } from '../src/kernel/types.js'
import { ConflictError, EchoCeremonyRequiredError, ValidationError } from '../src/kernel/errors.js'
import { WeakSecretError } from '../src/kernel/validation.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { MemoryDeviceSeal } from '../src/with-party/team/device-seal.js'
import { MemorySealer } from '../src/index.js'
import { beginEchoUnlock } from '../src/with-party/team/echo-ceremony.js'

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

// Word lengths respect the pre-existing DEFAULT_MIN_WORD_LENGTH = 3 floor
// (see the same note in echo-validation.test.ts) so the fixture stays valid
// even when a caller opts into `validateSecret: true`.
const PARTS = { prompt: 'sono chiamato vicio', echo: 'quando ero piccolo tutti chiamavano', key: 'ciccio patata' }
const T = 600_000

// The product's canonical example (#952) — 2-letter Italian words ("mi",
// "da") that only pass under echo validation's relaxed
// DEFAULT_ECHO_MIN_WORD_LENGTH (1), not the standard floor (3).
const CANONICAL_PARTS = {
  prompt: 'mi chiamo vicio',
  echo: 'ma da piccolo al santanna mi chiamavano',
  key: 'ciccio',
}

interface Note { note: string }

describe('echo mode end to end', () => {
  it('creates, writes, reopens with parts; refuses a string; refuses wrong parts', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'owner', secretMode: 'echo', secret: PARTS })
    const vault = await db.openVault('acme')
    await vault.collection<Note>('notes').put('n1', { note: 'ciao' })
    db.close()

    // Reopen with the same parts — proves the deriveEchoKey load leg.
    const db2 = await createNoydb({ store, user: 'owner', secretMode: 'echo', secret: PARTS })
    const v2 = await db2.openVault('acme')
    expect(await v2.collection<Note>('notes').get('n1')).toEqual({ note: 'ciao' })
    db2.close()

    // AG-1: a single string can never unlock it — even the joined form.
    const joined = `${PARTS.prompt}#${PARTS.echo}#${PARTS.key}`
    const db3 = await createNoydb({ store, user: 'owner', secret: joined })
    await expect(db3.openVault('acme')).rejects.toThrow(EchoCeremonyRequiredError)
    db3.close()

    // Wrong key part fails like a wrong secret (canary → InvalidKeyError path).
    const db4 = await createNoydb({ store, user: 'owner', secretMode: 'echo', secret: { ...PARTS, key: 'sbagliato' } })
    await expect(db4.openVault('acme')).rejects.toThrow()
    db4.close()
  }, T)

  it('option validation: echo+string, parts-without-echo-mode, deviceSeal-without-echo all throw', async () => {
    const store = inlineMemory()
    await expect(
      createNoydb({ store, user: 'o', secretMode: 'echo', secret: 'una stringa sola' }),
    ).rejects.toThrow(ValidationError)
    await expect(createNoydb({ store, user: 'o', secret: PARTS })).rejects.toThrow(ValidationError)
    await expect(
      createNoydb({
        store,
        user: 'o',
        secret: 'valide parole scelte per questa policy',
        deviceSeal: new MemoryDeviceSeal({ id: 'test:dev' }),
      }),
    ).rejects.toThrow(ValidationError)
    await expect(createNoydb({ store, user: 'o', secretMode: 'echo' })).rejects.toThrow(ValidationError)
  })

  it('deviceSeal at createNoydb ⇒ sealed reveal on the owner keyring', async () => {
    const store = inlineMemory()
    const seal = new MemoryDeviceSeal({ id: 'test:dev' })
    const db = await createNoydb({ store, user: 'owner', secretMode: 'echo', secret: PARTS, deviceSeal: seal })
    await db.openVault('acme')
    const env = await store.get('acme', '_keyring', 'owner')
    const file = JSON.parse(env!._data) as KeyringFile
    expect(file.echo?.reveal.kind).toBe('sealed')
    if (file.echo?.reveal.kind === 'sealed') expect(file.echo.reveal.provider_hint).toBe('test:dev')
    db.close()
  }, T)

  it('without deviceSeal the owner keyring enrolls a portable reveal', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'owner', secretMode: 'echo', secret: PARTS })
    await db.openVault('acme')
    const env = await store.get('acme', '_keyring', 'owner')
    const file = JSON.parse(env!._data) as KeyringFile
    expect(file.echo?.reveal.kind).toBe('portable')
    db.close()
  }, T)

  it('an object secret missing prompt/echo/key never derives "undefined" — it is rejected up front', async () => {
    const store = inlineMemory()
    await expect(
      createNoydb({ store, user: 'o', secretMode: 'echo', secret: {} as never }),
    ).rejects.toThrow(ValidationError)
  })

  it('echo mode does not inherit managed mode\'s validateSecret: false — a weak secret is rejected', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'owner',
      secretMode: 'echo',
      secret: { prompt: 'x', echo: 'y', key: 'z' },
      validateSecret: true,
    })
    await expect(db.openVault('acme')).rejects.toThrow(WeakSecretError)
  }, T)

  it('the canonical Italian example succeeds under validateSecret: true (#952 Romance-friendly floor)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'owner',
      secretMode: 'echo',
      secret: CANONICAL_PARTS,
      validateSecret: true,
    })
    await expect(db.openVault('acme')).resolves.toBeDefined()
    db.close()
  }, T)

  it('echoSecretPolicy tightens the prompt floor at createNoydb', async () => {
    // PARTS.prompt ('sono chiamato vicio') is exactly 3 words — passes the
    // echo default floor but fails an explicit { minWords: 4 } override.
    await expect(
      createNoydb({
        store: inlineMemory(),
        user: 'o',
        secretMode: 'echo',
        secret: PARTS,
        validateSecret: true,
        echoSecretPolicy: { prompt: { minWords: 4 } },
      }).then((db) => db.openVault('acme')),
    ).rejects.toThrow(WeakSecretError)
  }, T)

  it('echoMaskHint lands in the keyring block and surfaces in the ceremony', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'o', secretMode: 'echo', secret: PARTS, echoMaskHint: 'first-letters' })
    await db.openVault('acme')
    const file = JSON.parse((await store.get('acme', '_keyring', 'o'))!._data) as KeyringFile
    expect(file.echo?.mask_hint).toBe('first-letters')
    const ceremony = await beginEchoUnlock(store, 'acme', { userId: 'o', prompt: PARTS.prompt })
    expect(ceremony.maskHint).toBe('first-letters')
    db.close()
  }, T)

  it('echoMaskHint outside echo mode is rejected', async () => {
    await expect(
      createNoydb({ store: inlineMemory(), user: 'o', secret: 'sei parole buone lunghe per policy', echoMaskHint: 'x' }),
    ).rejects.toThrow(ValidationError)
  })

  it('echoSecretPolicy outside echo mode is rejected', async () => {
    await expect(
      createNoydb({
        store: inlineMemory(),
        user: 'o',
        secret: 'sei parole buone lunghe per policy',
        echoSecretPolicy: { prompt: { minWords: 4 } },
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('secretMode: "echo" is mutually exclusive with sealingKey', async () => {
    const store = inlineMemory()
    await expect(
      createNoydb({
        store,
        user: 'o',
        secretMode: 'echo',
        secret: PARTS,
        sealingKey: new MemorySealer({ id: 'test:seal' }),
      }),
    ).rejects.toThrow(ValidationError)
  })
})
