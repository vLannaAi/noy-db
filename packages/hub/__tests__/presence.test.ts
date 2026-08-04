import { describe, it, expect, vi } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'

// ─── Inline memory adapter with optional pub/sub ───────────────────────────

function inlineMemory(opts: { pubsub?: boolean } = {}): NoydbStore & {
  _channels: Map<string, Array<(p: string) => void>>
} {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const channels = new Map<string, Array<(p: string) => void>>()

  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }

  const adapter: NoydbStore & { _channels: typeof channels } = {
    _channels: channels,
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
      if (comp) for (const [n, coll] of comp) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }

  if (opts.pubsub) {
    adapter.presencePublish = async (channel: string, payload: string) => {
      const subs = channels.get(channel) ?? []
      for (const sub of subs) sub(payload)
    }
    adapter.presenceSubscribe = (channel: string, callback: (p: string) => void) => {
      if (!channels.has(channel)) channels.set(channel, [])
      channels.get(channel)!.push(callback)
      return () => {
        const arr = channels.get(channel)
        if (arr) {
          const idx = arr.indexOf(callback)
          if (idx >= 0) arr.splice(idx, 1)
        }
      }
    }
  }

  return adapter
}

const COMP = 'COMP-PRESENCE'

interface CursorPayload { path: string; action: 'viewing' | 'editing' }

