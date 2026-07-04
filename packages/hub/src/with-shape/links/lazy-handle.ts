/**
 * Lazy link-set handle factory (#553).
 *
 * `vault.links(name)` is a SYNC accessor, but every method on the handle
 * it returns is async — so the handle can defer loading the `LinkSet`
 * storage engine to the first actual link I/O. This keeps `link-set.ts`
 * out of the floor bundle for consumers that never use links, while the
 * handle object itself stays cached and referentially stable per name.
 *
 * Besides the public {@link LinkSetHandle} surface, the handle carries
 * the two cascade internals the ref/link enforcement facade consults
 * (`vault-facade.ts` casts the handle to `LinkSet` and duck-types them).
 */
import { linkCollectionName, type LinkRow, type LinkSpec, type LinkSetHandle } from './names.js'
import type { LinkSet } from './link-set.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { NoydbEventEmitter } from '../../kernel/events.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'

/** @internal The lazy handle: public surface + facade cascade internals. */
export type LazyLinkSetHandle = LinkSetHandle & {
  readonly _collectionName: string
  _rowsTouchingEndpoint(collection: string, id: string): Promise<LinkRow[]>
}

/** @internal Constructor args for the deferred {@link LinkSet}. */
export interface LazyLinkSetDeps {
  readonly adapter: NoydbStore
  readonly vault: string
  readonly name: string
  readonly spec: LinkSpec
  readonly encrypted: boolean
  readonly getDEK: (collectionName: string) => Promise<EnclaveKey>
  readonly actor: string
  readonly emitter: NoydbEventEmitter
  readonly endpointExists: (collection: string, id: string) => Promise<boolean>
}

/** @internal Build the handle; the LinkSet engine dynamic-imports on first use. */
export function makeLazyLinkSetHandle(d: LazyLinkSetDeps): LazyLinkSetHandle {
  let engine: Promise<LinkSet> | null = null
  const load = (): Promise<LinkSet> =>
    (engine ??= import('./link-set.js').then(
      ({ LinkSet }) =>
        new LinkSet(d.adapter, d.vault, d.name, d.spec, d.encrypted, d.getDEK, d.actor, d.emitter, d.endpointExists),
    ))
  return {
    _collectionName: linkCollectionName(d.name),
    connect: async (aId, bId, meta) => (await load()).connect(aId, bId, meta),
    disconnect: async (aId, bId) => (await load()).disconnect(aId, bId),
    has: async (aId, bId) => (await load()).has(aId, bId),
    of: async (id) => (await load()).of(id),
    list: async () => (await load()).list(),
    _rowsTouchingEndpoint: async (collection, id) => (await load())._rowsTouchingEndpoint(collection, id),
  }
}
