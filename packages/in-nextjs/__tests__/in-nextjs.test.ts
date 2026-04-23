import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { Noydb } from '@noy-db/hub'
import {
  cookieSession,
  configureNoydb,
  getNoydb,
  getVault,
  withVault,
  withNoydb,
  writeSession,
  clearSession,
  resetNoydbConfig,
  type NextCookieJar,
  type NoydbFactory,
} from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

// ─── Mock Next's cookies() API ─────────────────────────────────────────

function mockJar(): NextCookieJar & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get(name) { const value = store.get(name); return value !== undefined ? { name, value } : undefined },
    set(name, value) { store.set(name, value) },
    delete(name) { store.delete(name) },
  }
}

// ─── Test fixtures ─────────────────────────────────────────────────────

async function setup(): Promise<{ factory: NoydbFactory; jar: ReturnType<typeof mockJar> }> {
  const adapter = memory()
  const jar = mockJar()
  const factory: NoydbFactory = async () => {
    return createNoydb({ store: adapter, user: 'owner', secret: 'pw' })
  }
  return { factory, jar }
}

describe('cookieSession', () => {
  it('returns null when cookies are absent', async () => {
    const jar = mockJar()
    const session = cookieSession({ cookies: () => jar })
    expect(await session.read()).toBeNull()
  })

  it('round-trips userId + sessionToken', async () => {
    const jar = mockJar()
    const session = cookieSession({ cookies: () => jar })
    await session.write({ userId: 'alice', sessionToken: 'tok-xyz' })
    expect(await session.read()).toEqual({ userId: 'alice', sessionToken: 'tok-xyz' })
  })

  it('clear wipes both cookies', async () => {
    const jar = mockJar()
    const session = cookieSession({ cookies: () => jar })
    await session.write({ userId: 'alice', sessionToken: 'tok' })
    await session.clear()
    expect(await session.read()).toBeNull()
  })

  it('custom cookie names are honoured', async () => {
    const jar = mockJar()
    const session = cookieSession({
      cookies: () => jar,
      cookieName: 'my-sess',
      userCookieName: 'my-user',
    })
    await session.write({ userId: 'alice', sessionToken: 'tok' })
    expect(jar.store.get('my-sess')).toBe('tok')
    expect(jar.store.get('my-user')).toBe('alice')
  })
})

describe('configureNoydb / getNoydb', () => {
  beforeEach(() => resetNoydbConfig())

  it('getNoydb throws before configure', async () => {
    await expect(getNoydb()).rejects.toThrow(/configureNoydb/)
  })

  it('getNoydb returns the factory output once configured', async () => {
    const { factory, jar } = await setup()
    configureNoydb({ factory, session: cookieSession({ cookies: () => jar }) })
    const db = await getNoydb()
    expect(db).toBeDefined()
    await db.close()
  })

  it('factory receives the current session', async () => {
    const { jar } = await setup()
    let sessionSeen: { userId: string; sessionToken: string } | null = null
    const adapter = memory()
    const factory: NoydbFactory = async (s) => {
      sessionSeen = s
      return createNoydb({ store: adapter, user: 'owner', secret: 'pw' })
    }
    const session = cookieSession({ cookies: () => jar })
    await session.write({ userId: 'alice', sessionToken: 'tok' })
    configureNoydb({ factory, session })
    await getNoydb().then(d => d.close())
    expect(sessionSeen).toEqual({ userId: 'alice', sessionToken: 'tok' })
  })
})

describe('getVault', () => {
  beforeEach(() => resetNoydbConfig())

  it('opens a vault by name', async () => {
    const { factory, jar } = await setup()
    configureNoydb({ factory, session: cookieSession({ cookies: () => jar }) })
    const db = await getNoydb()
    const vault = await getVault(db, 'acme')
    expect(vault.name).toBe('acme')
    await db.close()
  })
})

describe('withVault / withNoydb', () => {
  beforeEach(() => resetNoydbConfig())

  it('withVault opens + passes vault + closes', async () => {
    const { factory, jar } = await setup()
    configureNoydb({ factory, session: cookieSession({ cookies: () => jar }) })
    const handler = withVault('acme', async (vault: import('@noy-db/hub').Vault) => {
      const coll = vault.collection<{ id: string }>('greetings')
      await coll.put('g1', { id: 'g1' })
      return (await coll.list()).length
    })
    const count = await handler(new Request('http://localhost/'))
    expect(count).toBe(1)
  })

  it('withNoydb gives raw Noydb access', async () => {
    const { factory, jar } = await setup()
    configureNoydb({ factory, session: cookieSession({ cookies: () => jar }) })
    const handler = withNoydb(async (db: Noydb) => {
      const vault = await db.openVault('acme')
      return vault.name
    })
    const result = await handler(new Request('http://localhost/'))
    expect(result).toBe('acme')
  })
})

describe('session actions', () => {
  beforeEach(() => resetNoydbConfig())

  it('writeSession / clearSession flow', async () => {
    const { factory, jar } = await setup()
    configureNoydb({ factory, session: cookieSession({ cookies: () => jar }) })
    await writeSession({ userId: 'bob', sessionToken: 'tok-bob' })
    expect(jar.store.get('noydb_session')).toBe('tok-bob')
    expect(jar.store.get('noydb_user')).toBe('bob')
    await clearSession()
    expect(jar.store.get('noydb_session')).toBeUndefined()
  })
})
