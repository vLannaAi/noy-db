/**
 * Strategy seam between core Collection and the optional blob service
 * (#629 Task 7 — moved out of `with-shape/blobs/strategy.ts`, precedent:
 * `port/with/classified-strategy.ts`/`i18n-strategy.ts`). Lives on the
 * `/with` port (the one seam the kernel spine may import statically) so
 * `Collection`/`Vault` can hold the `NO_BLOBS` default without a
 * spine→service static import.
 *
 * Core imports `BlobStrategy` as a TYPE-ONLY symbol and `NO_BLOBS` as a
 * minimal runtime stub. Neither pulls in the heavy `BlobSet` / chunk /
 * MIME machinery — those only arrive when the consumer explicitly
 * imports `@noy-db/hub/blobs` (see `via/blob/index.ts` →
 * `withBlobs()` factory).
 *
 * This file is intentionally tiny so the bundler keeps it in the graph
 * without dragging everything else in.
 *
 * @internal
 */

import type { BlobSet } from '../../with-shape/blobs/blob-set.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { ObjectProjection } from '../../with-shape/blobs/object-projection.js'
import type { BlobFieldsConfig } from '../../with-shape/blobs/blob-compaction.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { linkBlobVia } from '../../via/blob/binding.js'

// Install the blob Via binder EAGERLY (#629 Task 7) — `blobFields` policies
// are plain object literals (there is no `blob.*()` declaration factory to
// hang a lazy money/i18n-style link on), so the binder must be installed
// before `compileViaBindings` ever compiles one. This port module is
// already unconditionally imported by the kernel spine (for the `NO_BLOBS`
// strategy default below), so linking here guarantees it — same rationale
// as `port/with/classified-strategy.ts`'s eager `linkClassifiedVia()`. The
// binding module is hook-free glue (declare/describe/erase) and imports no
// machinery, so the eager cost is a few hundred bytes, not `BlobSet`.
linkBlobVia()

/**
 * Args forwarded by `Collection.blob(id)` to the active strategy's
 * `openSlot`. The strategy is responsible for returning a live
 * `BlobSet` bound to the given record.
 *
 * @internal
 */
export interface BlobStrategyOpenArgs {
  readonly store: NoydbStore
  readonly vault: string
  readonly collection: string
  readonly recordId: string
  readonly getDEK: (collectionName: string) => Promise<EnclaveKey>
  readonly encrypted: boolean
  readonly userId: string
  /**
   * Collection opts into per-record keys (`perRecordKeys`), so its blobs are
   * erasable: new uploads mint a per-blob content CEK (crypto-shreddable at
   * `refCount → 0`). Off → legacy shared-`_blob`-DEK chunks. See the per-blob
   * CEK design spec.
   */
  readonly erasableBlobs?: boolean
  /**
   * Collection has `tiers` active (#724 I1 completion). Combined with
   * `erasableBlobs` false, a content write is refused —
   * `UnsupportedTierCompositionError` — since a legacy blob has no
   * per-blob `_cek` and can never be tier-isolated on elevate/demote.
   */
  readonly tiersActive?: boolean
  /**
   * Vault is in debug-plaintext mode (`encrypt: false` + `debugPlaintext: true`).
   * Blobs are then written as a single un-gzipped object (one base64 chunk) so
   * the stored object is directly recoverable with native tools (`base64 -d`),
   * matching the directly-inspectable record layout. Dev-only — see the
   * plaintext/debug-store-mode design.
   */
  readonly debugPlaintext?: boolean
  /**
   * Object projection for `external` blob fields (`createNoydb({ objectStore })`).
   * When present, fields declared `external` in `blobFields` route their raw
   * bytes here instead of the encrypted-chunk path.
   */
  readonly objectStore?: ObjectProjection
  /** Per-collection blob field policies — used to resolve `external` / `public`. */
  readonly blobFields?: BlobFieldsConfig
}

/**
 * The seam interface. `@internal` — do not build public APIs on this
 * shape; it can evolve freely until blobs are extracted into their
 * own package, at which point it will be promoted to public.
 *
 * @internal
 */
export interface BlobStrategy {
  openSlot(args: BlobStrategyOpenArgs): BlobSet
}

/**
 * Default strategy for collections that did not opt into blob storage.
 * Every operation surfaces an actionable error that points the caller
 * at the opt-in path.
 *
 * @internal
 */
export const NO_BLOBS: BlobStrategy = {
  openSlot() {
    throw new Error(
      'Blob storage is not enabled on this Noydb instance. ' +
      'Import `{ withBlobs }` from "@noy-db/hub/blobs" and pass `withBlobs()` to `createNoydb({ blobStrategy: withBlobs() })`.',
    )
  },
}
