/**
 * `servePeerStore()` — runs on the peer that owns the data. Listens on
 * a `PeerChannel` for RPC requests from a remote `peerStore()` client
 * and executes each one against the local `NoydbStore`.
 *
 * The 6 core methods plus the optional `ping` / `listSince` / `listPage`
 * extensions are exposed. Unknown methods surface as a remote Error.
 *
 * **Leader-election (issue #3).** When a `BroadcastChannel`-backed
 * `PeerChannel` is shared by 3+ tabs each running `servePeerStore`,
 * every non-sending tab responds to every RPC — producing duplicate
 * responses for the same request id and O(N²) channel traffic at scale.
 * Pass `leaderElection: { lockName, locks? }` to gate serving on the
 * Web Locks API: only the lock-holding tab registers an RPC handler;
 * others queue and take over when the holder's tab closes (lock auto-
 * releases). Default behaviour (no `leaderElection`) is unchanged for
 * the 2-tab case.
 *
 * @module
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub/to'
import type { PeerChannel } from './channel.js'
import { serveRpc } from './rpc.js'

/**
 * Minimal subset of the Web Locks API used by leader-election. The
 * browser's `navigator.locks` satisfies this; tests inject a stub.
 *
 * @public
 */
export interface MinimalLockManager {
  request<T>(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
}

/**
 * Compare in time independent of how many leading characters match.
 *
 * A plain `===` leaks the length of the shared prefix through timing, which
 * over a channel an attacker can call repeatedly is enough to recover a token
 * character by character. Length is not secret here (it is fixed by the invite
 * format), so comparing lengths first is fine; the CONTENT comparison must not
 * short-circuit.
 */
function constantTimeEquals(a: string | undefined, b: string): boolean {
  if (a === undefined || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface ServePeerStoreOptions {
  /** The duplex channel from the remote peer. */
  readonly channel: PeerChannel
  /** The local store to serve. */
  readonly store: NoydbStore
  /**
   * Bearer token from the invite. Every request must present it (milestone 52).
   *
   * ⚠️ FAIL-CLOSED: when this is omitted, EVERY request is refused. That
   * mirrors `in-rest`, where no `authorize` means 401 on everything, and it is
   * a deliberate reversal — this function used to serve the whole store to
   * anyone who reached the channel.
   *
   * Holding the channel used to BE the credential, which is defensible for a
   * 1:1 invite-based session share. It stops being defensible the moment a
   * channel stops meaning "I invited this person" — which is exactly what a
   * multi-peer topology does.
   */
  readonly token?: string
  /**
   * Optional method whitelist. When provided, any method not in the set
   * is rejected with "method not allowed". Useful for read-only peers.
   *
   * NOT authentication, and never was: it says which of the six methods may be
   * called, not by whom. It composes with `token` rather than replacing it.
   */
  readonly allow?: ReadonlySet<string>
  /**
   * Opt in to leader-election semantics for cross-tab coordination via
   * the Web Locks API. Required when 3+ tabs share a `BroadcastChannel`-
   * backed `PeerChannel` — without leader election, every non-sending tab
   * responds to every RPC, producing duplicate responses (issue #3).
   *
   * Browser support: Chrome 69+, Firefox 96+, Safari 15.4+.
   *
   * - `lockName` — globally unique lock name. Convention:
   *   `noy-db:peer-server:<channel-name>`. The same `lockName` MUST be
   *   used by every tab that wants to share the leader role.
   * - `locks` — defaults to `navigator.locks` in browsers. Pass a stub
   *   for tests or for non-browser hosts that polyfill the Web Locks API.
   *
   * Behaviour: at most one tab holds the lock at a time. Only that tab
   * registers an RPC handler on the channel; other tabs queue (their
   * `servePeerStore` call returns a working dispose function but does
   * not respond to incoming RPCs). When the holder's tab closes (or its
   * `servePeerStore` is disposed), the next queued tab takes over.
   */
  readonly leaderElection?: {
    readonly lockName: string
    readonly locks?: MinimalLockManager
  }
}

const CORE_METHODS = new Set<string>([
  'get',
  'put',
  'delete',
  'list',
  'loadAll',
  'saveAll',
  'ping',
  'listSince',
  'listPage',
  'listVaults',
])

/**
 * Start serving the local store on the channel. Returns a dispose
 * function that stops the RPC listener. The underlying channel is NOT
 * closed by dispose — ownership stays with the caller.
 *
 * When `leaderElection` is set, the RPC handler is only registered while
 * this tab holds the named Web Lock. The returned dispose function
 * always works: if called before the lock is acquired, it cancels the
 * wait; if called while holding the lock, it releases the lock and
 * stops serving.
 */
export function servePeerStore(opts: ServePeerStoreOptions): () => void {
  if (!opts.leaderElection) {
    return startServing(opts)
  }
  return startServingWithLeaderElection(opts)
}

/**
 * Register the RPC handler immediately. Used when leader-election is off,
 * and inside the lock callback when on.
 */
function startServing(opts: ServePeerStoreOptions): () => void {
  const { store, channel, allow, token } = opts

  return serveRpc(channel, async (method, args, auth) => {
    // Fail-closed, and BEFORE anything else — a refusal that ran after the
    // store call would be worse than no refusal: the caller sees an error and
    // the write landed anyway.
    if (token === undefined || !constantTimeEquals(auth, token)) {
      throw new Error(
        'Unauthorized: this peer store requires the bearer token from the invite. ' +
        'Pass it as `servePeerStore({ token })` on the server and `peerStore({ token })` ' +
        'on the client. A server with no token configured serves nobody, by design.',
      )
    }
    if (!CORE_METHODS.has(method)) {
      throw new Error(`Unknown RPC method: ${method}`)
    }
    if (allow && !allow.has(method)) {
      throw new Error(`Method not allowed: ${method}`)
    }

    switch (method) {
      case 'get': {
        const [vault, collection, id] = args as [string, string, string]
        return store.get(vault, collection, id)
      }
      case 'put': {
        const [vault, collection, id, envelope, expectedVersion] = args as [
          string,
          string,
          string,
          EncryptedEnvelope,
          number | null | undefined,
        ]
        // #1026 — `null` is not a legal `expectedVersion` (the contract types it
        // `number | undefined`), so anything that arrives as `null` came from a
        // JSON round-trip of `undefined` and means "do not compare-and-set".
        // Normalising here as well as on the client keeps a peer running an
        // older by-peer from silently failing every overwrite: a store's guard
        // is `!== undefined`, which `null` would pass, turning "no check" into
        // an assertion no existing record can satisfy.
        await store.put(vault, collection, id, envelope, expectedVersion ?? undefined)
        return null
      }
      case 'delete': {
        const [vault, collection, id] = args as [string, string, string]
        await store.delete(vault, collection, id)
        return null
      }
      case 'list': {
        const [vault, collection] = args as [string, string]
        return store.list(vault, collection)
      }
      case 'loadAll': {
        const [vault] = args as [string]
        return store.loadAll(vault)
      }
      case 'saveAll': {
        const [vault, data] = args as [string, VaultSnapshot]
        await store.saveAll(vault, data)
        return null
      }
      case 'ping': {
        if (!store.ping) return true
        return store.ping()
      }
      case 'listSince': {
        if (!store.listSince) throw new Error('listSince not supported by remote store')
        const [vault, collection, since] = args as [string, string, string]
        return store.listSince(vault, collection, since)
      }
      case 'listPage': {
        if (!store.listPage) throw new Error('listPage not supported by remote store')
        const [vault, collection, cursor, limit] = args as [
          string,
          string,
          string | undefined,
          number | undefined,
        ]
        return store.listPage(vault, collection, cursor, limit)
      }
      case 'listVaults': {
        if (!store.listVaults) throw new Error('listVaults not supported by remote store')
        return store.listVaults()
      }
    }
    /* istanbul ignore next — CORE_METHODS gate makes this unreachable */
    throw new Error(`Unhandled method: ${method}`)
  })
}

/**
 * Acquire a Web Lock first; only register the RPC listener while
 * holding it. Returns a dispose that cancels the wait (if not yet
 * acquired) or releases the lock (if held).
 */
function startServingWithLeaderElection(opts: ServePeerStoreOptions): () => void {
  // Asserted by the caller branch in `servePeerStore`.
  const leader = opts.leaderElection as { lockName: string; locks?: MinimalLockManager }
  const locks = leader.locks ?? getDefaultLocks()
  const ac = new AbortController()
  let stopServing: (() => void) | null = null
  let releaseLock: (() => void) | null = null
  let disposed = false

  void locks
    .request(leader.lockName, { mode: 'exclusive', signal: ac.signal }, () => {
      if (disposed) return Promise.resolve()
      stopServing = startServing(opts)
      // Hold the lock for the lifetime of this tab's leadership. The
      // returned promise stays pending until `releaseLock` is called by
      // the dispose function.
      return new Promise<void>((resolve) => {
        releaseLock = resolve
      })
    })
    .catch((err: unknown) => {
      // AbortError is the expected cancellation when dispose runs before
      // the lock was acquired. Anything else is unexpected — surface it
      // at the next tick so the host can observe it.
      if ((err as { name?: string } | null)?.name === 'AbortError') return
      queueMicrotask(() => {
        throw err
      })
    })

  return () => {
    if (disposed) return
    disposed = true
    if (stopServing) {
      stopServing()
      stopServing = null
    }
    if (releaseLock) {
      releaseLock()
      releaseLock = null
    } else {
      ac.abort()
    }
  }
}

function getDefaultLocks(): MinimalLockManager {
  const nav = (globalThis as { navigator?: { locks?: MinimalLockManager } }).navigator
  if (nav && nav.locks) return nav.locks
  throw new Error(
    'leaderElection requires the Web Locks API (navigator.locks). ' +
    'Use Chrome 69+, Firefox 96+, Safari 15.4+, or pass `leaderElection.locks: <stub>` ' +
    'for tests / non-browser hosts.',
  )
}
