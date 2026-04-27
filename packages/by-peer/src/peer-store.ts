/**
 * `peerStore()` — a `NoydbStore` backed by RPC calls over a `PeerChannel`.
 *
 * The local peer calls `get`/`put`/`delete`/… against this store as if
 * it were any other backend; every call is serialized as an RPC request
 * to the remote peer, which runs `servePeerStore()` to funnel the RPCs
 * into its own local `NoydbStore`.
 *
 * Error re-hydration: the remote handler re-throws `ConflictError` with
 * a `.version` field when a CAS check fails. The RPC layer carries
 * `version` in the error envelope so the local caller can catch
 * `ConflictError` with the same semantics as a direct store call.
 *
 * @module
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import type { PeerChannel } from './channel.js'
import { createRpcClient } from './rpc.js'

export interface PeerStoreOptions {
  /** The duplex channel to the remote peer. */
  readonly channel: PeerChannel
  /** Max ms to wait for any single RPC response. Default 30s. */
  readonly timeoutMs?: number
  /** Optional display name used in diagnostics. Default `'by-peer'`. */
  readonly name?: string
}

/**
 * Create a `NoydbStore` that forwards every operation to a remote peer
 * over the supplied `PeerChannel`. The remote peer must be running
 * `servePeerStore()` against its own local store.
 */
export function peerStore(opts: PeerStoreOptions): NoydbStore & { dispose: () => void } {
  const rpc = createRpcClient(opts.channel, { timeoutMs: opts.timeoutMs ?? 30_000 })

  async function call<T>(method: string, args: readonly unknown[]): Promise<T> {
    try {
      return await rpc.call<T>(method, args)
    } catch (err) {
      // Re-hydrate ConflictError so CAS semantics survive the wire hop.
      const e = err as Error & { version?: number }
      if (e.name === 'ConflictError' && typeof e.version === 'number') {
        throw new ConflictError(e.version, e.message)
      }
      throw err
    }
  }

  return {
    name: opts.name ?? 'by-peer',

    async get(vault, collection, id) {
      return call<EncryptedEnvelope | null>('get', [vault, collection, id])
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      await call<void>('put', [vault, collection, id, envelope, expectedVersion])
    },

    async delete(vault, collection, id) {
      await call<void>('delete', [vault, collection, id])
    },

    async list(vault, collection) {
      return call<string[]>('list', [vault, collection])
    },

    async loadAll(vault) {
      return call<VaultSnapshot>('loadAll', [vault])
    },

    async saveAll(vault, data) {
      await call<void>('saveAll', [vault, data])
    },

    async ping() {
      try {
        return await call<boolean>('ping', [])
      } catch {
        return false
      }
    },

    dispose() {
      rpc.dispose()
    },
  }
}
