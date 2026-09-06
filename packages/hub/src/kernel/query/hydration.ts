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
 * awaited, and throws {@link CollectionNotHydratedError} on every use that
 * READS it — indexing, `.length`, iteration, spread, `.map()`, `JSON.stringify`,
 * `String()`, `in`, `Object.keys`, arithmetic, any property read.
 *
 * ⛔ **THE EXACT BOUNDARY, enumerated — because "any other use" is what this
 * doc used to say, and it was not true (#1462).** Two operations answer
 * without reaching a proxy trap, and NEITHER CAN BE MADE TO THROW:
 *
 * | use | result | why it cannot throw |
 * |---|---|---|
 * | `typeof rows` | `'object'` | answered from the value's type, no trap |
 * | `if (rows)` / `Boolean(rows)` — truthiness | `true` | `ToBoolean` never calls a trap |
 *
 * Do not try to close either with a `valueOf` returning `false` — that would
 * resurrect the confident-wrong-answer this whole module exists to abolish, in
 * the one shape nobody would ever check.
 *
 * ⭐ **`Array.isArray` used to be a third row, and it was the dangerous one.**
 * `toArray()` is declared `T[]`, so `Array.isArray(rows) ? rows : []` is the
 * ORDINARY defensive shape for the declared type — and it returned `[]` on a
 * cold collection, restoring the silent empty read this module abolishes,
 * behind code that looks like it handles the edge case. It is closed: the
 * proxy's target is `[]`, and `IsArray` unwraps a proxy to its target, so the
 * check answers `true` and the guard falls through to the throwing path. That
 * cost one character of target and no change to the design — the report that
 * found it assumed it needed a real array exotic object.
 *
 * ⚠️ **So the rule for anyone extending this: a use that reaches a trap must
 * throw, and a use that cannot reach one must be IN THE TABLE ABOVE.** The
 * table is pinned by `__tests__/1462-pending-result-surface.test.ts`, which
 * also asserts this comment no longer claims a total guarantee — a probe
 * written against "any other use" passes vacuously, because the phrase names
 * no specific use for anything to contradict.
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
    // #1462 — the target is `[]`, NOT `{}`, and it is load-bearing: `IsArray`
    // unwraps a proxy to its target, so this is what makes
    // `Array.isArray(rows)` answer `true` and send the idiomatic guard into
    // the throwing path below instead of into a silent `[]`. Every trap still
    // fires — the target is never read, only classified.
    [],
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
