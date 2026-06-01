/**
 * Generic per-instance **observe** bus (Track A, slice 1). Observe-class
 * subsystems (devtools inspector, audit, sync-dirty notification) register
 * handlers against named lifecycle points instead of the kernel naming each
 * subsystem. Mirrors the registry pattern of {@link WriteHookRegistry} but is
 * internal and keyed by lifecycle point.
 *
 * OBSERVE SEMANTICS: handlers react to a write that already happened. A
 * handler throw is warned, not propagated — it can never abort a write. Write-
 * *gating* subsystems (guards, periods) need the separate throw-propagating
 * gate bus (`beforePut`/`beforeDelete`, dispatched from `putInternal`); that is
 * NOT this primitive. Add observe points by extending {@link LifecycleEventMap}.
 *
 * @module
 */
import type { WriteEvent } from './write-hooks.js'

/** Typed map of OBSERVE lifecycle point → event payload. Extend by adding keys. */
export interface LifecycleEventMap {
  afterPut: WriteEvent
}

export type LifecyclePoint = keyof LifecycleEventMap
export type BusHandler<P extends LifecyclePoint> = (event: LifecycleEventMap[P]) => void | Promise<void>
export type Unsubscribe = () => void

type AnyHandler = (event: unknown) => void | Promise<void>

export class SubsystemBus {
  readonly #handlers = new Map<LifecyclePoint, AnyHandler[]>()
  #dispatching = false

  /** Register a handler for an observe point. Returns an unsubscribe fn. */
  register<P extends LifecyclePoint>(point: P, handler: BusHandler<P>): Unsubscribe {
    let arr = this.#handlers.get(point)
    if (!arr) { arr = []; this.#handlers.set(point, arr) }
    arr.push(handler as AnyHandler)
    return () => {
      const a = this.#handlers.get(point)
      if (!a) return
      const i = a.indexOf(handler as AnyHandler)
      if (i >= 0) a.splice(i, 1)
    }
  }

  /** Cheap gate for the write path — true when any handler is registered for the point. */
  hasHandlers(point: LifecyclePoint): boolean {
    const a = this.#handlers.get(point)
    return a !== undefined && a.length > 0
  }

  /** True while handlers are running — lets the write path skip nested firing, mirroring WriteHookRegistry.#suppressed. */
  get dispatching(): boolean { return this.#dispatching }

  /**
   * Dispatch in registration order, awaited. Per-handler errors are warned, not
   * thrown — an observe handler must never abort a completed write. A
   * re-entrancy guard suppresses nested firing so a handler that itself writes
   * cannot loop (same rationale as WriteHookRegistry.#suppressed).
   */
  async dispatch<P extends LifecyclePoint>(point: P, event: LifecycleEventMap[P]): Promise<void> {
    const a = this.#handlers.get(point)
    if (!a || a.length === 0 || this.#dispatching) return
    this.#dispatching = true
    try {
      for (const h of a.slice()) {
        try {
          await h(event)
        } catch (err) {
          console.warn(
            `[noy-db] subsystem observe handler failed at ${point}: ` +
            (err instanceof Error ? err.message : String(err)),
          )
        }
      }
    } finally {
      this.#dispatching = false
    }
  }
}
