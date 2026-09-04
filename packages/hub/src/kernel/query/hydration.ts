import { CollectionNotHydratedError } from '../errors.js'

/**
 * #1414 — the cold-collection gate.
 *
 * An eager collection that has never been read asynchronously holds an EMPTY
 * cache. Before this module every synchronous query terminal answered out of
 * that cache, so a cold collection reported `[]` / `0` / `false` with total
 * confidence, forever, until some `list()`/`get()` hydrated it. Guards inherit
 * the same source through `ReadOnlyVaultFacade`, and both failure directions
 * were measured on shipped stable: a valid write refused because the guard's
 * lookup came back empty, and — worse — a write that a warm instance REFUSES
 * committing on a cold one, because the guard's `await …toArray()` saw nothing.
 *
 * **Empty and unable-to-answer are different facts.** Same posture as #1402
 * ("an index that cannot answer must say so, not return nothing") and #1410.
 *
 * The fix has to serve two callers at once, and that is what shapes this
 * module:
 *
 *  - the AWAITED caller (`await q.toArray()`, and therefore every guard, since
 *    `GuardSpec.check` is async) must transparently hydrate and get the rows.
 *    This is the half that closes the bypass.
 *  - the SYNCHRONOUS caller must be told, loudly, that the answer it is about
 *    to trust is not an answer.
 *
 * A terminal cannot both throw and be awaitable, so a cold terminal returns a
 * **pending result**: a thenable that hydrates and re-runs the terminal when
 * awaited, and throws {@link CollectionNotHydratedError} on any other use —
 * indexing, iteration, arithmetic, string coercion, property read.
 *
 * ⚠️ **The one hole, and it is a hole in JavaScript, not in this design:**
 * `ToBoolean` never calls a trap, so `if (cold.query().exists())` takes the
 * truthy branch without throwing. Every *use of the value* throws; a bare
 * truthiness test is not a use. Do not try to close it with a `valueOf`
 * returning `false` — that would resurrect the confident-wrong-answer this
 * whole module exists to abolish, in the one shape nobody would ever check.
 */
export interface HydrationGate {
  /** `<vault>/<collection>` — names the collection in the error. */
  readonly label: string
  /** Collection name alone, for the error's structured field. */
  readonly collection: string
  /** False only while the eager cache has never been bulk-loaded. */
  isHydrated(): boolean
  /** Bulk-load the collection. Idempotent. */
  hydrate(): Promise<void>
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/**
 * Wrap a terminal's result for an unhydrated collection. `compute` is re-run
 * AFTER hydration — it must be the terminal itself, not a captured value, or
 * the awaited caller would receive the cold answer it came here to avoid.
 */
function pendingResult<V>(gate: HydrationGate, terminal: string, compute: () => V): V {
  let settled: Promise<V> | undefined
  const settle = (): Promise<V> => (settled ??= gate.hydrate().then(() => compute()))
  const refuse = (): never => {
    throw new CollectionNotHydratedError(gate.collection, terminal, gate.label)
  }
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (onOk?: (v: V) => unknown, onErr?: (e: unknown) => unknown): Promise<unknown> =>
            settle().then(onOk, onErr)
        }
        if (prop === 'catch') {
          return (onErr?: (e: unknown) => unknown): Promise<unknown> => settle().catch(onErr)
        }
        if (prop === 'finally') {
          return (fn?: () => void): Promise<V> => settle().finally(fn)
        }
        if (prop === Symbol.toStringTag) return 'NoydbPendingResult'
        if (prop === INSPECT) {
          return () => `[noydb: ${terminal}() on unhydrated collection "${gate.label}" — await it, or await list()/get() first]`
        }
        return refuse()
      },
      has: refuse,
      ownKeys: refuse,
      set: refuse,
      getOwnPropertyDescriptor: refuse,
    },
  )
  return proxy as V
}

/**
 * Terminal wrapper. Returns `compute()` unchanged whenever the source is
 * hydrated (or carries no gate at all — a plain-object source, a join source,
 * a lazy collection), so the hot path is one property read and a boolean.
 */
export function gateTerminal<V>(
  gate: HydrationGate | undefined,
  terminal: string,
  compute: () => V,
): V {
  if (gate === undefined || gate.isHydrated()) return compute()
  return pendingResult(gate, terminal, compute)
}
