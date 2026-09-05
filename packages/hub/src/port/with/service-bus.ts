/**
 * Generic per-instance **observe** bus. Observe-class
 * services (devtools inspector, audit, sync-dirty notification) register
 * handlers against named lifecycle points instead of the kernel naming each
 * service. Mirrors the registry pattern of {@link WriteHookRegistry} but is
 * internal and keyed by lifecycle point.
 *
 * OBSERVE SEMANTICS: handlers react to a write that already happened. A
 * handler throw is warned, not propagated — it can never abort a write. Write-
 * *gating* services (guards, periods) need a throw-propagating gate bus.
 * Add observe points by extending {@link LifecycleEventMap}. Write-*gating*
 * services use the sibling gate API on this same class
 * (`registerGate`/`dispatchGate`, throw-propagating); see {@link GateEventMap}.
 *
 * @module
 */
import type { WriteEvent } from './write-hooks.js'
import type { Role } from '../../kernel/types.js'

/** Typed map of OBSERVE lifecycle point → event payload. Extend by adding keys. */
export interface LifecycleEventMap {
  afterPut: WriteEvent
  afterDelete: WriteEvent
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
  /**
   * The record about to be written (pre schema-validation). Money fields
   * are presented in their canonical decoded form — equal on both
   * sides for an unchanged value, regardless of how the caller wrote them.
   */
  readonly incoming: unknown
  /**
   * Decrypted prior record, or null on create / when prior is unreadable.
   * Money fields are decoded to the canonical decimal `get()` shape, NOT
   * the stored scaled-int — `incoming[f] === existing[f]` holds
   * for an unchanged money field.
   */
  readonly existing: unknown
  /** Prior envelope version, or 0 when none. */
  readonly existingVersion: number
  /** Prior envelope timestamp (`_ts` ISO string), or undefined when none — periods compares against this. */
  readonly existingTs: string | undefined
  readonly userId: string
  readonly role: Role
  /**
   * Names of fields whose values are schema-owned computed fields for this
   * collection. Gate handlers (e.g. `frozenFields`) must skip these: the
   * incoming record is the raw user input (computed fields not yet evaluated),
   * so comparing `existing[computedField]` vs `incoming[computedField]`
   * would always see a change even when the computed result is unchanged.
   */
  readonly computedFieldNames?: ReadonlySet<string>
}

