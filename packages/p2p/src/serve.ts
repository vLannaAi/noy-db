/**
 * `servePeerStore()` — runs on the peer that owns the data. Listens on
 * a `PeerChannel` for RPC requests from a remote `peerStore()` client
 * and executes each one against the local `NoydbStore`.
 *
 * The 6 core methods plus the optional `ping` / `listSince` / `listPage`
 * extensions are exposed. Unknown methods surface as a remote Error.
 *
 * @module
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import type { PeerChannel } from './channel.js'
import { serveRpc } from './rpc.js'

export interface ServePeerStoreOptions {
  /** The duplex channel from the remote peer. */
  readonly channel: PeerChannel
  /** The local store to serve. */
  readonly store: NoydbStore
  /**
   * Optional method whitelist. When provided, any method not in the set
   * is rejected with "method not allowed". Useful for read-only peers.
   */
  readonly allow?: ReadonlySet<string>
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
 */
export function servePeerStore(opts: ServePeerStoreOptions): () => void {
  const { store, channel, allow } = opts

  return serveRpc(channel, async (method, args) => {
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
          number | undefined,
        ]
        await store.put(vault, collection, id, envelope, expectedVersion)
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
