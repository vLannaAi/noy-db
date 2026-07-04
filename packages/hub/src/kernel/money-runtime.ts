/**
 * Money engine runtime seam (#553).
 *
 * The kernel floor consults the money engine from SYNC paths — the
 * query DSL executes synchronously (`toArray()`/`first()`/`count()`),
 * `where()` quantizes operands at build time, and `moneyFields` path
 * validation throws at declaration time — so an `await import()` seam
 * would either break those sync semantics or race a fire-and-forget
 * preload. Instead the DECLARATION carries the engine: constructing a
 * descriptor via `money()` statically links the implementation
 * (`with-shape/money/engine.ts`) and installs it here, so by the time
 * any kernel path holds a `MoneyDescriptor` the engine is guaranteed
 * present.
 *
 * The kernel floor imports ONLY this holder plus the erased
 * {@link MoneyEngine} type; the engine modules are reachable solely
 * through the user's own `money()` import — a consumer that never
 * declares a money field tree-shakes the whole family out.
 */
import { NoydbError } from './errors.js'
import type { MoneyEngine } from '../with-shape/money/engine.js'

export type { MoneyEngine }

let engine: MoneyEngine | null = null

/** @internal — called (idempotently) by `money()` when a descriptor is built. */
export function installMoneyEngine(e: MoneyEngine): void {
  engine ??= e
}

/** @internal — test-only visibility into whether the engine was linked. */
export function isMoneyEngineInstalled(): boolean {
  return engine !== null
}

/**
 * @internal — resolve the installed engine. Every call site is gated on
 * the presence of a `MoneyDescriptor`, which only `money()` constructs,
 * so this cannot throw for supported inputs. A hand-rolled descriptor
 * object (not produced by `money()`) is the one path that lands here.
 */
export function moneyRuntime(): MoneyEngine {
  if (engine === null) {
    throw new NoydbError(
      'MONEY_ENGINE_NOT_LINKED',
      'money fields require descriptors created via money() from @noy-db/hub — ' +
        'hand-rolled descriptor objects are not supported',
    )
  }
  return engine
}
