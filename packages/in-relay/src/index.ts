/**
 * **@noy-db/in-relay** — the relay server half (#1237).
 *
 * A frame dispatcher over a store whose profile EXCLUDES whole-vault replace
 * and vault enumeration. The exclusions are structural, not configured.
 *
 * ## Why this is not `in-rest` with a narrower `allow` set
 *
 * `in-rest` types its `store` as a full `NoydbStore` and gates dispatch with a
 * runtime `Set`. That is correct for `in-rest`, whose job is to serve a whole
 * store. Building a relay that way means handing the handler an object that
 * CARRIES `saveAll` and trusting the `Set` not to call it — structural absence
 * downgraded to a runtime allowlist, which is the one property a relay exists
 * to have. Here the store is a {@link NoydbRelayStore}, so the excluded members
 * cannot be called because they are not on the type.
 *
 * ## Two exclusions, two different reasons
 *
 * - `saveAll` — whole-vault replace. A relay that can be asked to overwrite a
 *   vault wholesale is a rollback superweapon aimed at the hosts trusting it.
 * - `listVaults` — enumeration is an existence leak. A relay serves vaults the
 *   caller already names; it never answers "what else is here".
 *
 * ## Unknown-method, not forbidden-method
 *
 * An excluded method is refused as **unknown** (400), never as forbidden (403).
 * A 403 would confirm the method exists and is merely disallowed here, which
 * names the excluded surface to anyone probing. Matching `@doi-db/daemon`,
 * which reached the same conclusion independently in its native implementation.
 *
 * @module
 */
import type { NoydbRelayStore, EncryptedEnvelope, TxOp } from '@noy-db/hub/to'

/**
 * The relay's method vocabulary.
 *
 * `saveAll` and `listVaults` are absent because they are absent from
 * {@link NoydbRelayStore} — adding either here would not compile a call.
 *
 * ⚠️ That is NOT sufficient on its own, and the first version of this comment
 * claimed it was: it said the list "cannot drift away from the type it
 * dispatches to", and it had already drifted by FOUR members
 * (`listPage`, `getStoreTime`, `presencePublish`, `presenceSubscribe`).
 * Omission is silent in the direction the type cannot catch — a member present
 * on the type and missing here is simply unreachable, and `listPage` being
 * unreachable means clients fall back to `loadAll`, which is the regression
 * pagination exists to prevent.
 *
 * So the invariant is now ENFORCED rather than asserted: {@link NOT_RELAYED}
 * names every deliberate exclusion, and a compile-time check below fails if
 * some method of {@link NoydbRelayStore} appears in neither list. Adding a
 * method to the store contract forces a decision here instead of a silent drop.
 */
export const RELAY_METHODS = [
  'get', 'put', 'delete', 'list', 'loadAll',
  'ping', 'listSince', 'listPage', 'getStoreTime', 'presencePublish',
  'estimateUsage', 'tx',
] as const

export type RelayMethod = (typeof RELAY_METHODS)[number]

/**
 * Members of {@link NoydbRelayStore} deliberately NOT dispatched, with reasons.
 *
 * - `presenceSubscribe` — returns an unsubscribe FUNCTION. A frame carries
 *   JSON, so this is not merely unimplemented, it is unrepresentable in a
 *   request/response shape. Server-initiated delivery is what the notify frame
 *   is for ({@link RelayNotifyFrame}, #1238), not a return value.
 * - `presignUrl` — hands the caller a time-limited URL that fetches the
 *   envelope **directly from the backing object store**, around this relay.
 *   That defeats the reason a relay exists: it is the mediating point, so a
 *   presigned URL survives revocation, escapes metering, and is unobservable
 *   here. Excluded on the security argument, not on serialisability — it would
 *   marshal perfectly, which is what makes it worth stating.
 */
export const NOT_RELAYED = ['presenceSubscribe', 'presignUrl'] as const

/**
 * Compile-time completeness check (#1237 follow-up). If a method exists on the
 * relay store type and is in neither list, `_exhaustive` errors — the drop is
 * caught at build time rather than becoming an unreachable method in a
 * published package.
 */