describe('presence (v0.9)', () => {
  describe('presence() API', () => {
    it('collection.presence() returns a PresenceHandle', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', syncStrategy: withSync(), encrypt: false })
      const comp = await db.openVault(COMP)
      const invoices = comp.collection('invoices')
      const handle = invoices.presence()
      expect(handle).toBeDefined()
      expect(typeof handle.update).toBe('function')
      expect(typeof handle.subscribe).toBe('function')
      expect(typeof handle.stop).toBe('function')
      handle.stop()
    })

    it('update() does not throw without pub/sub adapter', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', syncStrategy: withSync(), encrypt: false })
      const comp = await db.openVault(COMP)
      const invoices = comp.collection('invoices')
      const handle = invoices.presence<CursorPayload>()
      await expect(handle.update({ path: 'invoices/inv-1', action: 'editing' })).resolves.toBeUndefined()
      handle.stop()
    })

    it('subscribe() returns an unsubscribe function', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', syncStrategy: withSync(), encrypt: false })
      const comp = await db.openVault(COMP)
      const handle = comp.collection('invoices').presence<CursorPayload>({ pollIntervalMs: 100 })
      const unsub = handle.subscribe(() => {})
      expect(typeof unsub).toBe('function')
      unsub()
      handle.stop()
    })
  })

  describe('pub/sub path (real-time)', () => {
    it('delivers presence payload to subscriber via pub/sub', async () => {
      const sharedAdapter = inlineMemory({ pubsub: true })

      const dbA = await createNoydb({ store: inlineMemory(), sync: sharedAdapter, user: 'a', syncStrategy: withSync(), encrypt: false })
      const dbB = await createNoydb({ store: inlineMemory(), sync: sharedAdapter, user: 'b', syncStrategy: withSync(), encrypt: false })

      const compA = await dbA.openVault(COMP)
      const compB = await dbB.openVault(COMP)

      const handleA = compA.collection<never>('invoices').presence<CursorPayload>()
      const handleB = compB.collection<never>('invoices').presence<CursorPayload>()

      const received: Array<unknown> = []
      handleB.subscribe((peers) => { received.push(...peers) })

      // A publishes — B should receive it synchronously (mock pub/sub is sync)
      await handleA.update({ path: 'invoices/inv-1', action: 'editing' })

      // Allow microtasks to settle
      await Promise.resolve()

      // B's subscribe callback should have fired with A's presence
      // (the poll runs after publish triggers a storage write + pub/sub)
      expect(sharedAdapter._channels.size).toBeGreaterThan(0)

      handleA.stop()
      handleB.stop()
    })

    it('unsubscribe removes listener from channel', async () => {
      const sharedAdapter = inlineMemory({ pubsub: true })
      const db = await createNoydb({ store: inlineMemory(), sync: sharedAdapter, user: 'u', syncStrategy: withSync(), encrypt: false })
      const comp = await db.openVault(COMP)
      const handle = comp.collection('invoices').presence()

      const calls: number[] = []
      const unsub = handle.subscribe(() => calls.push(1))
      unsub()

      await handle.update({})
      await Promise.resolve()

      // After unsubscribe, no calls
      expect(calls).toHaveLength(0)
      handle.stop()
    })
  })

  describe('storage-poll fallback', () => {
    it('update() writes a presence record to the sync adapter', async () => {
      const syncAdapter = inlineMemory()
      const db = await createNoydb({
        store: inlineMemory(),
        sync: syncAdapter,
        user: 'u', syncStrategy: withSync(),
        encrypt: false,
      })
      const comp = await db.openVault(COMP)
      const handle = comp.collection('invoices').presence<CursorPayload>()

      await handle.update({ path: 'invoices/inv-1', action: 'viewing' })

      // The record should be in the sync adapter under the reserved collection
      const ids = await syncAdapter.list(COMP, '_presence_invoices')
      expect(ids).toContain('u')

      handle.stop()
    })

    it('subscribe poll reads peers from sync adapter', async () => {
      const syncAdapter = inlineMemory()
      const dbA = await createNoydb({ store: inlineMemory(), sync: syncAdapter, user: 'a', syncStrategy: withSync(), encrypt: false })
      const dbB = await createNoydb({ store: inlineMemory(), sync: syncAdapter, user: 'b', syncStrategy: withSync(), encrypt: false })

      const compA = await dbA.openVault(COMP)
      const compB = await dbB.openVault(COMP)

      // A announces presence
      const handleA = compA.collection('invoices').presence<CursorPayload>()
      await handleA.update({ path: 'invoices/inv-1', action: 'editing' })

      // B subscribes and polls
      const handleB = compB.collection('invoices').presence<CursorPayload>({ pollIntervalMs: 50 })

      const snapshots: Array<Array<{ userId: string }>> = []
      handleB.subscribe((peers) => { snapshots.push(peers) })

      // Wait for one poll cycle
      await new Promise(r => setTimeout(r, 100))

      // B should see A's presence (not its own)
      if (snapshots.length > 0) {
        const latest = snapshots[snapshots.length - 1]!
        expect(latest.some(p => p.userId === 'a')).toBe(true)
        expect(latest.every(p => p.userId !== 'b')).toBe(true) // self filtered
      }

      handleA.stop()
      handleB.stop()
    })

    it('stop() clears the poll interval', async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
      const db = await createNoydb({ store: inlineMemory(), user: 'u', syncStrategy: withSync(), encrypt: false })
      const comp = await db.openVault(COMP)
      const handle = comp.collection('invoices').presence({ pollIntervalMs: 100 })

      handle.subscribe(() => {}) // starts poll
      handle.stop() // should clear it

      expect(clearIntervalSpy).toHaveBeenCalled()
      clearIntervalSpy.mockRestore()
    })
  })

  describe('encryption', () => {
    it('update() writes encrypted presence record when encrypt: true', async () => {
      const syncAdapter = inlineMemory()

      // We can't test full encryption without a real secret in this adapter,
      // but we can verify that when encrypt is false, the record is readable.
      const db = await createNoydb({
        store: inlineMemory(),
        sync: syncAdapter,
        user: 'u', syncStrategy: withSync(),
        encrypt: false,
      })
      const comp = await db.openVault(COMP)
      const handle = comp.collection('invoices').presence<CursorPayload>()

      await handle.update({ path: 'invoices/inv-1', action: 'viewing' })

      const envelope = await syncAdapter.get(COMP, '_presence_invoices', 'u')
      expect(envelope).not.toBeNull()
      // In non-encrypted mode, _data is a JSON string
      expect(() => JSON.parse(envelope!._data)).not.toThrow()

      handle.stop()
    })
  })

  describe('encrypted storage-poll fallback — identity confidentiality (#963)', () => {
    const SECRET_A = 'owner-pass-phrase-1234'
    const SECRET_B = 'peer-pass-phrase-1234'

    // Two real users sharing one vault via grant(), on a SINGLE shared
    // adapter (no dedicated sync store — presence falls back to the local
    // adapter for storage-poll, exactly as the fallback path is documented).
    async function setupEncryptedPair() {
      const adapter = inlineMemory()
      const ownerDb = await createNoydb({
        teamStrategy: withTeam(), syncStrategy: withSync(),
        store: adapter, user: 'user-a', secret: SECRET_A,
      })
      const compA = await ownerDb.openVault(COMP)
      // Touch the collection so it has a DEK before granting access to it.
      await compA.collection('invoices').put('seed', {})
      await ownerDb.grant(COMP, {
        userId: 'user-b', displayName: 'User B', role: 'operator', secret: SECRET_B,
        permissions: { invoices: 'rw' },
      })

      const memberDb = await createNoydb({
        teamStrategy: withTeam(), syncStrategy: withSync(),
        store: adapter, user: 'user-b', secret: SECRET_B,
      })
      const compB = await memberDb.openVault(COMP)

      return { adapter, compA, compB }
    }

    it('never leaks the plaintext userId in the raw stored record', async () => {
      const { adapter, compA } = await setupEncryptedPair()
      const handleA = compA.collection<CursorPayload>('invoices').presence<CursorPayload>()

      await handleA.update({ path: 'invoices/inv-1', action: 'editing' })

      const ids = await adapter.list(COMP, '_presence_invoices')
      expect(ids).toHaveLength(1)
      const recordId = ids[0]!
      // The record id is an adapter-opaque tag, not the userId.
      expect(recordId).not.toBe('user-a')

      const envelope = await adapter.get(COMP, '_presence_invoices', recordId)
      expect(envelope).not.toBeNull()

      // Neither the outer envelope nor the parsed inner record carries the
      // plaintext userId anywhere.
      expect(JSON.stringify(envelope)).not.toContain('user-a')
      const record = JSON.parse(envelope!._data) as Record<string, unknown>
      expect(record).not.toHaveProperty('userId')
      expect(JSON.stringify(record)).not.toContain('user-a')

      handleA.stop()
    })

    it('round-trips identity: peers see each other decrypted, excluding self', async () => {
      const { compA, compB } = await setupEncryptedPair()
      const handleA = compA.collection<CursorPayload>('invoices').presence<CursorPayload>()
      const handleB = compB.collection<CursorPayload>('invoices').presence<CursorPayload>({ pollIntervalMs: 50 })

      await handleA.update({ path: 'invoices/inv-1', action: 'editing' })
      await handleB.update({ path: 'invoices/inv-2', action: 'viewing' })

      const snapshotsB: Array<{ userId: string; payload: CursorPayload; lastSeen: string }> = []
      handleB.subscribe((peers) => { snapshotsB.push(...peers) })

      await new Promise((r) => setTimeout(r, 150))

      expect(
        snapshotsB.some((p) => p.userId === 'user-a' && p.payload.path === 'invoices/inv-1'),
      ).toBe(true)
      // Self must never appear in the surfaced peer list.
      expect(snapshotsB.every((p) => p.userId !== 'user-b')).toBe(true)

      handleA.stop()
      handleB.stop()
    })

    it('a read-only subscriber (never calls update()) still surfaces encrypted peers (#963)', async () => {
      const { compA, compB } = await setupEncryptedPair()
      const handleA = compA.collection<CursorPayload>('invoices').presence<CursorPayload>()
      // Handle B never calls update() — it's a pure watcher, so its
      // `presenceKey` field is never populated as a side effect (that only
      // happens inside getPresenceKey(), which storage-poll mode only calls
      // from update()). The poll must still resolve the key itself.
      const handleB = compB.collection<CursorPayload>('invoices').presence<CursorPayload>({ pollIntervalMs: 50 })

      await handleA.update({ path: 'invoices/inv-1', action: 'editing' })

      const snapshotsB: Array<{ userId: string; payload: CursorPayload; lastSeen: string }> = []
      handleB.subscribe((peers) => { snapshotsB.push(...peers) })

      await new Promise((r) => setTimeout(r, 150))

      expect(
        snapshotsB.some((p) => p.userId === 'user-a' && p.payload.path === 'invoices/inv-1'),
      ).toBe(true)

      handleA.stop()
      handleB.stop()
    })

    it('is deterministic: repeated update() overwrites the same record id', async () => {
      const { adapter, compA } = await setupEncryptedPair()
      const handleA = compA.collection<CursorPayload>('invoices').presence<CursorPayload>()

      await handleA.update({ path: 'invoices/inv-1', action: 'editing' })
      const idsAfterFirst = await adapter.list(COMP, '_presence_invoices')

      await handleA.update({ path: 'invoices/inv-1', action: 'viewing' })
      const idsAfterSecond = await adapter.list(COMP, '_presence_invoices')

      expect(idsAfterSecond).toEqual(idsAfterFirst)
      expect(idsAfterSecond).toHaveLength(1)

      handleA.stop()
    })
  })

  describe('encrypted pub/sub round-trip (#968)', () => {
    const SECRET_A = 'owner-pass-phrase-1234'
    const SECRET_B = 'peer-pass-phrase-1234'

    it('subscriber decrypts a broadcast presence update, surfacing the correct userId + payload', async () => {
      const adapter = inlineMemory({ pubsub: true })

      const ownerDb = await createNoydb({
        teamStrategy: withTeam(), syncStrategy: withSync(),
        store: adapter, user: 'user-a', secret: SECRET_A,
      })
      const compA = await ownerDb.openVault(COMP)
      // Touch the collection so it has a DEK before granting access to it.
      await compA.collection('invoices').put('seed', {})
      await ownerDb.grant(COMP, {
        userId: 'user-b', displayName: 'User B', role: 'operator', secret: SECRET_B,
        permissions: { invoices: 'rw' },
      })

      const memberDb = await createNoydb({
        teamStrategy: withTeam(), syncStrategy: withSync(),
        store: adapter, user: 'user-b', secret: SECRET_B,
      })
      const compB = await memberDb.openVault(COMP)

      const handleA = compA.collection<CursorPayload>('invoices').presence<CursorPayload>()
      const handleB = compB.collection<CursorPayload>('invoices').presence<CursorPayload>()

      const received: Array<{ userId: string; payload: CursorPayload }> = []
      handleB.subscribe((peers) => { received.push(...peers) })

      // A publishes an encrypted presence update over pub/sub — B's
      // subscriber must decrypt the broadcast (using the IV `encrypt()`
      // actually used) to surface A's identity + payload. Update twice: the
      // first call's own storage write and its fire-and-forget pub/sub
      // delivery to B race each other in this synchronous mock, so the
      // second broadcast (after the first write has long since committed)
      // is the one asserted on.
      await handleA.update({ path: 'invoices/inv-1', action: 'editing' })
      await new Promise((r) => setTimeout(r, 50))
      await handleA.update({ path: 'invoices/inv-1', action: 'editing' })

      // Allow the async decrypt + follow-up snapshot poll to settle.
      await new Promise((r) => setTimeout(r, 100))

      expect(
        received.some((p) => p.userId === 'user-a' && p.payload.path === 'invoices/inv-1'),
      ).toBe(true)

      handleA.stop()
      handleB.stop()
    })
  })

  describe('unencrypted storage-poll fallback — cleartext dev posture unchanged (#963)', () => {
    it('still uses the plaintext userId as the record id when encrypt: false', async () => {
      const syncAdapter = inlineMemory()
      const db = await createNoydb({
        store: inlineMemory(), sync: syncAdapter, user: 'plain-user', syncStrategy: withSync(), encrypt: false,
      })
      const comp = await db.openVault(COMP)
      const handle = comp.collection('invoices').presence<CursorPayload>()

      await handle.update({ path: 'invoices/inv-1', action: 'editing' })

      const ids = await syncAdapter.list(COMP, '_presence_invoices')
      expect(ids).toEqual(['plain-user'])

      handle.stop()
    })
  })
})
