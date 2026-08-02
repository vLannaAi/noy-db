/**
 * `beginEchoUnlock` ceremony API (spec
 * docs/superpowers/specs/2026-08-02-echo-secret-design.md, #940, Task 6).
 *
 * Covers the interactive prompt -> echo reveal -> key flow players run to
 * unlock an echo keyring, plus the degraded typed-echo path when the reveal
 * cannot be resolved (sealed reveal, foreign device).
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, WrongPromptError, WrongEchoError, InvalidKeyError, NoAccessError, ValidationError, KeyringExpiredError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/index.js'
import { beginEchoUnlock } from '../src/with-party/team/echo-ceremony.js'
import { createOwnerKeyring } from '../src/with-party/team/keyring.js'
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

const PARTS = { prompt: 'mi chiamo vicio', echo: 'da piccolo al mare mi chiamavano', key: 'ciccio patata' }
const T = 600_000

async function seedEchoVault(store: NoydbStore, deviceSeal?: MemoryDeviceSealProvider) {
  const db = await createNoydb({ store, user: 'owner', secretMode: 'echo', secret: PARTS, ...(deviceSeal ? { deviceSeal } : {}) })
  await db.openVault('acme')
}

describe('beginEchoUnlock', () => {
  it('portable: wrong prompt throws; right prompt reveals; complete(key) unlocks; wrong key fails', async () => {
    const store = inlineMemory()
    await seedEchoVault(store)
    await expect(beginEchoUnlock(store, 'acme', { userId: 'owner', prompt: 'prompt sbagliato' })).rejects.toThrow(WrongPromptError)
    const ceremony = await beginEchoUnlock(store, 'acme', { userId: 'owner', prompt: PARTS.prompt })
    expect(ceremony.reveal).toBe(PARTS.echo)
    await expect(ceremony.complete({ key: 'wrong key words' })).rejects.toThrow(InvalidKeyError)
    const keyring = await ceremony.complete({ key: PARTS.key })
    expect(keyring.userId).toBe('owner')
    expect(keyring.deks.size).toBeGreaterThan(0)
  }, T)

  it('sealed-without-provider: degraded typed-echo path; wrong typed echo throws', async () => {
    const store = inlineMemory()
    await seedEchoVault(store, new MemoryDeviceSealProvider({ id: 'enrolling-device' }))
    const ceremony = await beginEchoUnlock(store, 'acme', { userId: 'owner', prompt: PARTS.prompt })
    expect(ceremony.reveal).toBeNull() // foreign device: cannot unseal
    await expect(ceremony.complete({ echo: 'eco sbagliata', key: PARTS.key })).rejects.toThrow(WrongEchoError)
    const keyring = await ceremony.complete({ echo: PARTS.echo, key: PARTS.key })
    expect(keyring.userId).toBe('owner')
  }, T)

  it('reveal-present: mismatched typed echo throws WrongEchoError; matching typed echo unlocks', async () => {
    const store = inlineMemory()
    await seedEchoVault(store)
    const ceremony = await beginEchoUnlock(store, 'acme', { userId: 'owner', prompt: PARTS.prompt })
    expect(ceremony.reveal).toBe(PARTS.echo)
    await expect(ceremony.complete({ echo: 'eco sbagliata', key: PARTS.key })).rejects.toThrow(WrongEchoError)
    // A caller that supplies a typed echo AGREEING with the reveal must
    // still unlock — the mismatch guard only refuses disagreement.
    const keyring = await ceremony.complete({ echo: PARTS.echo, key: PARTS.key })
    expect(keyring.userId).toBe('owner')
  }, T)

  it('missing keyring row → NoAccessError', async () => {
    const store = inlineMemory()
    await expect(
      beginEchoUnlock(store, 'acme', { userId: 'nobody', prompt: PARTS.prompt }),
    ).rejects.toThrow(NoAccessError)
  }, T)

  it('keyring without an echo block → ValidationError', async () => {
    const store = inlineMemory()
    await createOwnerKeyring(store, 'acme', { userId: 'owner', secret: 'a plain string secret' })
    await expect(
      beginEchoUnlock(store, 'acme', { userId: 'owner', prompt: PARTS.prompt }),
    ).rejects.toThrow(ValidationError)
  }, T)

  it('degraded path with input.echo absent → ValidationError', async () => {
    const store = inlineMemory()
    await seedEchoVault(store, new MemoryDeviceSealProvider({ id: 'enrolling-device' }))
    const ceremony = await beginEchoUnlock(store, 'acme', { userId: 'owner', prompt: PARTS.prompt })
    expect(ceremony.reveal).toBeNull()
    await expect(ceremony.complete({ key: PARTS.key })).rejects.toThrow(ValidationError)
  }, T)

  it('an expired echo keyring refuses BEFORE the echo is revealed', async () => {
    const store = inlineMemory()
    await createOwnerKeyring(store, 'acme', { userId: 'owner', secret: PARTS })
    // Stamp an expiry in the past (same field loadKeyring gates on).
    const env = await store.get('acme', '_keyring', 'owner')
    const file = JSON.parse(env!._data) as Record<string, unknown>
    file.expires_at = new Date(Date.now() - 60_000).toISOString()
    await store.put('acme', '_keyring', 'owner', { ...env!, _data: JSON.stringify(file) })

    // Even with the CORRECT prompt, no ceremony handle (and so no reveal)
    // is produced — the expiry check precedes prompt verification.
    await expect(
      beginEchoUnlock(store, 'acme', { userId: 'owner', prompt: PARTS.prompt }),
    ).rejects.toThrow(KeyringExpiredError)
  }, T)

  it('maskHint round-trips from the built echo block onto the ceremony', async () => {
    const store = inlineMemory()
    await createOwnerKeyring(store, 'acme', { userId: 'owner', secret: PARTS, echoMaskHint: 'da piccolo...' })
    const ceremony = await beginEchoUnlock(store, 'acme', { userId: 'owner', prompt: PARTS.prompt })
    expect(ceremony.maskHint).toBe('da piccolo...')
  }, T)
})
