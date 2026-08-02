import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import {
  validateEchoSecret,
  assertStrongEchoSecret,
  WeakSecretError,
} from '../src/kernel/validation.js'
import { EchoCeremonyRequiredError, WrongPromptError, WrongEchoError, ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { MemoryDeviceSealProvider } from '../src/with-party/team/device-seal.js'

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

// NOTE: the brief's literal fixture ('mi chiamo vicio' / 'da piccolo mi
// chiamavano sempre') contains 2-letter Italian words ("mi", "da") that
// violate the pre-existing DEFAULT_MIN_WORD_LENGTH = 3 floor in
// validation.ts (unrelated to this task's new echo code) — swapped for
// words meeting that floor while keeping the same 3+5+2=10 word split.
const GOOD = { prompt: 'sono chiamato vicio', echo: 'quando ero piccolo tutti chiamavano', key: 'ciccio patata' }

describe('validateEchoSecret', () => {
  it('accepts a strong 3-part secret', () => {
    expect(validateEchoSecret(GOOD)).toEqual({ ok: true, words: 10 })
  })
  it('rejects a prompt below its dedicated floor (default 3 words)', () => {
    const r = validateEchoSecret({ ...GOOD, prompt: 'mi chiamo' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('too-few-words')
  })
  it('rejects an empty part regardless of combined length', () => {
    const r = validateEchoSecret({ ...GOOD, echo: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty')
  })
  it('applies the existing whole-secret policy to the combined parts', () => {
    // 3+1+1 = 5 words total, under the default 6-word combined floor
    const r = validateEchoSecret({ prompt: 'uno due tre', echo: 'quattro', key: 'cinque' })
    expect(r.ok).toBe(false)
  })
  it('assertStrongEchoSecret throws WeakSecretError / respects allowWeakSecret', () => {
    expect(() => assertStrongEchoSecret({ prompt: 'x', echo: 'y', key: 'z' })).toThrow(WeakSecretError)
    expect(() =>
      assertStrongEchoSecret({ prompt: 'x', echo: 'y', key: 'z' }, { allowWeakSecret: true }),
    ).not.toThrow()
  })
})

describe('echo error classes', () => {
  it('carry stable codes and names', () => {
    expect(new EchoCeremonyRequiredError().code).toBe('ECHO_CEREMONY_REQUIRED')
    expect(new WrongPromptError().code).toBe('WRONG_PROMPT')
    expect(new WrongEchoError().code).toBe('WRONG_ECHO')
    expect(new EchoCeremonyRequiredError().name).toBe('EchoCeremonyRequiredError')
  })
})

describe('MemoryDeviceSealProvider', () => {
  it('round-trips and throws on tamper', async () => {
    const p = new MemoryDeviceSealProvider({ id: 'test:mem' })
    const sealed = await p.seal(new TextEncoder().encode('the echo'))
    expect(new TextDecoder().decode(await p.unseal(sealed))).toBe('the echo')
    const tampered = sealed.slice()
    tampered[tampered.length - 1]! ^= 0xff
    await expect(p.unseal(tampered)).rejects.toThrow()
  })
})

describe('secretMode: echo is wired through createNoydb', () => {
  // Supersedes the temporary "echo hard-fails before real wiring lands"
  // guard: the Critical it protected against was an `EchoSecretParts` object
  // reaching `TextEncoder` (silently coerced to "[object Object]", deriving
  // the same guessable KEK for every such vault). That is now structurally
  // impossible — `deriveKekForKeyring` dispatches on the secret's shape and
  // `createNoydb` rejects a shape/mode mismatch. Full coverage of the open →
  // write → reopen path lives in __tests__/echo-e2e.test.ts.
  it('openVault with echo parts succeeds and enrolls an echo keyring', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secretMode: 'echo', secret: GOOD })
    await expect(db.openVault('acme')).resolves.toBeDefined()
    const file = JSON.parse((await store.get('acme', '_keyring', 'alice'))!._data)
    expect(file.echo).toBeDefined()
    db.close()
  }, 600_000)

  it('a single string still cannot unlock that keyring (AG-1)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secretMode: 'echo', secret: GOOD })
    await db.openVault('acme')
    db.close()
    const asString = await createNoydb({ store, user: 'alice', secret: `${GOOD.prompt} ${GOOD.echo} ${GOOD.key}` })
    await expect(asString.openVault('acme')).rejects.toThrow(EchoCeremonyRequiredError)
    asString.close()
  }, 600_000)
})
