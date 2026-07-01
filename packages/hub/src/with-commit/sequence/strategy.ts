/**
 * Sequence capability strategy — the single on-demand factory the vault routes
 * `vault.sequence()` through to build its atomic-CAS {@link SequenceStore}. The
 * active engine ({@link withSequence}) constructs the real store (kept out of
 * the floor bundle — the store class is reached only via the opt-in
 * `active.ts` chunk); {@link NO_SEQUENCE} throws. The vault always assembles the
 * per-call {@link SequenceStoreOptions} and delegates here, so an un-opted-in
 * caller hits `NO_SEQUENCE`'s throw at `vault.sequence()`.
 *
 * Note: `vault.sequence()` is synchronous, so the factory is a plain (sync)
 * constructor — the engine is tree-shaken by reachability (only `withSequence()`
 * pulls `active.ts`, which statically imports the store), not by a dynamic
 * import. Deferred-numbering series (`withDeferredNumbering`) are a distinct
 * capability and are NOT routed through this strategy.
 * @internal
 */
import type { SequenceStore, SequenceStoreOptions } from './index.js'
import { SequenceNotEnabledError } from '../../kernel/errors.js'

export interface SequenceStrategy {
  createStore(opts: SequenceStoreOptions): SequenceStore
}

/**
 * No-op stub — the floor default. The capability factory throws
 * {@link SequenceNotEnabledError}; opt in with `sequenceStrategy: withSequence()`
 * in createNoydb. @internal
 */
export const NO_SEQUENCE: SequenceStrategy = {
  createStore(): SequenceStore {
    throw new SequenceNotEnabledError()
  },
}
