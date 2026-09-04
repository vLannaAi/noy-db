/**
 * #1420 — a plain `collection.put()` that is IN FLIGHT ACROSS a transaction's
 * commit pre-flight is silently dropped (or silently overwrites the
 * transaction), with no error on either side.
 *
 * The window is narrower than "a put during a transaction". If the put is
 * fully AWAITED before the body returns, the pre-flight re-reads the record,
 * sees the new version and correctly throws `ConflictError` — that is the
 * `control` case below, and it must keep working. The defect is a put whose
 * store write straddles the pre-flight read:
 *
 *   variant (a) — the put lands AFTER the pre-flight read, BEFORE the replay.
 *                 The pre-flight's snapshot is already stale, so the
 *                 transaction overwrites the put. Two writes, both "ok".
 *   variant (b) — the put's store write is in flight when the commit starts
 *                 and lands AFTER the transaction's own write, clobbering it
 *                 from a stale base. Two writes, one version bump.
 *
 * Both must be covered on BOTH commit paths — `canCommitAtomically` picks
 * between them from the store's declared capabilities, so a store that
 * declares `txAtomic` takes the atomic path and one that does not takes the
 * per-op replay. `to-browser-idb` (the reporter's store) is the latter; a
 * `to-memory` with `tx`/`txAtomic` stripped reproduces it without pulling in
 * fake-indexeddb.
 *
 * ## The invariant these tests assert
 *
 * Not "which writer wins" — either outcome is defensible — but that **no
 * write both resolves ok and vanishes**. Every writer whose promise resolved
 * must be visible in the final record, and at least one writer must refuse
 * loudly when both cannot be.
 */
import { describe, it, expect } from 'vitest'
import { toMemory } from '../../../to-memory/src/index.js'
import { createNoydb, isConflictError } from '../../src/index.js'
import { withTransactions } from '../../src/with-commit/tx/index.js'
import type { NoydbStore } from '../../src/index.js'

interface Rec { a: string; b: string }

const KEY = { vault: 'acme', collection: 'recs', id: 'r1' }

/**
 * The gate a test uses to pin a store call open.
 *
 * ⚠️ `deadlineMs` is load-bearing, not belt-and-braces. The fix drains
 * in-flight writes on the touched keys BEFORE the pre-flight reads, so a gate
 * that only the pre-flight can release would deadlock the fixed code against
 * its own remedy. The deadline turns the pin into a bounded delay: on the
 * unfixed code the gate is released long before it expires (so the
 * interleaving is exact), and on the fixed code the drain simply waits it out.
 */
function gate(deadlineMs = 50): { wait: () => Promise<void>; release: () => void } {
  let release!: () => void
  const opened = new Promise<void>(r => { release = r })
  return {
    release,
    wait: () => Promise.race([opened, new Promise<void>(r => { setTimeout(r, deadlineMs) })]),
  }
}

interface Hooks {
  /** Runs after the inner `get` resolved, before its value is handed back. */
  afterGet?: (id: string) => Promise<void>
  /** Runs before the inner `put` is issued. */
  beforePut?: (id: string) => Promise<void>
}

/**
 * `to-memory` plus call hooks, optionally with `tx()`/`txAtomic` stripped so
 * `canCommitAtomically` falls back to the per-op replay path.
 */
function instrumented(hooks: Hooks, atomic: boolean): NoydbStore {
  const inner = toMemory()
  const wrapped: NoydbStore = {
    ...inner,
    async get(v, c, id) {
      const env = await inner.get(v, c, id)
      if (hooks.afterGet) await hooks.afterGet(id)
      return env
    },
    async put(v, c, id, env, expectedVersion) {
      if (hooks.beforePut) await hooks.beforePut(id)
      return inner.put(v, c, id, env, expectedVersion)
    },
  }
  if (!atomic) {
    delete wrapped.tx
    wrapped.capabilities = { ...inner.capabilities!, txAtomic: false }
  }
  return wrapped
}

async function seeded(store: NoydbStore) {
  const db = await createNoydb({
    store, user: 'owner', encrypt: false, transactionsStrategy: withTransactions(),
  })
  await db.openVault(KEY.vault)
  const coll = db.vault(KEY.vault).collection<Rec>(KEY.collection)
  await coll.put(KEY.id, { a: 'seed', b: 'seed' })
  return { db, coll }
}

