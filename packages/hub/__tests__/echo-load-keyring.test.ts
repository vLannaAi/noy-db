import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, EchoCeremonyRequiredError, ValidationError } from '../src/kernel/errors.js'
import { createOwnerKeyring, loadKeyring, changeSecret } from '../src/with-party/team/keyring.js'
import { buildEchoBlock } from '../src/with-party/team/echo-secret.js'

// copied verbatim from packages/hub/__tests__/keyring.test.ts:17-42
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

const PARTS = { prompt: 'mi chiamo vicio', echo: 'da piccolo mi chiamavano', key: 'ciccio' }
const T = 240_000

describe('loadKeyring echo guards', () => {
  it('string secret against an echo keyring → EchoCeremonyRequiredError (before any KDF)', async () => {
    const store = inlineMemory()
    const owner = await createOwnerKeyring(store, 'v', { userId: 'o', secret: 'plain pass' })

    // graft an echo block marker onto the stored file (guard fires on presence alone)
    const env = await store.get('v', '_keyring', 'o')
    const file = JSON.parse(env!._data)
    file.echo = await buildEchoBlock(PARTS, { kind: 'none' })
    await store.put('v', '_keyring', 'o', { ...env!, _data: JSON.stringify(file) })

    await expect(loadKeyring(store, 'v', { userId: 'o', secret: 'plain pass' })).rejects.toThrow(
      EchoCeremonyRequiredError,
    )
    await expect(
      changeSecret(store, 'v', owner, { newSecret: 'other pass', allowWeakSecret: true }),
    ).rejects.toThrow(EchoCeremonyRequiredError)
  }, T)

  it('EchoSecretParts against a STANDARD keyring → ValidationError', async () => {
    const store = inlineMemory()
    await createOwnerKeyring(store, 'v', { userId: 'o', secret: 'plain pass' })
    await expect(loadKeyring(store, 'v', { userId: 'o', secret: PARTS })).rejects.toThrow(ValidationError)
  }, T)
})