type StoreMethodNames = {
  [K in keyof NoydbRelayStore]-?: NonNullable<NoydbRelayStore[K]> extends (...args: never[]) => unknown ? K : never
}[keyof NoydbRelayStore]
type Accounted = RelayMethod | (typeof NOT_RELAYED)[number]
type Unaccounted = Exclude<StoreMethodNames, Accounted>
const _exhaustive: Unaccounted extends never ? true : ['unaccounted store methods', Unaccounted] = true
void _exhaustive

/** One request frame. Identical shape to `in-rest`'s, deliberately — see the module docs. */
export interface RelayFrame {
  readonly id: string
  readonly method: string
  readonly args: readonly unknown[]
}

/** A frame result: either a value, or an error with a status a transport can map. */
export type RelayResult =
  | { readonly ok: true; readonly id: string; readonly value: unknown }
  | { readonly ok: false; readonly id: string; readonly status: 400 | 500 | 501; readonly error: { readonly name: string; readonly message: string } }

export interface RelayHandlerOptions {
  /**
   * The store this relay serves. Typed as the NARROWED profile: a store may
   * carry `saveAll`, but this handler structurally cannot reach it.
   */
  readonly store: NoydbRelayStore
  /**
   * Where successful mutations are announced (#1238). Omit it and the handler
   * behaves exactly as before — pull-only.
   */
  readonly notify?: RelayNotifier
}

// ─── The notify frame — BESIDE /rpc (#1238) ──────────────────────────────
//
// Every transport in this family is client-pull. A hosted store that knows a
// record changed had no way to say so, so a client polled or learned on its
// next read. This frame is the server's one sentence, and it is deliberately a
// SMALL one. The shape questions the issue asked, answered here rather than
// assumed:
//
// - **Not a third encoding of the store contract.** A request is still
//   `{ id, method, args }`; a notification is not a method call and shares no
//   vocabulary with one. There are exactly two things on a relay wire besides
//   results: requests, discriminated by `method`, and this, discriminated by
//   `t: 'notify'`.
// - **Correlation id semantics.** `seq` is a per-SUBSCRIPTION sequence,
//   contiguous from 1 — not a request correlation (there is no request) and
//   not a subscription handle (that is the transport's business). A sequence
//   lets a client detect a GAP; a handle would not. The client's recovery from
//   a gap is `listSince(vault, collection, <last ts it applied>)`, which
//   already exists and is the reconciliation path: the frame is a hint that
//   makes polling unnecessary, never the source of truth.
// - **What it carries.** The ADDRESS of the change (`vault/collection/id`),
//   the op, and the envelope's own `_ts` (a delete has none, so the relay's
//   clock stands in). **Never the envelope.** Carrying it would make the push a
//   write path, with everything that implies for a fail-closed auth check and
//   for a store that is untrusted by construction; the client fetches through
//   the authenticated request path it already has.
// - **Delivery guarantee: at-most-once, in order per subscription.** A dropped
//   frame is recoverable by the gap + `listSince` rule above. A subscriber
//   that throws is dropped for that frame and never breaks the write or its
//   neighbours — the mutation already landed.
// - **Auth.** A subscription is scoped to the ONE vault it named — a client
//   never hears about a vault it did not already know, which keeps the
//   `listVaults` exclusion honest. Binding a subscription to an authenticated
//   session is the transport's job (this package is transport-neutral); the
//   frame carries no secret and no content, so the failure mode of a mistake
//   there is an existence leak, not a data leak — still a leak, still the
//   transport's to close.

/** Server-push frame: one successful mutation, by address. See the block above. */
export interface RelayNotifyFrame {
  readonly t: 'notify'
  /** Per-subscription, contiguous from 1. A gap means frames were missed: reconcile with `listSince`. */
  readonly seq: number
  readonly vault: string
  readonly collection: string
  readonly id: string
  readonly op: 'put' | 'delete'
  /** The envelope's `_ts` for a put; the relay's clock for a delete. Feed it to `listSince`. */
  readonly ts: string
}

/** A change as the handler reports it, before any subscriber's `seq` is stamped. */
export type RelayChange = Omit<RelayNotifyFrame, 't' | 'seq'>

