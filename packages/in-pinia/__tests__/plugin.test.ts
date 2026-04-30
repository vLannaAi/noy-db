import { describe, it, expect, beforeEach } from 'vitest'
import { createApp } from 'vue'
import { createPinia, defineStore, setActivePinia, type Pinia } from 'pinia'
import { createNoydbPiniaPlugin } from '../src/plugin.js'
import { type NoydbStore, type EncryptedEnvelope, type VaultSnapshot, ConflictError } from '@noy-db/hub'

/**
 * Inline memory adapter — same pattern as the integration tests in
 * @noy-db/core. Kept here so the pinia package has zero workspace
 * dependency on @noy-db/memory at test time.
 */
function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface ClientsState {
  list: string[]
  selectedId: string | null
  total: number
}

/**
 * Create a Pinia instance, register the plugin, and mount it on a stub
 * Vue app. The app.use(pinia) call is REQUIRED — Pinia plugins only fire
 * when a Pinia instance is bound to a Vue app context, not just when
 * setActivePinia() is called. Without the app context, plugins are silently
 * skipped, which is the most common gotcha when testing Pinia plugins.
 */
function makePinia(adapter: NoydbStore = memory(), secret: () => string = () => 'plugin-test-passphrase-2026'): Pinia {
  const pinia = createPinia()
  pinia.use(createNoydbPiniaPlugin({ adapter, user: 'owner',
    secret,
  }))
  const app = createApp({ render: () => null })
  app.use(pinia)
  setActivePinia(pinia)
  return pinia
}

