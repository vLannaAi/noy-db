/**
 * A `Map` that stamps every mutation with a globally unique, monotonic tick
 * (#1417).
 *
 * The eager collection cache is written at ELEVEN sites — `put`, `delete`,
 * hydration, sync cut-over, the lookup write-through, and more. Anything that
 * memoizes a derived view of that cache (a sorted keyset page order; a
 * decorated row set) needs to know when the cache moved, and hand-bumping a
 * counter at eleven call sites is a stale-read waiting to happen: miss one and
 * a reader serves rows from before a write, which is strictly worse than the
 * cost the memo was there to avoid.
 *
 * ⛔ So the counter lives in the container, not at the call sites. Every
 * mutation route into a `Map` is `set` / `delete` / `clear`; overriding those
 * three makes the invariant STRUCTURAL — a new write site cannot forget,
 * because there is nothing for it to remember.
 *
 * ⭐ THE TICK IS GLOBAL, NOT PER-INSTANCE, and that is load-bearing. A memo
 * keyed on `<vault>/<collection>` + a per-instance count collides across two
 * collections that share a name — a second vault, a torn-down and rebuilt
 * instance, a test suite reusing `V/rows` — because both count from zero. A
 * process-wide tick makes every stamp unique, so identity + generation is a
 * sound memo key without the memo having to know about instance lifetimes.
 * (Measured, by a test that reused a collection name and got another
 * collection's page order back.)
 *
 * `set` bumps even when the value is identical: a redundant invalidation costs
 * one recompute, a missed one costs correctness.
 *
 * @module
 */

/**
 * Process-wide mutation tick. Never reset. At one bump per write it outlives
 * any realistic process by a wide margin before losing integer precision.
 */
let tick = 0

export class GenerationMap<K, V> extends Map<K, V> {
  /**
   * ⚠️ NOT a `#private` field, and not readonly-initialised, deliberately.
   * `Map`'s constructor calls `this.set()` for each entry of an iterable
   * argument — which runs BEFORE this class's fields are installed. A
   * `#private` field throws `TypeError` on touch at that point; a declared
   * property is merely `undefined`, and assigning to it is safe. The
   * initializer below then runs and resets it to 0, which is the correct
   * resting state for a freshly built map.
   */
  private gen = 0

  /** Mutation stamp. Equal across two reads means nothing changed between them. */
  get generation(): number {
    return this.gen
  }

  override set(key: K, value: V): this {
    this.gen = ++tick
    return super.set(key, value)
  }

  override delete(key: K): boolean {
    this.gen = ++tick
    return super.delete(key)
  }

  override clear(): void {
    this.gen = ++tick
    super.clear()
  }
}
