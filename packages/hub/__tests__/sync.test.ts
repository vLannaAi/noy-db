import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, PushResult, PullResult, Conflict } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { withSync } from '../src/sync/index.js'
import type { Noydb } from '../src/noydb.js'
import { withSync } from '../src/sync/index.js'

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

interface Invoice { amount: number; status: string }

describe('sync engine', () => {
  const COMP = 'C101'

  describe('two-instance sync (unencrypted)', () => {
    let localA: NoydbStore
    let localB: NoydbStore
    let remote: NoydbStore
    let dbA: Noydb
    let dbB: Noydb

    beforeEach(async () => {
      localA = inlineMemory()
      localB = inlineMemory()
      remote = inlineMemory()

      dbA = await createNoydb({ store: localA, sync: remote, user: 'user-a', syncStrategy: withSync(), encrypt: false })
      dbB = await createNoydb({ store: localB, sync: remote, user: 'user-b', syncStrategy: withSync(), encrypt: false })
    })

    it('A writes, pushes; B pulls, sees the record', async () => {
      const compA = await dbA.openVault(COMP)
      await compA.collection<Invoice>('invoices').put('inv-001', { amount: 5000, status: 'draft' })

      const pushResult = await dbA.push(COMP)
      expect(pushResult.pushed).toBe(1)
      expect(pushResult.conflicts).toHaveLength(0)

      await dbB.openVault(COMP) // must open to initialize sync engine
      const pullResult = await dbB.pull(COMP)
      expect(pullResult.pulled).toBe(1)

      const env = await localB.get(COMP, 'invoices', 'inv-001')
      expect(env).not.toBeNull()
    })

    it('A writes multiple records, pushes; B pulls all', async () => {
      const compA = await dbA.openVault(COMP)
      const invoices = compA.collection<Invoice>('invoices')
      await invoices.put('inv-001', { amount: 1000, status: 'a' })
      await invoices.put('inv-002', { amount: 2000, status: 'b' })
      await invoices.put('inv-003', { amount: 3000, status: 'c' })

      const pushResult = await dbA.push(COMP)
      expect(pushResult.pushed).toBe(3)

      await dbB.openVault(COMP)
      const pullResult = await dbB.pull(COMP)
      expect(pullResult.pulled).toBe(3)
    })

    it('A and B write different records; both push+pull; both see all', async () => {
      const compA = await dbA.openVault(COMP)
      await compA.collection<Invoice>('invoices').put('inv-A', { amount: 100, status: 'from-a' })

      const compB = await dbB.openVault(COMP)
      await compB.collection<Invoice>('invoices').put('inv-B', { amount: 200, status: 'from-b' })

      await dbA.push(COMP)
      await dbB.push(COMP)
      await dbA.pull(COMP)
      await dbB.pull(COMP)

      expect(await localA.get(COMP, 'invoices', 'inv-B')).not.toBeNull()
      expect(await localB.get(COMP, 'invoices', 'inv-A')).not.toBeNull()
    })

    it('delete syncs correctly', async () => {
      const compA = await dbA.openVault(COMP)
      const invoices = compA.collection<Invoice>('invoices')
      await invoices.put('inv-del', { amount: 999, status: 'delete-me' })
      await dbA.push(COMP)

      // B pulls the record
      await dbB.openVault(COMP)
      await dbB.pull(COMP)
      expect(await localB.get(COMP, 'invoices', 'inv-del')).not.toBeNull()

      // A deletes and pushes
      await invoices.delete('inv-del')
      await dbA.push(COMP)

      // Verify remote is clean
      expect(await remote.get(COMP, 'invoices', 'inv-del')).toBeNull()
    })

    it('dirty tracking accumulates and clears after push', async () => {
      const compA = await dbA.openVault(COMP)
      const invoices = compA.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'x' })
      await invoices.put('inv-2', { amount: 200, status: 'y' })

      expect(dbA.syncStatus(COMP).dirty).toBe(2)

      await dbA.push(COMP)

      expect(dbA.syncStatus(COMP).dirty).toBe(0)
      expect(dbA.syncStatus(COMP).lastPush).not.toBeNull()
    })

    it('sync() does pull then push', async () => {
      const compA = await dbA.openVault(COMP)
      await compA.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'x' })

      const result = await dbA.sync(COMP)
      expect(result.push.pushed).toBe(1)
      expect(result.pull.pulled).toBe(0) // nothing to pull initially
    })

    it('emits sync events', async () => {
      const events: string[] = []
      dbA.on('sync:push', () => events.push('push'))
      dbA.on('sync:pull', () => events.push('pull'))

      const compA = await dbA.openVault(COMP)
      await compA.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'x' })

      await dbA.push(COMP)
      await dbA.pull(COMP)

      expect(events).toEqual(['push', 'pull'])
    })

    it('syncStatus returns correct state when no sync configured', async () => {
      const noSyncDb = await createNoydb({ store: inlineMemory(), user: 'u', syncStrategy: withSync(), encrypt: false })
      const status = noSyncDb.syncStatus('any')
      expect(status.dirty).toBe(0)
      expect(status.online).toBe(true)
    })

    it('push without sync adapter throws', async () => {
      const noSyncDb = await createNoydb({ store: inlineMemory(), user: 'u', syncStrategy: withSync(), encrypt: false })
      await expect(noSyncDb.push('any')).rejects.toThrow('No sync adapter')
    })
  })

  describe('conflict strategies', () => {
    it('version strategy: higher version wins', async () => {
      const localAdapter = inlineMemory()
      const remoteAdapter = inlineMemory()

      // Seed local with v2 and remote with v3 (same record, no writes on local after open)
      const remoteEnv: EncryptedEnvelope = { _noydb: 1, _v: 3, _ts: '2026-01-03', _iv: '', _data: '{"amount":999,"status":"remote"}' }
      await remoteAdapter.put(COMP, 'invoices', 'inv-1', remoteEnv)

      const localEnv: EncryptedEnvelope = { _noydb: 1, _v: 2, _ts: '2026-01-01', _iv: '', _data: '{"amount":100,"status":"local"}' }
      await localAdapter.put(COMP, 'invoices', 'inv-1', localEnv)

      const db = await createNoydb({
        store: localAdapter, sync: remoteAdapter, user: 'u', syncStrategy: withSync(), encrypt: false,
        conflict: 'version',
      })
      await db.openVault(COMP)

      // Pull remote v3 into local v2: version-wins picks the higher version (remote)
      await db.pull(COMP)
      const after = await localAdapter.get(COMP, 'invoices', 'inv-1')
      expect(after).not.toBeNull()
      expect(after!._v).toBe(3)
      expect(after!._data).toContain('"status":"remote"')
      db.close()
    })

    it('local-wins strategy resolves conflicts', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({
        store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false,
        conflict: 'local-wins',
      })

      // Write to both local and remote with same ID
      const comp = await db.openVault(COMP)
      await comp.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'local' })

      // Manually put a conflicting version on remote
      await remote.put(COMP, 'invoices', 'inv-1', {
        _noydb: 1, _v: 5, _ts: '2026-01-01', _iv: '', _data: '{"amount":999,"status":"remote"}',
      })

      // Pull should detect conflict; local-wins keeps the local version
      await db.pull(COMP)
      const stored = await local.get(COMP, 'invoices', 'inv-1')
      expect(stored).not.toBeNull()
      // The local data must be our version, not the remote override
      expect(stored!._data).toContain('"status":"local"')
      expect(stored!._data).not.toContain('"status":"remote"')
    })

    it('remote-wins strategy resolves conflicts', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({
        store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false,
        conflict: 'remote-wins',
      })

      const comp = await db.openVault(COMP)
      await comp.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'local' })

      // Put conflicting version on remote
      await remote.put(COMP, 'invoices', 'inv-1', {
        _noydb: 1, _v: 5, _ts: '2026-01-01', _iv: '', _data: '{"amount":999,"status":"remote"}',
      })

      const result = await db.pull(COMP)
      // remote-wins should update local with remote version
      const localEnv = await local.get(COMP, 'invoices', 'inv-1')
      expect(localEnv?._v).toBe(5)
    })

    it('custom strategy function is called', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()
      const conflictsSeen: Conflict[] = []

      const db = await createNoydb({
        store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false,
        conflict: (conflict) => {
          conflictsSeen.push(conflict)
          return 'remote'
        },
      })

      const comp = await db.openVault(COMP)
      await comp.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'local' })

      await remote.put(COMP, 'invoices', 'inv-1', {
        _noydb: 1, _v: 5, _ts: '2026-01-01', _iv: '', _data: '{"amount":999,"status":"remote"}',
      })

      await db.pull(COMP)
      expect(conflictsSeen.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('encrypted ciphertext integrity through push/pull', () => {
    it('push preserves _iv and _data byte-for-byte — sync does not re-serialise ciphertext', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()
      const db = await createNoydb({ store: local, sync: remote, user: 'alice', syncStrategy: withSync(), secret: 'hunter2' })
      const vault = await db.openVault(COMP)

      await vault.collection<Invoice>('invoices').put('inv-001', { amount: 5000, status: 'paid' })

      // Capture the envelope as-written to local (real AES-256-GCM ciphertext)
      const localEnv = await local.get(COMP, 'invoices', 'inv-001')
      expect(localEnv).not.toBeNull()
      // _iv must be non-empty (a real 12-byte IV, base64-encoded)
      expect(localEnv!._iv.length).toBeGreaterThan(0)
      // _data must not be parseable as plain JSON (it's ciphertext)
      expect(() => JSON.parse(localEnv!._data)).toThrow()

      await db.push(COMP)

      // Remote must have the exact same envelope bytes — push must not transform ciphertext
      const remoteEnv = await remote.get(COMP, 'invoices', 'inv-001')
      expect(remoteEnv).not.toBeNull()
      expect(remoteEnv!._iv).toBe(localEnv!._iv)
      expect(remoteEnv!._data).toBe(localEnv!._data)

      db.close()
    })
  })
})