describe('createNoydbPiniaPlugin — augmentation path', () => {
  beforeEach(() => {
    // Each test gets its own Pinia instance to isolate plugin state.
    setActivePinia(createPinia())
  })

  it('1. installs without throwing on a Pinia instance', () => {
    expect(() => makePinia()).not.toThrow()
  })

  it('2. leaves stores without a `noydb:` option untouched', () => {
    makePinia()
    const usePlain = defineStore('plain', {
      state: () => ({ count: 0 }),
    })
    const store = usePlain()
    expect(store.count).toBe(0)
    expect(store.$noydbAugmented).toBe(false)
    expect(store.$noydbReady).toBeUndefined()
  })

  it('3. marks augmented stores with $noydbAugmented = true', () => {
    makePinia()
    const useClients = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'clients', persist: 'list' },
    })
    const store = useClients()
    expect(store.$noydbAugmented).toBe(true)
    expect(store.$noydbReady).toBeInstanceOf(Promise)
  })

  it('4. persists state changes encrypted via the adapter', async () => {
    const adapter = memory()
    makePinia(adapter)
    const useClients = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'clients', persist: 'list' },
    })
    const store = useClients()
    await store.$noydbReady

    store.list.push('alpha', 'bravo')
    await store.$noydbFlush?.()

    // The adapter received an encrypted envelope at __state__.
    const env = await adapter.get('C1', 'clients', '__state__')
    expect(env).not.toBeNull()
    expect(env?._iv).toBeTruthy()
    expect(env?._data).toBeTruthy()
    // _data is base64 ciphertext — must NOT contain plaintext key names.
    expect(env?._data).not.toContain('alpha')
    expect(env?._data).not.toContain('bravo')
  })

  it('5. rehydrates persisted state on a fresh store instance', async () => {
    const adapter = memory()

    // First Pinia instance: write some state.
    makePinia(adapter)
    const useClients1 = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'clients', persist: 'list' },
    })
    const s1 = useClients1()
    await s1.$noydbReady
    s1.list.push('charlie', 'delta')
    await s1.$noydbFlush?.()

    // Second Pinia instance pointed at the SAME adapter: should rehydrate.
    setActivePinia(createPinia())
    makePinia(adapter)
    const useClients2 = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'clients', persist: 'list' },
    })
    const s2 = useClients2()
    await s2.$noydbReady
    expect(s2.list).toEqual(['charlie', 'delta'])
    // Non-persisted keys retain their initial value.
    expect(s2.selectedId).toBeNull()
    expect(s2.total).toBe(0)
  })

  it('6. `persist: string` only mirrors that single key', async () => {
    const adapter = memory()
    makePinia(adapter)
    const useClients = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'clients', persist: 'list' },
    })
    const store = useClients()
    await store.$noydbReady
    store.$patch({ list: ['x'], selectedId: 'sel-1', total: 99 })
    await store.$noydbFlush?.()

    // Round-trip through a fresh store: only `list` should come back persisted.
    setActivePinia(createPinia())
    makePinia(adapter)
    const useClients2 = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'clients', persist: 'list' },
    })
    const s2 = useClients2()
    await s2.$noydbReady
    expect(s2.list).toEqual(['x'])
    expect(s2.selectedId).toBeNull() // not persisted
    expect(s2.total).toBe(0) // not persisted
  })

  it('7. `persist: string[]` mirrors multiple keys', async () => {
    const adapter = memory()
    makePinia(adapter)
    const useClients = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: {
        vault: 'C1',
        collection: 'clients',
        persist: ['list', 'total'],
      },
    })
    const store = useClients()
    await store.$noydbReady
    store.$patch({ list: ['y'], selectedId: 'ignored', total: 42 })
    await store.$noydbFlush?.()

    setActivePinia(createPinia())
    makePinia(adapter)
    const useClients2 = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: {
        vault: 'C1',
        collection: 'clients',
        persist: ['list', 'total'],
      },
    })
    const s2 = useClients2()
    await s2.$noydbReady
    expect(s2.list).toEqual(['y'])
    expect(s2.total).toBe(42)
    expect(s2.selectedId).toBeNull() // not in persist list
  })

  it('8. `persist: "*"` mirrors the entire state object', async () => {
    const adapter = memory()
    makePinia(adapter)
    const useClients = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'clients', persist: '*' },
    })
    const store = useClients()
    await store.$noydbReady
    store.$patch({ list: ['z'], selectedId: 'sel', total: 7 })
    await store.$noydbFlush?.()

    setActivePinia(createPinia())
    makePinia(adapter)
    const useClients2 = defineStore('clients', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'clients', persist: '*' },
    })
    const s2 = useClients2()
    await s2.$noydbReady
    expect(s2.list).toEqual(['z'])
    expect(s2.selectedId).toBe('sel')
    expect(s2.total).toBe(7)
  })

  it('9. secret function is called only once across multiple stores', async () => {
    const adapter = memory()
    let secretCalls = 0
    const pinia = createPinia()
    pinia.use(createNoydbPiniaPlugin({ adapter, user: 'owner',
      secret: () => {
        secretCalls++
        return 'shared-secret-2026'
      },
    }))
    const app = createApp({ render: () => null })
    app.use(pinia)
    setActivePinia(pinia)

    const useA = defineStore('a', {
      state: () => ({ x: 0 }),
      noydb: { vault: 'C1', collection: 'a', persist: 'x' },
    })
    const useB = defineStore('b', {
      state: () => ({ y: 0 }),
      noydb: { vault: 'C1', collection: 'b', persist: 'y' },
    })

    const a = useA()
    const b = useB()
    await Promise.all([a.$noydbReady, b.$noydbReady])

    expect(secretCalls).toBe(1)
  })

  it('10. two stores in two compartments do not bleed', async () => {
    const adapter = memory()
    makePinia(adapter)
    const useA = defineStore('a', {
      state: () => ({ list: [] as string[] }),
      noydb: { vault: 'C1', collection: 'data', persist: 'list' },
    })
    const useB = defineStore('b', {
      state: () => ({ list: [] as string[] }),
      noydb: { vault: 'C2', collection: 'data', persist: 'list' },
    })

    const a = useA()
    const b = useB()
    await Promise.all([a.$noydbReady, b.$noydbReady])

    a.list.push('alpha')
    b.list.push('bravo')
    await Promise.all([a.$noydbFlush?.(), b.$noydbFlush?.()])

    expect(a.list).toEqual(['alpha'])
    expect(b.list).toEqual(['bravo'])

    // Verify on disk: each vault has its own state doc.
    const envA = await adapter.get('C1', 'data', '__state__')
    const envB = await adapter.get('C2', 'data', '__state__')
    expect(envA).not.toBeNull()
    expect(envB).not.toBeNull()
    expect(envA?._iv).not.toBe(envB?._iv) // different random IVs
  })

  it('11. defaults to persisting the entire state when persist is omitted', async () => {
    const adapter = memory()
    makePinia(adapter)
    const useStore = defineStore('full', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'full' }, // no persist key
    })
    const store = useStore()
    await store.$noydbReady
    store.$patch({ list: ['a'], selectedId: 'b', total: 1 })
    await store.$noydbFlush?.()

    setActivePinia(createPinia())
    makePinia(adapter)
    const useStore2 = defineStore('full', {
      state: (): ClientsState => ({ list: [], selectedId: null, total: 0 }),
      noydb: { vault: 'C1', collection: 'full' },
    })
    const s2 = useStore2()
    await s2.$noydbReady
    expect(s2.list).toEqual(['a'])
    expect(s2.selectedId).toBe('b')
    expect(s2.total).toBe(1)
  })

  it('12. schema validation rejects invalid persisted documents', async () => {
    const adapter = memory()

    // First write something valid via the plugin.
    makePinia(adapter)
    const useV1 = defineStore('v', {
      state: () => ({ value: 'ok' }),
      noydb: { vault: 'C1', collection: 'v', persist: 'value' },
    })
    const s1 = useV1()
    await s1.$noydbReady
    s1.value = 'corrupted'
    await s1.$noydbFlush?.()

    // Now mount a fresh store with a strict schema that REJECTS the
    // persisted shape — it should land an error on $noydbError and
    // leave the store at its initial state.
    setActivePinia(createPinia())
    makePinia(adapter)
    const strictSchema = {
      parse(input: unknown): unknown {
        const obj = input as { value: string }
        if (obj.value !== 'ok') throw new Error('schema: value must be "ok"')
        return obj
      },
    }
    const useV2 = defineStore('v', {
      state: () => ({ value: 'initial' }),
      noydb: {
        vault: 'C1',
        collection: 'v',
        persist: 'value',
        schema: strictSchema,
      },
    })
    const s2 = useV2()
    await s2.$noydbReady
    expect(s2.$noydbError).toBeInstanceOf(Error)
    expect(s2.$noydbError?.message).toMatch(/schema: value must be "ok"/)
    expect(s2.value).toBe('initial') // unchanged
  })

  it('13. plugin is a no-op when zero stores declare `noydb:`', () => {
    // No augmented stores are instantiated; the secret callback should
    // never be invoked because the plugin lazy-creates Noydb on first use.
    let secretCalls = 0
    const pinia = createPinia()
    pinia.use(createNoydbPiniaPlugin({
      adapter: memory(),
      user: 'owner',
      secret: () => {
        secretCalls++
        return 'unused'
      },
    }))
    const app = createApp({ render: () => null })
    app.use(pinia)
    setActivePinia(pinia)

    const usePlain = defineStore('plain', { state: () => ({ x: 0 }) })
    const store = usePlain()
    store.x = 5
    expect(secretCalls).toBe(0)
    expect(store.x).toBe(5)
  })

  it('14. surfaces hydration errors via $noydbError without throwing', async () => {
    // Adapter that throws on get() to simulate corrupted storage.
    const brokenAdapter: NoydbStore = {
      ...memory(),
      name: 'broken',
      async get() {
        throw new Error('simulated read failure')
      },
    }
    makePinia(brokenAdapter)
    const useStore = defineStore('s', {
      state: () => ({ x: 'initial' }),
      noydb: { vault: 'C1', collection: 's', persist: 'x' },
    })
    const store = useStore()
    await store.$noydbReady
    expect(store.$noydbError).toBeInstanceOf(Error)
    expect(store.$noydbError?.message).toMatch(/simulated read failure/)
    expect(store.x).toBe('initial')
  })

  it('15. supports complex nested state shapes via persist: "*"', async () => {
    const adapter = memory()
    interface Complex {
      tree: { branches: Array<{ id: number; label: string }> }
      meta: { version: number }
    }
    makePinia(adapter)
    const useTree = defineStore('tree', {
      state: (): Complex => ({
        tree: { branches: [] },
        meta: { version: 1 },
      }),
      noydb: { vault: 'C1', collection: 'tree', persist: '*' },
    })
    const store = useTree()
    await store.$noydbReady
    store.$patch({
      tree: { branches: [{ id: 1, label: 'root' }, { id: 2, label: 'leaf' }] },
      meta: { version: 2 },
    })
    await store.$noydbFlush?.()

    setActivePinia(createPinia())
    makePinia(adapter)
    const useTree2 = defineStore('tree', {
      state: (): Complex => ({
        tree: { branches: [] },
        meta: { version: 1 },
      }),
      noydb: { vault: 'C1', collection: 'tree', persist: '*' },
    })
    const s2 = useTree2()
    await s2.$noydbReady
    expect(s2.tree.branches).toHaveLength(2)
    expect(s2.tree.branches[0]?.label).toBe('root')
    expect(s2.meta.version).toBe(2)
  })
})
