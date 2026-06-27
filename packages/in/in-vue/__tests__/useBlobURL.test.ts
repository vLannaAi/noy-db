import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, ref, nextTick } from 'vue'
import {
  createNoydb,
  ConflictError,
  type Noydb,
  type NoydbStore,
  type EncryptedEnvelope,
  type VaultSnapshot,
} from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { useBlobURL } from '../src/useBlobURL.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(v: string, c: string) {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const b = bucket(v, c)
      const ex = b.get(id)
      if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0)
      b.set(id, env)
    },
    async delete(v, c, id) { bucket(v, c).delete(id) },
    async list(v, c) { return [...bucket(v, c).keys()] },
    async loadAll(v) {
      const comp = store.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const b = bucket(v, n)
        for (const [id, e] of Object.entries(recs)) b.set(id, e)
      }
    },
  }
}

interface Doc { id: string; title: string }

let createdUrls: string[]
let revokedUrls: string[]
let originalCreate: typeof URL.createObjectURL | undefined
let originalRevoke: typeof URL.revokeObjectURL | undefined

function installURLSpies(): void {
  createdUrls = []
  revokedUrls = []
  originalCreate = URL.createObjectURL
  originalRevoke = URL.revokeObjectURL
  let counter = 0
  URL.createObjectURL = ((blob: Blob) => {
    const u = `blob:test/${counter++}-${blob.size}`
    createdUrls.push(u)
    return u
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((u: string) => { revokedUrls.push(u) }) as typeof URL.revokeObjectURL
}

function restoreURLSpies(): void {
  if (originalCreate) URL.createObjectURL = originalCreate
  if (originalRevoke) URL.revokeObjectURL = originalRevoke
}

async function makeFixture(): Promise<{ db: Noydb; col: Awaited<ReturnType<Noydb['openVault']>> }> {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: 'use-blob-url-test-passphrase-2026',
    blobStrategy: withBlobs(),
  })
  const vault = await db.openVault('V1')
  const col = vault.collection<Doc>('docs')
  await col.put('rec-1', { id: 'rec-1', title: 'one' })
  await col.put('rec-2', { id: 'rec-2', title: 'two' })
  await col.blob('rec-1').put('default', new TextEncoder().encode('payload-1'), { mimeType: 'text/plain' })
  await col.blob('rec-2').put('default', new TextEncoder().encode('payload-2'), { mimeType: 'text/plain' })
  return { db, col: vault as unknown as Awaited<ReturnType<Noydb['openVault']>> }
}

