/**
 * #1362 — cross-tab / cross-process live-query reactivity.
 *
 * Two "tabs" are two `Noydb` instances over ONE store, wired to one in-memory
 * bus standing in for a `BroadcastChannel`. The rows that matter:
 *   - a write in one tab re-fires a `.live()` query in the other
 *   - no channel available ⇒ identical behaviour to today (no throw, no re-fire)
 *   - the channel carries nothing resembling record content
 *   - a signal for an unrelated collection does NOT re-fire
 *   - no infinite echo — a tab never re-broadcasts a signal it received
 */
import { describe, expect, it } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { enableChangeBroadcast, defaultChangeChannel, changeChannelName, type ChangeSignal } from '../src/with-sync/change-broadcast.js'
import { toMemory } from '../../to-memory/src/index.js'
import type { TabChannel } from '../src/with-sync/tab-coordination.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../src/kernel/query/live/index.js'

/**
 * In-memory bus. `sent` records every payload EVERY endpoint posted, in order —
 * the content assertion reads it, so it must capture the bytes as posted, not a
 * parsed view of them.
 *
 * Delivery reaches every OTHER endpoint (what `BroadcastChannel` does), except
 * on a bus built with `echo: true`, which also delivers back to the sender —
 * the shape a host transport can have, and the one the origin check must
 * survive.
 */
function makeBus(n: number, echo = false): { chans: TabChannel[]; sent: string[] } {
  const listeners: Array<((p: string) => void) | null> = []
  const sent: string[] = []
  const chans: TabChannel[] = []
  for (let i = 0; i < n; i++) {
    const idx = i
    chans.push({
      isOpen: true,
      send(payload) {
        sent.push(payload)
        for (let j = 0; j < listeners.length; j++) {
          if ((echo || j !== idx) && listeners[j]) { const l = listeners[j]!; queueMicrotask(() => l(payload)) }
        }
      },
      on(event, l) { if (event === 'message') { listeners[idx] = l as (p: string) => void; return () => { listeners[idx] = null } } return () => {} },
      close() { listeners[idx] = null },
    })
  }
  return { chans, sent }
}

