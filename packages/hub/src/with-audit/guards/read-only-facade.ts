import type { Vault } from '../../kernel/vault.js'
import type { Query } from '../../kernel/query/builder.js'
import type { Layer } from '../../via/i18n/policy.js'
import type { ReadOnlyVaultFacade as ReadOnlyVaultFacadeContract } from './types.js'

/**
 * Minimal read-only wrapper over a `Vault`. Used as `ctx.vault` inside
 * guard / derivation callbacks so they can fetch related records without
 * acquiring any write capability.
 *
 * The `layer` tags every `get`/`list` read with the resolution layer it
 * belongs to. A guard-seeded facade reads at `'guard'`, a
 * derivation-seeded one at `'derivation'`, so i18nText / dictKey fields
 * resolve under that layer's `onMissing` policy instead of the `'read'`
 * policy — e.g. a guard read can `substitute` a missing locale (lenient
 * default) while the same field `throw`s on an ordinary app read.
 *
 * `query()` is left untagged: the query/aggregate pipeline reads raw
 * `{locale}` maps (no resolution call site), so a layer tag there would be
 * inert. Routing `mv`/`join` resolution through the pipeline is tracked
 * separately.
 */
export class ReadOnlyVaultFacade implements ReadOnlyVaultFacadeContract {
  private readonly _vault: Vault
  private readonly _layer: Layer

  constructor(vault: Vault, layer: Layer = 'read') {
    this._vault = vault
    this._layer = layer
  }

  collection<T = unknown>(name: string): {
    get(id: string): Promise<T | null>
    list(): Promise<T[]>
    query(): Query<T>
  } {
    const c = this._vault.collection<T>(name)
    const layer = this._layer
    return {
      get: (id: string) => c.get(id, { _layer: layer }),
      list: () => c.list({ _layer: layer }),
      query: () => c.query(),
    }
  }
}
