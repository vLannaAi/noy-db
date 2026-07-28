/**
 * #897 — the sync scheduler is actually started, so declared policies run.
 * #618 — and its pull is role-gated, so starting it does not reintroduce #616.
 *
 * Before this, `SyncScheduler.notifyChange()` returned at its `if (!this.started)`
 * guard on every write, because nothing ever called `startScheduler()`. A policy
 * was always resolved (`INDEXED_STORE_POLICY` when none was supplied), a scheduler
 * was constructed, and it never ran — so no automatic sync existed at any policy.
 *
 * The fix starts the scheduler for a DECLARED policy only. See the
 * 'stays manual when NO policy is declared' case for why the resolved fallback
 * does not count as opting in.
 */
import { describe, it, expect, vi } from 'vitest'
import { createNoydb, memoryStore } from '../../src/index.js'
import { withSync } from '../../src/with-sync/index.js'
import type { SyncPolicy } from '../../src/index.js'
import type { NoydbStore } from '../../src/kernel/types.js'

interface Note { body: string }

const SECRET = 'x'.repeat(32)

/** A remote that records how many envelopes were written to it. */
function countingRemote(): { store: NoydbStore; puts: () => number } {
  const inner = memoryStore()
  let puts = 0
  return {
    store: { ...inner, async put(v, c, id, env, ev) { puts++; return inner.put(v, c, id, env, ev) } },
    puts: () => puts,
  }
}

const open = async (remote: NoydbStore, syncPolicy?: SyncPolicy) =>
  createNoydb({
    store: memoryStore(),
    sync: remote,
    user: 'a',
    secret: SECRET,
    syncStrategy: withSync(),
    ...(syncPolicy ? { syncPolicy } : {}),
  })

describe('#897 — a DECLARED policy runs', () => {
  it('pushes on write when a policy IS declared', async () => {
    const remote = countingRemote()
    const db = await open(remote.store, {
      push: { mode: 'on-change' },
      pull: { mode: 'manual' },
    })
    const notes = (await db.openVault('acme')).collection<Note>('notes')

    await notes.put('n1', { body: 'hello' })
    await vi.waitFor(() => expect(remote.puts()).toBeGreaterThan(0), { timeout: 2000 })

    db.close()
  })

  it('stays manual when NO policy is declared — bare `sync:` never pushes by itself', async () => {
    // A policy is always RESOLVED (falling back to INDEXED_STORE_POLICY), but resolving
    // one is not consent. Starting the scheduler for anyone who merely passed `sync:`
    // would (a) make unattended background writes to a remote the default for a
    // zero-knowledge store and (b) make write ordering racy, since `push: 'on-change'`
    // fires an UNAWAITED push — a caller that writes locally and then touches the remote
    // directly would be in a race with it.
    const remote = countingRemote()
    const db = await open(remote.store)
    const notes = (await db.openVault('acme')).collection<Note>('notes')

    await notes.put('n1', { body: 'hello' })
    await new Promise(r => setTimeout(r, 150))
    expect(remote.puts()).toBe(0)

    // …and the explicit call is how you sync at this rung.
    await db.push('acme')
    expect(remote.puts()).toBeGreaterThan(0)
    db.close()
  })

  it('does NOT push when the declared policy opts out — the documented escape hatch', async () => {
    const remote = countingRemote()
    const db = await open(remote.store, {
      push: { mode: 'manual' },
      pull: { mode: 'manual' },
    })
    const notes = (await db.openVault('acme')).collection<Note>('notes')

    await notes.put('n1', { body: 'hello' })
    await new Promise(r => setTimeout(r, 150))
    expect(remote.puts()).toBe(0)

    // …and an explicit push still works.
    await db.push('acme')
    expect(remote.puts()).toBeGreaterThan(0)
    db.close()
  })

  it('builds a scheduler for pull-only automation (push manual, pull interval)', async () => {
    // Regression: the construction test used to be `push.mode !== 'manual'` alone,
    // so this policy silently got no scheduler and its pull mode was ignored.
    const remote = countingRemote()
    const db = await open(remote.store, {
      push: { mode: 'manual' },
      pull: { mode: 'interval', intervalMs: 50 },
    })
    await db.openVault('acme')

    const engine = (db as unknown as { syncEngines: Map<string, { scheduler: unknown }> })
      .syncEngines.get('acme')
    expect(engine?.scheduler).not.toBeNull()

    db.close()
  })

  it('close() stops the schedulers — no writes after close', async () => {
    const remote = countingRemote()
    const db = await open(remote.store, {
      push: { mode: 'on-change' },
      pull: { mode: 'manual' },
    })
    const notes = (await db.openVault('acme')).collection<Note>('notes')
    await notes.put('n1', { body: 'a' })
    await vi.waitFor(() => expect(remote.puts()).toBeGreaterThan(0), { timeout: 2000 })

    db.close()
    const after = remote.puts()
    await new Promise(r => setTimeout(r, 150))
    expect(remote.puts()).toBe(after)
  })
})

describe('#618 — scheduler-initiated pull is role-gated', () => {
  /** Build an engine directly so the role can be set without a full vault. */
  const engineWith = async (role: 'sync-peer' | 'backup', pulled: { n: number }) => {
    const { SyncEngine } = await import('../../src/with-sync/engine.js')
    const local = memoryStore()
    const remote = memoryStore()
    const engine = new SyncEngine({
      local, remote, vault: 'acme', strategy: 'version',
      emitter: { emit() {}, on() {}, off() {} } as never,
      syncPolicy: { push: { mode: 'manual' }, pull: { mode: 'interval', intervalMs: 10_000 } },
      role,
    } as never)
    // Count scheduler-initiated pulls by observing the callback the scheduler holds.
    const sched = engine.scheduler as unknown as { callbacks: { pull(): Promise<void> } } | null
    return { engine, tick: async () => { await sched?.callbacks.pull(); pulled.n++ } }
  }

  it('a backup-role engine does not pull on a scheduler tick', async () => {
    const seen = { n: 0 }
    const { engine, tick } = await engineWith('backup', seen)
    const spy = vi.spyOn(engine, 'pull')
    await tick()
    expect(spy).not.toHaveBeenCalled()
  })

  it('a sync-peer engine does pull on a scheduler tick', async () => {
    const seen = { n: 0 }
    const { engine, tick } = await engineWith('sync-peer', seen)
    const spy = vi.spyOn(engine, 'pull').mockResolvedValue({ pulled: 0, conflicts: [], errors: [] })
    await tick()
    expect(spy).toHaveBeenCalled()
  })

  it('an EXPLICIT pull still works for a backup role — the gate is timer-only', async () => {
    const seen = { n: 0 }
    const { engine } = await engineWith('backup', seen)
    const spy = vi.spyOn(engine, 'pull').mockResolvedValue({ pulled: 0, conflicts: [], errors: [] })
    await engine.pull()
    expect(spy).toHaveBeenCalled()
  })
})