const waitFor = async (cond: () => boolean, timeoutMs = 2000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met within timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * ⚠️ Only sound for asserting ABSENCE — see tab-write-propagation.test.ts's
 * note. Too short a delay makes an absence row pass spuriously; keep it
 * generous.
 */
const settleForAbsence = async () => { await new Promise((r) => setTimeout(r, 50)) }

interface Inv extends Record<string, unknown> { id: string; amount: number; memo: string }
const SECRET = 'change-broadcast-pass-1234'

/**
 * Two tabs, one store. db1 writes FIRST so the per-collection DEK is minted and
 * persisted; db2 is created only after, so it loads the same keyring + DEK
 * (otherwise each tab mints its own and the cross-read fails as TamperedError).
 */
async function twoTabs() {
  const store = toMemory()
  const db1 = await createNoydb({ store, user: 'alice', secret: SECRET })
  const v1 = await db1.openVault('books')
  const c1 = v1.collection<Inv>('invoices')
  await c1.put('seed', { id: 'seed', amount: 0, memo: 'seed' })
  const db2 = await createNoydb({ store, user: 'alice', secret: SECRET })
  const v2 = await db2.openVault('books')
  const c2 = v2.collection<Inv>('invoices')
  await c2.get('seed') // hydrate db2's eager cache
  return { store, db1, db2, v1, v2, c1, c2 }
}

describe('#1362 cross-tab live queries', () => {
  it('a write in one tab re-fires a live query in the other', async () => {
    const { db1, db2, c1, c2 } = await twoTabs()
    const { chans } = makeBus(2)
    const s1 = enableChangeBroadcast(db1, { channel: chans[0]!, originId: 'A' })
    const s2 = enableChangeBroadcast(db2, { channel: chans[1]!, originId: 'B' })

    const live = c2.query().live()
    let fired = 0
    live.subscribe(() => { fired++ })
    expect(live.value).toHaveLength(1) // just the seed

    await c1.put('i1', { id: 'i1', amount: 7, memo: 'hello' })

    await waitFor(() => live.value.length === 2)
    expect(fired).toBeGreaterThan(0)
    // Re-read through db2's OWN keyring — the channel carried no plaintext.
    expect(live.value.map((r) => r.id).sort()).toEqual(['i1', 'seed'])
    expect(live.value.find((r) => r.id === 'i1')).toMatchObject({ amount: 7, memo: 'hello' })

    live.stop(); s1.dispose(); s2.dispose(); db1.close(); db2.close()
  })

  it('a delete in one tab re-fires the other, with the verb derived locally', async () => {
    const { db1, db2, c1, c2 } = await twoTabs()
    const { chans, sent } = makeBus(2)
    const s1 = enableChangeBroadcast(db1, { channel: chans[0]!, originId: 'A' })
    const s2 = enableChangeBroadcast(db2, { channel: chans[1]!, originId: 'B' })
    const live = c2.query().live()

    await c1.delete('seed')
    await waitFor(() => live.value.length === 0)

    // The frame never said "delete" — db2 read the address and found nothing.
    for (const p of sent) expect(JSON.parse(p)).not.toHaveProperty('action')

    live.stop(); s1.dispose(); s2.dispose(); db1.close(); db2.close()
  })

  it('the channel carries the ADDRESS only — nothing resembling record content', async () => {
    const { db1, db2, c1 } = await twoTabs()
    const { chans, sent } = makeBus(2)
    const s1 = enableChangeBroadcast(db1, { channel: chans[0]!, originId: 'A', now: () => 1234 })
    const s2 = enableChangeBroadcast(db2, { channel: chans[1]!, originId: 'B' })

    await c1.put('i1', { id: 'i1', amount: 424242, memo: 'sensitive-memo-text' })
    await waitFor(() => sent.length > 0)

    // The exact frame, field for field. This is the row that fails if a future
    // change starts putting record state on the wire — it is an equality, not a
    // subset match, so an ADDED field breaks it too.
    const frame = JSON.parse(sent[0]!) as ChangeSignal
    expect(frame).toEqual({
      kind: 'noydb:change',
      origin: 'A',
      vault: 'books',
      collection: 'invoices',
      id: 'i1',
      ts: 1234,
    })
    expect(Object.keys(frame).sort()).toEqual(['collection', 'id', 'kind', 'origin', 'ts', 'vault'])

    // And nothing content-shaped anywhere in the raw bytes of ANY frame: not the
    // field values, not the field names, not the verb, not ciphertext.
    for (const payload of sent) {
      for (const forbidden of ['sensitive-memo-text', 'memo', '424242', 'amount', 'action', 'put', 'delete', '_data', '_iv', '_cek']) {
        expect(payload).not.toContain(forbidden)
      }
    }

    s1.dispose(); s2.dispose(); db1.close(); db2.close()
  })

  it('a signal for an unrelated collection does not re-fire the live query', async () => {
    const { db1, db2, v1, c2 } = await twoTabs()
    const other1 = v1.collection<Inv>('receipts')
    await other1.put('r1', { id: 'r1', amount: 1, memo: 'r' })
    const { chans, sent } = makeBus(2)
    const s1 = enableChangeBroadcast(db1, { channel: chans[0]!, originId: 'A' })
    const s2 = enableChangeBroadcast(db2, { channel: chans[1]!, originId: 'B' })

    const live = c2.query().live()
    let fired = 0
    live.subscribe(() => { fired++ })

    await other1.put('r2', { id: 'r2', amount: 2, memo: 'r' })
    await waitFor(() => sent.length > 0)   // the signal WAS broadcast…
    await settleForAbsence()

    expect(JSON.parse(sent[0]!).collection).toBe('receipts')
    expect(fired).toBe(0)                  // …and the invoices live query ignored it
    expect(live.value).toHaveLength(1)

    live.stop(); s1.dispose(); s2.dispose(); db1.close(); db2.close()
  })

  it('no infinite echo: applying a peer signal never re-broadcasts it', async () => {
    const { db1, db2, c1 } = await twoTabs()
    const { chans, sent } = makeBus(2)
    const s1 = enableChangeBroadcast(db1, { channel: chans[0]!, originId: 'A' })
    const s2 = enableChangeBroadcast(db2, { channel: chans[1]!, originId: 'B' })

    await c1.put('i1', { id: 'i1', amount: 7, memo: 'x' })
    await settleForAbsence()

    // Exactly ONE frame ever exists: db1's. db2 applied it and stayed quiet.
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!).origin).toBe('A')

    s1.dispose(); s2.dispose(); db1.close(); db2.close()
  })

  it('an echoing transport is survived by the origin check', async () => {
    const { db1, db2, c1 } = await twoTabs()
    const { chans, sent } = makeBus(2, true) // delivers back to the sender too
    const s1 = enableChangeBroadcast(db1, { channel: chans[0]!, originId: 'A' })
    const s2 = enableChangeBroadcast(db2, { channel: chans[1]!, originId: 'B' })

    await c1.put('i1', { id: 'i1', amount: 7, memo: 'x' })
    await settleForAbsence()

    expect(sent).toHaveLength(1) // db1 ignored its own frame rather than re-reading + re-posting

    s1.dispose(); s2.dispose(); db1.close(); db2.close()
  })

  it('an unopened vault or collection is a no-op, not a throw', async () => {
    const { db1, db2 } = await twoTabs()
    await expect(db2._applyRemoteSignal('no-such-vault', 'invoices', 'x')).resolves.toBeUndefined()
    await expect(db2._applyRemoteSignal('books', 'no-such-collection', 'x')).resolves.toBeUndefined()
    db1.close(); db2.close()
  })
})

