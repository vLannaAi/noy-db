/**
 * `@noy-db/hub` record cold-storage archival subsystem.
 *
 * `withArchive({ store })` designates a cold {@link NoydbStore} as the
 * archive target. Declare a per-collection `archive` policy, then call
 * `vault.archive()` to relocate eligible sealed records there,
 * `vault.restore(collection, id)` to pull one back, and
 * `vault.listArchived()` to enumerate the cold set.
 *
 * @see ./engine for the relocation logic.
 */

import type { NoydbStore } from '../../kernel/types.js'

export interface WithArchiveOptions {
  /** The cold store that holds archived record envelopes. */
  store: NoydbStore
}

export interface ArchiveStrategy {
  readonly store: NoydbStore
}

/** Enable record cold-storage archival against the given cold store. */
export function withArchive(opts: WithArchiveOptions): ArchiveStrategy {
  return { store: opts.store }
}

export type {
  ArchivePolicy,
  ArchiveResult,
  ArchiveRunOptions,
  ArchiveContext,
} from './engine.js'
export { runArchive, runRestore, runListArchived } from './engine.js'