/** Settle a promise into `'ok'` or the error it rejected with. */
async function settle(p: Promise<unknown>): Promise<'ok' | unknown> {
  try { await p; return 'ok' } catch (err) { return err }
}

/**
 * The shared assertion: every writer that resolved ok is visible in the final
 * record, and when both cannot be, one of them refused with `ConflictError`.
 */
function assertNoSilentLoss(
  putResult: 'ok' | unknown,
  txResult: 'ok' | unknown,
  final: Rec | null,
) {
  expect(final).not.toBeNull()
  const refused = [putResult, txResult].filter(r => r !== 'ok')
  expect(
    refused.length,
    `both writers reported success but the record is ${JSON.stringify(final)} — one write vanished`,
  ).toBeGreaterThan(0)
  // `isConflictError`, not `instanceof`: the atomic path's refusal is minted
  // by the STORE (`to-memory` binds the built `@noy-db/hub/to`, this suite
  // binds `src/`), so the class identities differ — #935's exact trap.
  for (const r of refused) expect(isConflictError(r), `expected a ConflictError, got ${String(r)}`).toBe(true)
  if (putResult === 'ok') expect(final!.b).toBe('plain')
  if (txResult === 'ok') expect(final!.a).toBe('tx')
}

for (const atomic of [true, false]) {
  const path = atomic ? 'atomic commit path (store declares txAtomic)' : 'per-op replay path (no tx()/txAtomic)'

  describe(`#1420 lost update — ${path}`, () => {
    it('control: a put fully awaited before the body returns is seen by the pre-flight', async () => {
      const hooks: Hooks = {}
      const { db, coll } = await seeded(instrumented(hooks, atomic))

      const txResult = await settle(db.transaction(async (tx) => {
        // Awaited INSIDE the body: by the time the body returns the write is
        // durable, so the pre-flight re-read sees v2 against expectedVersion 1.
        await coll.put(KEY.id, { a: 'seed', b: 'plain' })
        tx.vault(KEY.vault).collection<Rec>(KEY.collection)
          .put(KEY.id, { a: 'tx', b: 'seed' }, { expectedVersion: 1 })
      }))

      expect(isConflictError(txResult)).toBe(true)
      assertNoSilentLoss('ok', txResult, await coll.get(KEY.id))
    })

    it('variant (a): a put landing between the pre-flight read and the replay', async () => {
      const hooks: Hooks = {}
      const { db, coll } = await seeded(instrumented(hooks, atomic))

      // Armed only AFTER seeding — the seed put and the hydration reads would
      // otherwise consume the one-shot pins and the interleaving would silently
      // become a different (already-correct) scenario.
      const putGate = gate()
      let pinPut = true
      let armed = false
      let putP!: Promise<void>
      hooks.beforePut = async (id) => {
        if (id === KEY.id && pinPut) { pinPut = false; await putGate.wait() }
      }
      hooks.afterGet = async (id) => {
        // The pre-flight has already captured v1. Let the pinned put land now:
        // the transaction's snapshot is stale from here on.
        if (id === KEY.id && armed) { armed = false; putGate.release(); await settle(putP) }
      }

      putP = coll.put(KEY.id, { a: 'seed', b: 'plain' })
      armed = true
      const txResult = await settle(db.transaction(async (tx) => {
        tx.vault(KEY.vault).collection<Rec>(KEY.collection)
          .put(KEY.id, { a: 'tx', b: 'seed' }, { expectedVersion: 1 })
      }))
      putGate.release()
      const putResult = await settle(putP)

      assertNoSilentLoss(putResult, txResult, await coll.get(KEY.id))
    })

    it('variant (b): a put whose store write is in flight when the commit starts', async () => {
      const hooks: Hooks = {}
      const { db, coll } = await seeded(instrumented(hooks, atomic))

      const putGate = gate()
      let pinPut = true
      hooks.beforePut = async (id) => {
        if (id === KEY.id && pinPut) { pinPut = false; await putGate.wait() }
      }

      const putP = coll.put(KEY.id, { a: 'seed', b: 'plain' })
      const txResult = await settle(db.transaction(async (tx) => {
        tx.vault(KEY.vault).collection<Rec>(KEY.collection)
          .put(KEY.id, { a: 'tx', b: 'seed' }, { expectedVersion: 1 })
      }))
      putGate.release()
      const putResult = await settle(putP)

      assertNoSilentLoss(putResult, txResult, await coll.get(KEY.id))
    })
  })
}