describe('#1362 a remote signal invalidates and re-reads — it never patches', () => {
  it('the ChangeEvent is tagged remote, and the query source hands the live query NO delta', async () => {
    const { db1, db2, c1, c2 } = await twoTabs()
    const { chans } = makeBus(2)
    const s1 = enableChangeBroadcast(db1, { channel: chans[0]!, originId: 'A' })
    const s2 = enableChangeBroadcast(db2, { channel: chans[1]!, originId: 'B' })

    const localEvents: boolean[] = []
    const remoteEvents: boolean[] = []
    db1.on('change', (e) => { localEvents.push(e.remote === true) })
    db2.on('change', (e) => { remoteEvents.push(e.remote === true) })

    // White-box: the very source object `.live()` subscribes to. What it hands
    // the callback IS the decision under test — `undefined` means "rebuild",
    // a `SourceChange` would mean "patch this delta".
    const localDeltas: Array<unknown> = []
    const remoteDeltas: Array<unknown> = []
    type Src = { subscribe(cb: (d?: unknown) => void): () => void }
    const src1 = (c1.query() as unknown as { source: Src }).source
    const src2 = (c2.query() as unknown as { source: Src }).source
    const un1 = src1.subscribe((d) => { localDeltas.push(d) })
    const un2 = src2.subscribe((d) => { remoteDeltas.push(d) })

    await c1.put('i1', { id: 'i1', amount: 7, memo: 'x' })
    await waitFor(() => remoteEvents.length > 0)

    expect(localEvents).toEqual([false])  // db1's own write is local
    expect(remoteEvents).toEqual([true])  // db2's is remote-origin
    expect(localDeltas).toEqual([{ id: 'i1', action: 'put' }]) // local: a trusted delta, patchable
    expect(remoteDeltas).toEqual([undefined])                  // remote: no delta — re-read and re-run

    un1(); un2(); s1.dispose(); s2.dispose(); db1.close(); db2.close()
  })

  it('a maintained live query stays correct across a remote change (rebuild, not patch)', async () => {
    const { db1, db2, c1, c2 } = await twoTabs()
    const { chans } = makeBus(2)
    const s1 = enableChangeBroadcast(db1, { channel: chans[0]!, originId: 'A' })
    const s2 = enableChangeBroadcast(db2, { channel: chans[1]!, originId: 'B' })

    // A plan the incremental maintainer accepts: no join, no filter closure,
    // no label ordering, no index-driven clause.
    const live = c2.query().where('amount', '>=', 5).orderBy('amount').live()
    expect(live.value).toHaveLength(0)

    await c1.put('a', { id: 'a', amount: 9, memo: 'x' })
    await waitFor(() => live.value.length === 1)
    await c1.put('b', { id: 'b', amount: 6, memo: 'x' })
    await waitFor(() => live.value.length === 2)
    expect(live.value.map((r) => r.id)).toEqual(['b', 'a']) // ordered, no drift

    await c1.put('a', { id: 'a', amount: 1, memo: 'x' })    // drops out of the range
    await waitFor(() => live.value.length === 1)
    expect(live.value.map((r) => r.id)).toEqual(['b'])

    live.stop(); s1.dispose(); s2.dispose(); db1.close(); db2.close()
  })
})

describe('#1362 no channel ⇒ no regression', () => {
  it('enabling with no BroadcastChannel is an inert no-op and in-process live still works', async () => {
    const g = globalThis as { BroadcastChannel?: unknown }
    const saved = g.BroadcastChannel
    delete g.BroadcastChannel
    try {
      expect(defaultChangeChannel(changeChannelName('memory'))).toBeUndefined()

      const store = toMemory()
      const db = await createNoydb({ store, user: 'alice', secret: SECRET })
      const c = (await db.openVault('books')).collection<Inv>('invoices')

      let stop: { dispose: () => void } | undefined
      expect(() => { stop = enableChangeBroadcast(db) }).not.toThrow()

      // Today's behaviour, unchanged: same-instance live queries still re-fire.
      // The `list()` is #1414's gate, not this test's subject: `.live()` on a
      // collection nothing has read yet now refuses rather than seeding itself
      // from an empty-by-absence snapshot.
      await c.list()
      const live = c.query().live()
      await c.put('i1', { id: 'i1', amount: 1, memo: 'x' })
      expect(live.value).toHaveLength(1)

      expect(() => stop!.dispose()).not.toThrow()
      live.stop(); db.close()
    } finally {
      if (saved === undefined) delete g.BroadcastChannel
      else g.BroadcastChannel = saved
    }
  })

  it('with no broadcast enabled at all, a peer write is invisible until the next read', async () => {
    const { db1, db2, c1, c2 } = await twoTabs()
    const live = c2.query().live()
    await c1.put('i1', { id: 'i1', amount: 7, memo: 'x' })
    await settleForAbsence()
    expect(live.value).toHaveLength(1) // still just the seed — the pre-#1362 world
    live.stop(); db1.close(); db2.close()
  })

  it('the default channel is named per store', () => {
    expect(changeChannelName('memory')).toBe('noydb:change:memory')
    expect(changeChannelName('invoices-2026')).toBe('noydb:change:invoices-2026')
  })
})
