/**
 * Strategy seam between the kernel spine and the optional archive service
 * (#838 — precedent: `port/with/blob-strategy.ts`). Lives on the `/with`
 * port so `Vault` can hold the `NO_ARCHIVE` default without a
 * spine→service static import.
 *
 * `archiveStrategy` was the one service with no NO-op stub: the spine held
 * it as `ArchiveStrategy | undefined` and hand-rolled a null gate before
 * every use. That made it the sole exception to the strategy-bag's "every
 * key always resolves" rule (#838), so the stub exists to remove the
 * exception rather than to add a capability.
 *
 * `ArchiveStrategy`'s only member is a live cold `NoydbStore`, and there is
 * no meaningful no-op store — so the stub throws on access instead of
 * standing in. That reproduces the previous gate exactly: `_archiveContext()`
 * read `strategy.store` immediately after its null check, so the throw lands
 * in the same call with the same message.
 *
 * The `ArchiveStrategy` import is TYPE-ONLY and therefore erased — importing
 * it does not pull `with-fork/archive/index.js`'s runtime re-exports of the
 * relocation engine.
 *
 * @internal
 */

import type { ArchiveStrategy } from '../../with-fork/archive/index.js'

const ARCHIVE_NOT_ENABLED =
  'vault.archive/restore/listArchived require `archiveStrategy: withArchive({ store })` in createNoydb'

/**
 * The un-opted-in archive strategy. Reading `.store` throws with a pointer
 * at the `withArchive()` factory — the archive service has no degraded mode
 * to fall back to.
 */
export const NO_ARCHIVE: ArchiveStrategy = {
  get store(): never {
    throw new Error(ARCHIVE_NOT_ENABLED)
  },
}
