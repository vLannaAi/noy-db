// #1238 — the notify server-push frame, BESIDE the request frame.
import { describe, it, expect } from 'vitest'
import type { NoydbRelayStore, EncryptedEnvelope } from '@noy-db/hub/to'
import { createRelayHandler, createRelayNotifier, type RelayNotifyFrame } from '../src/index.js'

function relayStore(opts: { tx?: boolean } = {}): NoydbRelayStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  const store: NoydbRelayStore = {
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, e) { data.set(k(v, c, i), e) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) { const p = `${v}/${c}/`; return [...data.keys()].filter(x => x.startsWith(p)).map(x => x.slice(p.length)) },
    async loadAll() { return {} },
  }
  if (opts.tx) {
    store.tx = async (ops) => {
      for (const op of ops) {
        if (op.type === 'put') data.set(k(op.vault, op.collection, op.id), op.envelope!)
        else data.delete(k(op.vault, op.collection, op.id))
      }
    }
  }
  return store
}
const env = (ts: string) => ({ _data: 'x', _v: 1, _ts: ts } as unknown as EncryptedEnvelope)

describe('notify frame (#1238)', () => {
  it('a subscriber to a vault receives one frame per successful put and delete, carrying the ADDRESS, never the envelope', async () => {
    const notify = createRelayNotifier()
    const handle = createRelayHandler({ store: relayStore(), notify })
    const got: RelayNotifyFrame[] = []
    notify.subscribe('v', (f) => got.push(f))

    await handle({ id: '1', method: 'put', args: ['v', 'c', 'r1', env('2026-09-03T00:00:01.000Z')] })
    await handle({ id: '2', method: 'delete', args: ['v', 'c', 'r1'] })

    expect(got).toHaveLength(2)
    expect(got[0]).toEqual({ t: 'notify', seq: 1, vault: 'v', collection: 'c', id: 'r1', op: 'put', ts: '2026-09-03T00:00:01.000Z' })
    expect(got[1]).toMatchObject({ t: 'notify', seq: 2, vault: 'v', collection: 'c', id: 'r1', op: 'delete' })
    expect(typeof got[1]!.ts).toBe('string')
    for (const f of got) expect(f).not.toHaveProperty('envelope')
  })

  it('seq is per SUBSCRIPTION and contiguous from 1 — a gap is detectable by the client', async () => {
    const notify = createRelayNotifier()
    const handle = createRelayHandler({ store: relayStore(), notify })
    const a: number[] = []
    const b: number[] = []
    notify.subscribe('v', (f) => a.push(f.seq))
    await handle({ id: '1', method: 'put', args: ['v', 'c', 'r1', env('t1')] })
    notify.subscribe('v', (f) => b.push(f.seq))   // joins late
    await handle({ id: '2', method: 'put', args: ['v', 'c', 'r2', env('t2')] })
    expect(a).toEqual([1, 2])
    expect(b).toEqual([1])   // its own counter, not the server's history
  })

  it('a subscription is scoped to the vault it NAMED — no frame for another vault, ever', async () => {
    const notify = createRelayNotifier()
    const handle = createRelayHandler({ store: relayStore(), notify })
    const got: string[] = []
    notify.subscribe('mine', (f) => got.push(f.vault))
    await handle({ id: '1', method: 'put', args: ['theirs', 'c', 'r1', env('t')] })
    await handle({ id: '2', method: 'put', args: ['mine', 'c', 'r1', env('t')] })
    expect(got).toEqual(['mine'])
  })

  it('a FAILED mutation publishes nothing — the frame reports what landed', async () => {
    const notify = createRelayNotifier()
    const store = relayStore()
    store.put = async () => { throw new Error('disk full') }
    const handle = createRelayHandler({ store, notify })
    const got: RelayNotifyFrame[] = []
    notify.subscribe('v', (f) => got.push(f))
    expect(await handle({ id: '1', method: 'put', args: ['v', 'c', 'r1', env('t')] })).toMatchObject({ ok: false })
    expect(got).toEqual([])
  })

  it('a tx publishes one frame per op, after the whole batch committed', async () => {
    const notify = createRelayNotifier()
    const handle = createRelayHandler({ store: relayStore({ tx: true }), notify })
    const got: RelayNotifyFrame[] = []
    notify.subscribe('v', (f) => got.push(f))
    await handle({ id: '1', method: 'tx', args: [[
      { type: 'put', vault: 'v', collection: 'c', id: 'r1', envelope: env('t1') },
      { type: 'delete', vault: 'v', collection: 'c', id: 'r0' },
    ]] })
    expect(got.map((f) => [f.seq, f.op, f.id])).toEqual([[1, 'put', 'r1'], [2, 'delete', 'r0']])
  })

  it('reads publish nothing', async () => {
    const notify = createRelayNotifier()
    const handle = createRelayHandler({ store: relayStore(), notify })
    const got: RelayNotifyFrame[] = []
    notify.subscribe('v', (f) => got.push(f))
    await handle({ id: '1', method: 'get', args: ['v', 'c', 'r1'] })
    await handle({ id: '2', method: 'list', args: ['v', 'c'] })
    expect(got).toEqual([])
  })

  it('unsubscribe stops delivery; a throwing subscriber never breaks the write or its neighbours', async () => {
    const notify = createRelayNotifier()
    const handle = createRelayHandler({ store: relayStore(), notify })
    const got: number[] = []
    const off = notify.subscribe('v', () => { throw new Error('client gone') })
    notify.subscribe('v', (f) => got.push(f.seq))
    expect(await handle({ id: '1', method: 'put', args: ['v', 'c', 'r1', env('t')] })).toMatchObject({ ok: true })
    off()
    await handle({ id: '2', method: 'put', args: ['v', 'c', 'r2', env('t')] })
    expect(got).toEqual([1, 2])
  })

  it('a handler built without a notifier behaves exactly as before', async () => {
    const handle = createRelayHandler({ store: relayStore() })
    expect(await handle({ id: '1', method: 'put', args: ['v', 'c', 'r1', env('t')] })).toMatchObject({ ok: true })
  })
})
