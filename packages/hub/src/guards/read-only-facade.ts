import type { Vault } from '../vault.js'
import type { Query } from '../query/builder.js'
import type { ReadOnlyVaultFacade as ReadOnlyVaultFacadeContract } from './types.js'

/**
 * Minimal read-only wrapper over a `Vault`. Used as `ctx.vault` inside
 * guard callbacks so they can fetch related records without acquiring
 * any write capability.
 */
export class ReadOnlyVaultFacade implements ReadOnlyVaultFacadeContract {
  private readonly _vault: Vault

  constructor(vault: Vault) {
    this._vault = vault
  }

  collection<T = unknown>(name: string): {
    get(id: string): Promise<T | null>
    list(): Promise<T[]>
    query(): Query<T>
  } {
    const c = this._vault.collection<T>(name)
    return {
      get: (id: string) => c.get(id),
      list: () => c.list(),
      query: () => c.query(),
    }
  }
}