export interface RelayNotifier {
  /**
   * Deliver every subsequent change in `vault` to `deliver`, each stamped with
   * this subscription's own `seq`. Returns an unsubscribe. Late joiners start
   * at 1 — the sequence is the subscription's, not the server's history.
   */
  subscribe(vault: string, deliver: (frame: RelayNotifyFrame) => void): () => void
  /** Called by the handler after a mutation LANDED. Not for transports to call. */
  publish(change: RelayChange): void
}

/**
 * The in-process fan-out. One per relay; a transport calls `subscribe` when an
 * authenticated session asks to watch a vault and forwards each frame on that
 * session's wire.
 */
export function createRelayNotifier(): RelayNotifier {
  type Sub = { deliver: (frame: RelayNotifyFrame) => void; seq: number }
  const byVault = new Map<string, Set<Sub>>()
  return {
    subscribe(vault, deliver) {
      const sub: Sub = { deliver, seq: 0 }
      let subs = byVault.get(vault)
      if (!subs) byVault.set(vault, (subs = new Set()))
      subs.add(sub)
      return () => {
        subs.delete(sub)
        if (subs.size === 0) byVault.delete(vault)
      }
    },
    publish(change) {
      const subs = byVault.get(change.vault)
      if (!subs) return
      for (const sub of [...subs]) {
        const frame: RelayNotifyFrame = { t: 'notify', seq: ++sub.seq, ...change }
        try {
          sub.deliver(frame)
        } catch {
          // The write landed; a subscriber that cannot take the frame does not
          // get to un-land it or starve the others. Its seq advanced, so it
          // will see the gap and reconcile.
        }
      }
    },
  }
}

/** Thrown for a method this relay does not implement — including excluded ones. */
export class UnknownRelayMethodError extends Error {
  constructor(method: string) {
    super(`Unknown method: ${method}`)
    this.name = 'UnknownRelayMethodError'
  }
}

/**
 * Thrown when the relay KNOWS a method but the backing store does not
 * implement it (the optional members of the store contract).
 *
 * ⚠️ Deliberately distinct from {@link UnknownRelayMethodError}, and the first
 * version of this package collapsed them: an absent optional method threw
 * `UnknownRelayMethodError` from inside dispatch, which the catch-all reported
 * as **500**. That misattributes a store CAPABILITY GAP as a server fault —
 * two states warranting opposite responses (the client should degrade
 * gracefully vs. the operator should investigate) rendered identically.
 *
 * `501` matches `@noy-db/in-rest`, which maps its own `UnsupportedMethodError`
 * to `501 NotImplemented`, and `@doi-db/daemon`, which reached 501
 * independently. It leaks nothing about the relay's EXCLUSIONS: those are
 * refused as 400-unknown before dispatch is reached.
 */
export class UnsupportedRelayMethodError extends Error {
  constructor(method: string) {
    super(`Method not supported by this store: ${method}`)
    this.name = 'UnsupportedRelayMethodError'
  }
}

function isRelayMethod(m: string): m is RelayMethod {
  return (RELAY_METHODS as readonly string[]).includes(m)
}