describe('useBlobURL', () => {
  beforeEach(installURLSpies)
  afterEach(restoreURLSpies)

  it('1. populates url asynchronously and revokes on scope dispose', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'x'.repeat(32), blobStrategy: withBlobs() })
    const vault = await db.openVault('V1')
    const col = vault.collection<Doc>('docs')
    await col.put('rec-1', { id: 'rec-1', title: 'one' })
    await col.blob('rec-1').put('default', new TextEncoder().encode('payload'))

    const scope = effectScope()
    const url = scope.run(() => useBlobURL(col, () => 'rec-1'))!
    expect(url.value).toBeNull() // null until the async load resolves

    // Wait for the watch's immediate-load microtask + the async object URL build.
    await vi.waitFor(() => expect(url.value).toMatch(/^blob:test\//))
    expect(createdUrls).toHaveLength(1)
    expect(revokedUrls).toEqual([])

    scope.stop()
    expect(revokedUrls).toEqual([createdUrls[0]])
    expect(url.value).toBeNull()
    db.close()
  })

  it('2. revokes the prior URL before creating the new one when id changes', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'y'.repeat(32), blobStrategy: withBlobs() })
    const vault = await db.openVault('V1')
    const col = vault.collection<Doc>('docs')
    await col.put('rec-1', { id: 'rec-1', title: 'one' })
    await col.put('rec-2', { id: 'rec-2', title: 'two' })
    await col.blob('rec-1').put('default', new TextEncoder().encode('one'))
    await col.blob('rec-2').put('default', new TextEncoder().encode('two-longer-bytes'))

    const id = ref<string | null>('rec-1')
    const scope = effectScope()
    const url = scope.run(() => useBlobURL(col, () => id.value))!

    await vi.waitFor(() => expect(url.value).toMatch(/^blob:test\/0-/))
    const first = url.value
    expect(revokedUrls).toEqual([])

    id.value = 'rec-2'
    await nextTick()
    // Revoke fires synchronously before the next async build resolves.
    expect(revokedUrls).toEqual([first])
    await vi.waitFor(() => expect(url.value).toMatch(/^blob:test\/1-/))
    expect(url.value).not.toBe(first)

    scope.stop()
    expect(revokedUrls).toEqual([first, createdUrls[1]])
    db.close()
  })

  it('3. returns null when the slot does not exist', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'z'.repeat(32), blobStrategy: withBlobs() })
    const vault = await db.openVault('V1')
    const col = vault.collection<Doc>('docs')
    await col.put('rec-1', { id: 'rec-1', title: 'one' }) // no blob attached

    const scope = effectScope()
    const url = scope.run(() => useBlobURL(col, () => 'rec-1'))!
    await new Promise(r => setTimeout(r, 30))
    expect(url.value).toBeNull()
    expect(createdUrls).toEqual([])
    scope.stop()
    db.close()
  })

  it('4. clears url to null when the id getter returns null', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: '0'.repeat(32), blobStrategy: withBlobs() })
    const vault = await db.openVault('V1')
    const col = vault.collection<Doc>('docs')
    await col.put('rec-1', { id: 'rec-1', title: 'one' })
    await col.blob('rec-1').put('default', new TextEncoder().encode('p'))

    const id = ref<string | null>('rec-1')
    const scope = effectScope()
    const url = scope.run(() => useBlobURL(col, () => id.value))!
    await vi.waitFor(() => expect(url.value).not.toBeNull())
    const first = url.value

    id.value = null
    await nextTick()
    expect(url.value).toBeNull()
    expect(revokedUrls).toEqual([first])
    scope.stop()
    db.close()
  })

  it('5. SSR-safe: stays at null when URL.createObjectURL is unavailable', async () => {
    restoreURLSpies()
    const savedURL = (globalThis as { URL?: unknown }).URL
    // Hide URL on globalThis so the composable's feature-detect bails out.
    Object.defineProperty(globalThis, 'URL', { value: undefined, configurable: true })
    try {
      const db = await createNoydb({ store: memory(), user: 'a', secret: 's'.repeat(32), blobStrategy: withBlobs() })
      const vault = await db.openVault('V1')
      const col = vault.collection<Doc>('docs')
      await col.put('rec-1', { id: 'rec-1', title: 'one' })

      const scope = effectScope()
      const url = scope.run(() => useBlobURL(col, () => 'rec-1'))!
      await new Promise(r => setTimeout(r, 20))
      expect(url.value).toBeNull()
      scope.stop()
      db.close()
    } finally {
      Object.defineProperty(globalThis, 'URL', { value: savedURL, configurable: true })
      installURLSpies()
    }
  })

  it('6. mimeType resolver is called and forwarded to objectURL', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'm'.repeat(32), blobStrategy: withBlobs() })
    const vault = await db.openVault('V1')
    const col = vault.collection<Doc>('docs')
    await col.put('rec-1', { id: 'rec-1', title: 'one' })
    await col.blob('rec-1').put('default', new TextEncoder().encode('p'))

    let observedType = ''
    URL.createObjectURL = ((blob: Blob) => {
      observedType = blob.type
      const u = `blob:test/${createdUrls.length}-${blob.size}`
      createdUrls.push(u)
      return u
    }) as typeof URL.createObjectURL

    const scope = effectScope()
    scope.run(() => useBlobURL(col, () => 'rec-1', { mimeType: () => 'image/png' }))
    await vi.waitFor(() => expect(observedType).toBe('image/png'))
    scope.stop()
    db.close()
  })

  // suppress unused-fixture lint complaint — the helper covers a future expansion.
  void makeFixture
})