/** Payload for a `beforeDelete` gate. Like {@link GatePutEvent} without `incoming`. */
export interface GateDeleteEvent {
  readonly vault: string
  readonly collection: string
  readonly docId: string
  /** True for system-internal (housekeeping) deletes — handlers branch on this. */
  readonly internal: boolean
  /** Decrypted prior record; money fields decoded to the canonical `get()` shape. */
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

/**
 * Registration options for a gate handler.
 *
 * `needsPrior` (default `true`) declares whether the handler reads the
 * prior-derived event fields — `existing`, `existingVersion`, `existingTs`,
 * and (on `beforePut`) `op`. When EVERY handler registered at a point set
 * `needsPrior: false`, the write path skips the prior-read (store get +
 * decrypt) entirely and dispatches the event with `existing: null`,
 * `existingVersion: 0`, `existingTs: undefined` (and `op: 'create'` on
 * `beforePut`; a `beforeDelete` gate then also fires for delete-of-absent).
 * A handler that opts out MUST NOT rely on those fields. (#267 prior-read
 * elision — pure perf; one prior-needing handler restores the old behavior
 * for the whole point.)
 */
export interface GateRegisterOptions {
  readonly needsPrior?: boolean
  /**
   * #1439 — declare when this handler provably CANNOT fire, so a caller can
   * tell "no gate applies here" from "some gate exists somewhere".
   *
   * ⛔ The distinction is not academic. `hasGateHandlers` answers a question
   * about the BUS, and the bus is shared by every collection in the vault —
   * both `beforePut` registrants decide per event (guards by collection,
   * periods by the record's date field), so "is anything registered" was read
   * as "this write is gated" and installing `withPeriods()` anywhere disabled
   * an unrelated optimisation for every collection. Measured: an MV output
   * went from 0 to 250 redundant writes per source write with no period closed
   * and no collection registered as a subject.
   *
   * Returning `true`, or omitting this entirely, means "may fire" — the safe
   * answer, and the default. Only return `false` for a case the handler can
   * rule out cheaply and completely.
   */
  readonly scope?: GateScope
}

/**
 * Asks a gate handler whether it could fire for this target. `record` is the
 * row about to be written when the caller has one — a period gate can rule
 * itself out for a row carrying none of its closed periods' date fields, which
 * a collection-level question could never answer.
 */
export type GateScope = (target: {
  readonly vault: string
  readonly collection: string
  readonly record?: Record<string, unknown>
}) => boolean

type GateEntry = { readonly fn: AnyHandler; readonly needsPrior: boolean; readonly scope: GateScope | undefined }

export class ServiceBus {
  readonly #handlers = new Map<LifecyclePoint, AnyHandler[]>()
  readonly #gateHandlers = new Map<GatePoint, GateEntry[]>()
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
            `[noy-db] service observe handler failed at ${point}: ` +
            (err instanceof Error ? err.message : String(err)),
          )
        }
      }
    } finally {
      this.#depth--
    }
  }

  /**
   * Register a write-gating handler. A throw from the handler ABORTS the
   * write. Returns an unsubscribe fn. See {@link GateRegisterOptions} for
   * the `needsPrior` prior-read declaration (#267).
   */
  registerGate<P extends GatePoint>(point: P, handler: GateHandler<P>, opts?: GateRegisterOptions): Unsubscribe {
    let arr = this.#gateHandlers.get(point)
    if (!arr) { arr = []; this.#gateHandlers.set(point, arr) }
    const entry: GateEntry = { fn: handler as AnyHandler, needsPrior: opts?.needsPrior !== false, scope: opts?.scope }
    arr.push(entry)
    return () => {
      const a = this.#gateHandlers.get(point)
      if (!a) return
      const i = a.indexOf(entry)
      if (i >= 0) a.splice(i, 1)
    }
  }

  /** Cheap gate for the write path — true when any gate handler is registered for the point. */
  hasGateHandlers(point: GatePoint): boolean {
    const a = this.#gateHandlers.get(point)
    return a !== undefined && a.length > 0
  }

  /**
   * #1439 — could a gate at `point` fire for THIS target?
   *
   * ⚠️ This is the question callers almost always mean, and
   * {@link hasGateHandlers} is not it. That one is about the bus, which is
   * shared by the whole vault; this one consults each handler's declared
   * {@link GateScope}. A handler that declares none counts as "may fire", so a
   * registrant which has not thought about scope keeps today's behaviour.
   *
   * ⛔ A scope that throws is treated as "may fire". A predicate whose job is
   * to permit an optimisation must never be able to disable a gate by failing.
   */
  gateAppliesTo(
    point: GatePoint,
    target: { readonly vault: string; readonly collection: string; readonly record?: Record<string, unknown> },
  ): boolean {
    const a = this.#gateHandlers.get(point)
    if (a === undefined || a.length === 0) return false
    return a.some((e) => {
      if (e.scope === undefined) return true
      try { return e.scope(target) } catch { return true }
    })
  }

  /**
   * True when at least one gate handler at `point` needs the prior record
   * (the default). False when the point has no handlers or every handler
   * registered with `needsPrior: false` — the write path then skips the
   * prior-read before dispatching (#267 prior-read elision).
   */
  gateNeedsPrior(point: GatePoint): boolean {
    const a = this.#gateHandlers.get(point)
    if (!a) return false
    return a.some((e) => e.needsPrior)
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
    for (const e of a.slice()) {
      await e.fn(event) // throw propagates → aborts the write
    }
  }
}