async function dispatch(store: NoydbRelayStore, method: RelayMethod, args: readonly unknown[]): Promise<unknown> {
  switch (method) {
    case 'get': {
      const [vault, collection, id] = args as [string, string, string]
      return store.get(vault, collection, id)
    }
    case 'put': {
      const [vault, collection, id, envelope, expectedVersion] = args as
        [string, string, string, EncryptedEnvelope, number | undefined]
      return store.put(vault, collection, id, envelope, expectedVersion)
    }
    case 'delete': {
      const [vault, collection, id] = args as [string, string, string]
      return store.delete(vault, collection, id)
    }
    case 'list': {
      const [vault, collection] = args as [string, string]
      return store.list(vault, collection)
    }
    case 'loadAll': {
      const [vault] = args as [string]
      return store.loadAll(vault)
    }
    case 'ping': {
      return store.ping?.() ?? true
    }
    case 'listSince': {
      const [vault, collection, since] = args as [string, string, string]
      if (store.listSince === undefined) throw new UnsupportedRelayMethodError('listSince')
      return store.listSince(vault, collection, since)
    }
    case 'listPage': {
      // Absent from the first published vocabulary. Its absence is not neutral:
      // a client with no pagination falls back to `loadAll`, which is the
      // regression `listPage` exists to prevent.
      const [vault, collection, cursor, limit] = args as [string, string, string | undefined, number | undefined]
      if (store.listPage === undefined) throw new UnsupportedRelayMethodError('listPage')
      return store.listPage(vault, collection, cursor, limit)
    }
    case 'getStoreTime': {
      if (store.getStoreTime === undefined) throw new UnsupportedRelayMethodError('getStoreTime')
      return store.getStoreTime()
    }
    case 'presencePublish': {
      const [channel, payload] = args as [string, string]
      if (store.presencePublish === undefined) throw new UnsupportedRelayMethodError('presencePublish')
      return store.presencePublish(channel, payload)
    }
    case 'estimateUsage': {
      if (store.estimateUsage === undefined) throw new UnsupportedRelayMethodError('estimateUsage')
      return store.estimateUsage()
    }
    case 'tx': {
      // Relayed: a native transaction is the store's own atomicity, and
      // withholding it would silently downgrade a relayed vault to per-op
      // writes — the CAS guarantees callers rely on would quietly weaken.
      const [ops] = args as [readonly TxOp[]]
      if (store.tx === undefined) throw new UnsupportedRelayMethodError('tx')
      return store.tx(ops)
    }
  }
}

/** The changes a successful mutating frame implies; empty for a read. */
function changesOf(method: RelayMethod, args: readonly unknown[]): RelayChange[] {
  switch (method) {
    case 'put': {
      const [vault, collection, id, envelope] = args as [string, string, string, EncryptedEnvelope]
      return [{ vault, collection, id, op: 'put', ts: envelope._ts }]
    }
    case 'delete': {
      const [vault, collection, id] = args as [string, string, string]
      return [{ vault, collection, id, op: 'delete', ts: new Date().toISOString() }]
    }
    case 'tx': {
      const [ops] = args as [readonly TxOp[]]
      return ops.map((op) => op.type === 'put'
        ? { vault: op.vault, collection: op.collection, id: op.id, op: 'put' as const, ts: op.envelope!._ts }
        : { vault: op.vault, collection: op.collection, id: op.id, op: 'delete' as const, ts: new Date().toISOString() })
    }
    default:
      return []
  }
}

/**
 * Build a frame handler over a narrowed store.
 *
 * Transport-neutral by design: it takes a decoded frame and returns a decoded
 * result, so a caller may serve it over HTTP, a WebSocket, or QUIC without this
 * package knowing which.
 */
export function createRelayHandler(options: RelayHandlerOptions): (frame: RelayFrame) => Promise<RelayResult> {
  const { store, notify } = options
  return async (frame: RelayFrame): Promise<RelayResult> => {
    if (!isRelayMethod(frame.method)) {
      // 400 unknown-method, NOT 403. Distinguishing would name the excluded
      // members to a prober; to this relay they simply do not exist.
      return {
        ok: false, id: frame.id, status: 400,
        error: { name: 'UnknownRelayMethodError', message: `Unknown method: ${frame.method}` },
      }
    }
    try {
      const value = await dispatch(store, frame.method, frame.args)
      // Announce AFTER the store returned: a frame reports what landed, so a
      // failed mutation publishes nothing and a tx publishes only once the
      // whole batch committed (#1238).
      if (notify) for (const change of changesOf(frame.method, frame.args)) notify.publish(change)
      return { ok: true, id: frame.id, value }
    } catch (err) {
      const e = err as Error
      // A store that does not implement an OPTIONAL method is a capability gap,
      // not a server fault: 501, so a client can degrade rather than retry.
      // Matches in-rest's UnsupportedMethodError -> 501 and @doi-db/daemon.
      const status = e instanceof UnsupportedRelayMethodError ? 501 : 500
      // The error's own name is forwarded so a client can re-hydrate a
      // ConflictError by name — the seam contract in-rest and to-rest settled
      // in #1218. Never `instanceof` across this boundary.
      return { ok: false, id: frame.id, status, error: { name: e.name, message: e.message } }
    }
  }
}
