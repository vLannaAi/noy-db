/**
 * #1420 — the in-flight-write gate.
 *
 * ## The defect this closes
 *
 * `runTransaction`'s commit opens with a **pre-flight**: it re-reads every
 * touched envelope and enforces the caller's `expectedVersion`. That check is
 * only as honest as the read, and the read could not see a plain
 * `Collection.put()` that had *started* but not yet reached the store. Such a
 * put is invisible to the pre-flight, so:
 *
 *   - it lands after the pre-flight and the transaction overwrites it from a
 *     stale snapshot (both writers report success, one write vanishes); or
 *   - it lands after the transaction's own write and clobbers it from a stale
 *     base (two writes, one version bump).
 *
 * Neither raised an error on either side, and the loss was **store-capability
 * dependent** — `to-memory` declares `txAtomic` and takes the atomic commit
 * path, `to-browser-idb` does not and takes the per-op replay — so an app
 * tested on a memory store could ship lossy on IndexedDB.
 *
 * ## The remedy: make the pre-flight's read honest
 *
 * Every logical `Collection.put()` / `.delete()` registers itself here for the
 * span of its read-modify-write, keyed by `(vault, collection, id)`. A commit
 * **drains** the writes already in flight on the keys it is about to touch,
 * BEFORE its pre-flight reads. The in-flight case then behaves exactly like
 * the fully-awaited one the pre-flight already handled correctly: the read
 * sees the new version and a mismatched `expectedVersion` refuses with
 * `ConflictError`. No silent loss, and no new refusal for writes that were
 * never in conflict.
 *
 * ## Why this is deadlock-free
 *
 * The wait is strictly one-directional and one-deep. A registered write never
 * waits on anything from this module — only a commit does, and only on writes
 * registered *before* it started draining ({@link drainKeyedWrites} takes a
 * snapshot and does not loop to a fixed point). So there is no cycle to close,
 * and the drain terminates as soon as the pre-existing writes settle,
 * whichever way they settle. A commit's own Phase-2 writes register *after*
 * the drain has returned, so a commit never waits on itself.
 *
 * ## Scope, deliberately
 *
 * Keyed on the STORE object, not the `Noydb` instance — two hub instances over
 * one store are the same race, and this keeps the always-on kernel files
 * (`noydb.ts`) untouched. Same-process only: it is a JS-object registry, and
 * makes no claim about a second tab or a second process. That is the same
 * boundary the reported defect has.
 *
 * ⛔ This does NOT serialize transaction against transaction. Two concurrent
 * commits touching one key can still interleave — a distinct case from the
 * reported one, and one whose fix (a commit barrier) has to solve reentrancy
 * for the commit's own replay writes first. Do not extend this module into
 * that without measuring the reentrancy path.
 *
 * @internal
 */

/** store → key → the settle-promises of the writes currently in flight on it. */
const inFlight = new WeakMap<object, Map<string, Set<Promise<void>>>>()

/** The shared `(vault, collection, id)` key shape. @internal */
export function writeGateKey(vault: string, collection: string, id: string): string {
  return `${vault}\x00${collection}\x00${id}`
}

/**
 * Run one logical write registered against `(vault, collection, id)` so a
 * concurrent commit can drain it. Returns / throws exactly what `fn` does —
 * registration is invisible to the caller.
 *
 * @internal
 */
export async function trackKeyedWrite<R>(
  store: object,
  vault: string,
  collection: string,
  id: string,
  fn: () => Promise<R>,
): Promise<R> {
  let byKey = inFlight.get(store)
  if (byKey === undefined) {
    byKey = new Map()
    inFlight.set(store, byKey)
  }
  const key = writeGateKey(vault, collection, id)
  let waiters = byKey.get(key)
  if (waiters === undefined) {
    waiters = new Set()
    byKey.set(key, waiters)
  }
  const running = fn()
  // A drainer must never inherit this write's rejection: it is waiting for the
  // write to STOP being in flight, not for it to succeed. The original promise
  // is what the caller gets, unswallowed.
  const settled = running.then(() => undefined, () => undefined)
  waiters.add(settled)
  try {
    return await running
  } finally {
    waiters.delete(settled)
    if (waiters.size === 0) byKey.delete(key)
  }
}

/**
 * Wait for every write already in flight on `keys` to settle. Snapshot-based
 * and single-pass — see the deadlock note in the module doc. A no-op (and no
 * microtask) when nothing is in flight, which is the overwhelmingly common
 * case for a commit.
 *
 * @internal
 */
export async function drainKeyedWrites(store: object, keys: Iterable<string>): Promise<void> {
  const byKey = inFlight.get(store)
  if (byKey === undefined || byKey.size === 0) return
  let waits: Promise<void>[] | undefined
  for (const key of keys) {
    const waiters = byKey.get(key)
    if (waiters === undefined) continue
    for (const w of waiters) (waits ??= []).push(w)
  }
  if (waits !== undefined) await Promise.all(waits)
}
