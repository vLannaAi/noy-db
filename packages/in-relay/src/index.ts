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
import type { NoydbRelayStore, EncryptedEnvelope } from '@noy-db/hub/to'

/**
 * The relay's method vocabulary, as an ALLOWLIST BY CONSTRUCTION.
 *
 * `saveAll` and `listVaults` are absent because they are absent from
 * {@link NoydbRelayStore} — not because they were filtered out. Adding either
 * name here would not compile a call, which is the point: the list cannot drift
 * away from the type it dispatches to.
 */
export const RELAY_METHODS = ['get', 'put', 'delete', 'list', 'loadAll', 'ping', 'listSince'] as const

export type RelayMethod = (typeof RELAY_METHODS)[number]

/** One request frame. Identical shape to `in-rest`'s, deliberately — see the module docs. */
export interface RelayFrame {
  readonly id: string
  readonly method: string
  readonly args: readonly unknown[]
}

/** A frame result: either a value, or an error with a status a transport can map. */
export type RelayResult =
  | { readonly ok: true; readonly id: string; readonly value: unknown }
  | { readonly ok: false; readonly id: string; readonly status: 400 | 500; readonly error: { readonly name: string; readonly message: string } }

export interface RelayHandlerOptions {
  /**
   * The store this relay serves. Typed as the NARROWED profile: a store may
   * carry `saveAll`, but this handler structurally cannot reach it.
   */
  readonly store: NoydbRelayStore
}

/** Thrown for a method this relay does not implement — including excluded ones. */
export class UnknownRelayMethodError extends Error {
  constructor(method: string) {
    super(`Unknown method: ${method}`)
    this.name = 'UnknownRelayMethodError'
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
      if (store.listSince === undefined) throw new UnknownRelayMethodError('listSince')
      return store.listSince(vault, collection, since)
    }
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
  const { store } = options
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
      return { ok: true, id: frame.id, value: await dispatch(store, frame.method, frame.args) }
    } catch (err) {
      const e = err as Error
      // The error's own name is forwarded so a client can re-hydrate a
      // ConflictError by name — the seam contract in-rest and to-rest settled
      // in #1218. Never `instanceof` across this boundary.
      return { ok: false, id: frame.id, status: 500, error: { name: e.name, message: e.message } }
    }
  }
}
