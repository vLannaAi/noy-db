/**
 * Generic per-instance **observe** bus. Observe-class
 * subsystems (devtools inspector, audit, sync-dirty notification) register
 * handlers against named lifecycle points instead of the kernel naming each
 * subsystem. Mirrors the registry pattern of {@link WriteHookRegistry} but is
 * internal and keyed by lifecycle point.
 *
 * OBSERVE SEMANTICS: handlers react to a write that already happened. A
 * handler throw is warned, not propagated — it can never abort a write. Write-
 * *gating* subsystems (guards, periods) need a throw-propagating gate bus.
 * Add observe points by extending {@link LifecycleEventMap}. Write-*gating*
 * subsystems use the sibling gate API on this same class
 * (`registerGate`/`dispatchGate`, throw-propagating); see {@link GateEventMap}.
 *
 * @module
 */
import type { WriteEvent } from './write-hooks.js'
import type { Role } from './types.js'

/** Typed map of OBSERVE lifecycle point → event payload. Extend by adding keys. */
export interface LifecycleEventMap {
  afterPut: WriteEvent
}

export type LifecyclePoint = keyof LifecycleEventMap
export type BusHandler<P extends LifecyclePoint> = (event: LifecycleEventMap[P]) => void | Promise<void>
export type Unsubscribe = () => void

type AnyHandler = (event: unknown) => void | Promise<void>

/** Payload for a `beforePut` gate — carries the data guards and periods need to validate or reject a write. */
export interface GatePutEvent {
  readonly op: 'create' | 'update'
  readonly vault: string
  readonly collection: string
  readonly docId: string
  /** The record about to be written (pre schema-validation). */
  readonly incoming: unknown
  /** Decrypted prior record, or null on create / when prior is unreadable. */
  readonly existing: unknown
  /** Prior envelope version, or 0 when none. */
  readonly existingVersion: number
  /** Prior envelope timestamp (`_ts` ISO string), or undefined when none — periods compares against this. */
  readonly existingTs: string | undefined
  readonly userId: string
  readonly role: Role
}

/** Payload for a `beforeDelete` gate. Like {@link GatePutEvent} without `incoming`. */
export interface GateDeleteEvent {
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly existing: unknown
  readonly existingVersion: number
  readonly existingTs: string | undefined
  readonly userId: string
  readonly role: Role
}

/** Typed map of GATE lifecycle point → event payload. Extend by adding keys. */
export interface GateEventMap {
  beforePut: GatePutEvent
  beforeDelete: GateDeleteEvent
}

export type GatePoint = keyof GateEventMap
export type GateHandler<P extends GatePoint> = (event: GateEventMap[P]) => void | Promise<void>

export class SubsystemBus {
  readonly #handlers = new Map<LifecyclePoint, AnyHandler[]>()
  readonly #gateHandlers = new Map<GatePoint, AnyHandler[]>()
  #depth = 0

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

  /**
   * True while one or more dispatches are in flight. Backed by a depth counter
   * so that two concurrent async dispatches (`Promise.all([put('a'), put('b')])`
   * each captured `busAfterPut=true` at their respective put() tops while depth
   * was 0) both proceed independently — the counter stays > 0 until BOTH finish,
   * so any nested write attempted by a handler still sees `dispatching === true`
   * and is suppressed by the write-path gate in `collection.ts`
   * (`busAfterPut = hasHandlers('afterPut') && !dispatching`). Re-entrancy
   * suppression lives exclusively on that write-path gate; concurrent independent
   * dispatches must not drop each other's events.
   */
  get dispatching(): boolean { return this.#depth > 0 }

  /**
   * Dispatch in registration order, awaited. Per-handler errors are warned, not
   * thrown — an observe handler must never abort a completed write. A
   * re-entrancy guard suppresses nested firing so a handler that itself writes
   * cannot loop (same rationale as WriteHookRegistry.#suppressed).
   */
  async dispatch<P extends LifecyclePoint>(point: P, event: LifecycleEventMap[P]): Promise<void> {
    const a = this.#handlers.get(point)
    if (!a || a.length === 0) return
    this.#depth++
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
      this.#depth--
    }
  }

  /** Register a write-gating handler. A throw from the handler ABORTS the write. Returns an unsubscribe fn. */
  registerGate<P extends GatePoint>(point: P, handler: GateHandler<P>): Unsubscribe {
    let arr = this.#gateHandlers.get(point)
    if (!arr) { arr = []; this.#gateHandlers.set(point, arr) }
    arr.push(handler as AnyHandler)
    return () => {
      const a = this.#gateHandlers.get(point)
      if (!a) return
      const i = a.indexOf(handler as AnyHandler)
      if (i >= 0) a.splice(i, 1)
    }
  }

  /** Cheap gate for the write path — true when any gate handler is registered for the point. */
  hasGateHandlers(point: GatePoint): boolean {
    const a = this.#gateHandlers.get(point)
    return a !== undefined && a.length > 0
  }

  /**
   * Run gate handlers in registration order, awaited. Unlike `dispatch`
   * (observe), a handler throw is NOT swallowed — it PROPAGATES, aborting the
   * write before it reaches the store. The first throw stops the remaining
   * handlers (fail-fast). This is the seam guards/periods migrate onto.
   *
   * Note: gate handlers are validators that read, not write. A gate handler
   * that writes back into the same collection would re-enter the write path
   * and re-dispatch this point; loop-suppression for that case is deferred to
   * the migration slice (contract: gate handlers must not perform writes that
   * re-trigger their own point).
   */
  async dispatchGate<P extends GatePoint>(point: P, event: GateEventMap[P]): Promise<void> {
    const a = this.#gateHandlers.get(point)
    if (!a || a.length === 0) return
    for (const h of a.slice()) {
      await h(event) // throw propagates → aborts the write
    }
  }
}
