/**
 * Derivation dispatch, lifted out of the kernel spine (#842 part b).
 *
 * `Collection` carried ~380 lines of dispatch logic that belongs to the
 * derivation service, not to the always-on kernel. These are free functions
 * taking an explicit context so the spine keeps only a thin delegator.
 *
 * ## How the spine reaches this module
 *
 * By dynamic `import()`, never a static one. `check-architecture.mjs`'s
 * `port-layering` check forbids the spine from statically importing a
 * `with-*` service; `collection.ts` is grandfathered for ten
 * `with-formula/*` specifiers, but that list is frozen per file and a new
 * one is a violation. A dynamic import is the sanctioned S4 gate recipe, and
 * it keeps this chunk out of the floor bundle for consumers who never fire a
 * derivation.
 *
 * The `Collection` type reference below points back at the spine. That is
 * inward (service → kernel) and so allowed, and it is TYPE-ONLY — erased at
 * build, so no runtime cycle exists.
 *
 * @internal
 */

import type { NoydbStore } from '../../kernel/types.js'
import type { TxContext } from '../../with-commit/tx/transaction.js'
import type { DerivationRegistry } from './registry.js'
import type { Collection } from '../../kernel/collection.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'

/**
 * What the dispatchers need from the collection that owns them. Passing this
 * explicitly is what lets the logic live outside the class.
 */
export interface DerivationDeleteCtx {
  readonly derivationSource: {
    registry(): DerivationRegistry
    getCollection(name: string): Collection<Record<string, unknown>>
    getActiveTxContext(): TxContext | null
  }
  /** The collection the delete happened in. */
  readonly collectionName: string
  readonly adapter: NoydbStore
  readonly vault: string
  readonly getDEK: (collectionName: string) => Promise<EnclaveKey>
  readonly storeCiphertext: boolean
}

/**
 * Erase the derived rows a deleted source record fanned out to, and drop the
 * fan-out sidecars that recorded them.
 *
 * @param eraseRecordShapeToo also erase same-id `shape: 'record'` outputs.
 *   Restricted to a source-triggered strategy writing into a DIFFERENT
 *   collection — the self-denorm case would re-delete the record just
 *   tombstoned, and triggerBy/sibling strategies derive under a different id.
 * @returns rows ACTUALLY deleted, not edges visited (#622).
 */
export async function dispatchArrayDerivationsOnDelete(
  ctx: DerivationDeleteCtx,
  id: string,
  eraseRecordShapeToo = false,
): Promise<number> {
  const { derivationSource, collectionName, adapter, vault, getDEK, storeCiphertext } = ctx

  const strategies = derivationSource.registry().strategiesForSource(collectionName)
  if (strategies.length === 0) return 0

  const { loadFanoutSidecar, deleteFanoutSidecar } = await import('./fanout-sidecar.js')
  const txCtx = derivationSource.getActiveTxContext()
  let erased = 0

  for (const { spec } of strategies) {
    for (const [outputKey, outSpec] of Object.entries(spec.outputs)) {
      if (outSpec.shape === 'record') {
        if (eraseRecordShapeToo && spec.source === collectionName && outSpec.collection !== collectionName) {
          if (await derivationSource.getCollection(outSpec.collection)._internalDelete(id, txCtx)) erased += 1
        }
        continue
      }

      const sidecar = await loadFanoutSidecar(adapter, vault, spec.source, id, outputKey, getDEK, storeCiphertext)
      if (!sidecar) continue

      const outputCollection = derivationSource.getCollection(outSpec.collection)
      for (const derivedId of sidecar.keys) {
        if (await outputCollection._internalDelete(derivedId, txCtx)) erased += 1
      }
      await deleteFanoutSidecar(adapter, vault, spec.source, id, outputKey)
    }
  }

  return erased
}
