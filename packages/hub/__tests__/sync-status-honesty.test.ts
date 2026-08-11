/**
 * #1036 — `lastPush` / `lastPull` advanced even when the operation wholly failed.
 *
 * `push()` collects per-record failures into `PushResult.errors` rather than
 * throwing, then stamped the clock unconditionally. Against an unreachable store
 * that produced `{ dirty: 1, lastPush: <now>, lastPull: <now>, online: true }` —
 * three of four fields describing a healthy sync that never happened. A UI reads
 * "Last synced: just now" while nothing is reaching the remote.
 *
 * The fields now mean *last SUCCESSFUL*, and a failure is recorded in
 * `lastError` (cleared by the next success), so polling `syncStatus()` can tell
 * "never synced" from "synced an hour ago, failing since".
 *
 * Note `online` is deliberately untouched: it reflects the browser's global
 * connectivity events, not target reachability (#1034).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import type { NoydbStore, EncryptedEnvelope, PushResult, PullResult } from '../src/kernel/types.js'

type ProbeStore = NoydbStore & { fail: (on: boolean) => void }

/** A memory store whose reachability can be toggled mid-test. */
function toMemory(): ProbeStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  let failing = false
  const guard = () => { if (failing) throw new Error('store unreachable') }
  return {
    fail: (on: boolean) => { failing = on },
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { guard(); return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { guard(); data.set(k(v, c, i), env) },
    async delete(v, c, i) { guard(); data.delete(k(v, c, i)) },
    async list(v, c) {
      guard()
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      guard()
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vn, cn, id] = key.split('/')
        if (vn === v && cn !== undefined && id !== undefined) {
          out[cn] = out[cn] ?? {}
          out[cn]![id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      guard()
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
      }
    },
  }
}

const SECRET = 'sync-status-honesty-1036'

async function open() {
  const remote = toMemory()
  const db = await createNoydb({
    store: toMemory(), user: 'u', secret: SECRET, validateSecret: false,
    syncStrategy: withSync(),
    sync: { store: remote, role: 'sync-peer', label: 'peer' },
  })
  const vault = await db.openVault('v')
  return { db, vault, remote }
}

describe('#1036 — sync status reports success, not attempts', () => {
  it('a wholly failed push does NOT advance lastPush', async () => {
    const { db, vault, remote } = await open()
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    remote.fail(true)

    const result = await db.push('v')

    expect(result.pushed).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(db.syncStatus('v').lastPush).toBeNull()
    expect(db.syncStatus('v').dirty).toBe(1)
  })

  it('a successful push advances lastPush', async () => {
    const { db, vault } = await open()
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })

    await db.push('v')

    expect(db.syncStatus('v').lastPush).not.toBeNull()
    expect(db.syncStatus('v').dirty).toBe(0)
  })

  it('a failure after a success RETAINS the last successful timestamp', async () => {
    // The distinction that matters to a UI: "synced 10 minutes ago, failing
    // since" must not be rendered as "synced just now".
    const { db, vault, remote } = await open()
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    await db.push('v')
    const good = db.syncStatus('v').lastPush
    expect(good).not.toBeNull()

    remote.fail(true)
    await vault.collection('t').put('r2', { id: 'r2', n: 2 })
    await db.push('v')

    expect(db.syncStatus('v').lastPush).toBe(good)
  })

  it('a wholly failed pull does NOT advance lastPull', async () => {
    const { db, remote } = await open()
    remote.fail(true)

    const result = await db.pull('v')

    expect(result.errors.length).toBeGreaterThan(0)
    expect(db.syncStatus('v').lastPull).toBeNull()
  })

  it('lastError records the failure, naming the operation', async () => {
    const { db, vault, remote } = await open()
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    remote.fail(true)

    await db.push('v')

    const err = db.syncStatus('v').lastError
    expect(err).toBeDefined()
    expect(err!.op).toBe('push')
    expect(err!.message).toMatch(/unreachable/)
    expect(typeof err!.at).toBe('string')
  })

  it('lastError is absent before anything has failed, and cleared by a later success', async () => {
    const { db, vault, remote } = await open()
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    expect(db.syncStatus('v').lastError).toBeUndefined()

    remote.fail(true)
    await db.push('v')
    expect(db.syncStatus('v').lastError).toBeDefined()

    remote.fail(false)
    await db.push('v')
    expect(db.syncStatus('v').lastError).toBeUndefined()
  })

  it('"never synced" stays distinguishable from "failing now"', async () => {
    // Both leave lastPush null; only lastError separates them.
    const fresh = await open()
    expect(fresh.db.syncStatus('v').lastPush).toBeNull()
    expect(fresh.db.syncStatus('v').lastError).toBeUndefined()

    const broken = await open()
    await broken.vault.collection('t').put('r1', { id: 'r1', n: 1 })
    broken.remote.fail(true)
    await broken.db.push('v')
    expect(broken.db.syncStatus('v').lastPush).toBeNull()
    expect(broken.db.syncStatus('v').lastError).toBeDefined()
  })

  it('the sync:push / sync:pull events still carry the errors', async () => {
    // This is the push-based channel a scheduler-driven consumer listens on —
    // the scheduler discards the returned result, so the event is what it has.
    const { db, vault, remote } = await open()
    const pushes: PushResult[] = []
    const pulls: PullResult[] = []
    db.on('sync:push', r => pushes.push(r))
    db.on('sync:pull', r => pulls.push(r))

    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    remote.fail(true)
    await db.sync('v')

    expect(pushes.at(-1)!.errors.length).toBeGreaterThan(0)
    expect(pulls.at(-1)!.errors.length).toBeGreaterThan(0)
  })

  it('a no-op push over an empty dirty log still counts as success', async () => {
    // Nothing to send is not a failure — lastPush must advance, or a quiet
    // vault would look permanently unsynced.
    const { db } = await open()

    await db.push('v')

    expect(db.syncStatus('v').lastPush).not.toBeNull()
    expect(db.syncStatus('v').lastError).toBeUndefined()
  })
})
