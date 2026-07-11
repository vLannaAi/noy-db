/**
 * The blob `ViaBinding` (#629 Task 7) — wires the `blobFields` declaration
 * into the kernel's generic Via port as a deliberately THIN binding:
 * declaration + posture + `describeFragment` + `erase` glue, and nothing
 * else. Blob content is fully out-of-band (`collection.blob(id)` →
 * `BlobSet` writing `_blob_*` side-collections; it never touches
 * `_putInternal` or the record codec), so this binding declares **no
 * write/read pipeline hooks** — in particular no `encodeAtRest`/
 * `decodeAtRest`: a blobFields collection must not flip the pipeline's
 * `hasAtRestHooks`, or the codec would abandon its inline seal path for a
 * feature that never seals record fields. The routing/compaction/TTL/
 * legal-hold/exportBlobs machinery stays service-side in
 * `with-shape/blobs/` (the i18n-dictionary precedent — that machinery
 * does real chunk AEAD + key-lifecycle work `via-enclave-isolation`
 * forbids under `shape/via-*`).
 *
 * Like classified (see `port/with/classified-strategy.ts`), the link is
 * EAGER — `port/with/blob-strategy.ts` calls {@link linkBlobVia} at module
 * load. `blobFields` policies are plain object literals (there is no
 * `blob.*()` declaration factory to hang a lazy link on), so the binder
 * must be installed before `compileViaBindings` ever sees one.
 *
 * There is no `declare`-time validation: `blobFields` has never had a
 * construction-time refusal matrix (policies are consulted lazily by
 * `vault.compact()` and `BlobSet.put`), and inventing one here would
 * break the behavior lock.
 */
import type { ViaBinding, ViaEraseCtx, ViaEraseReport } from '../../kernel/via.js'
import { installViaBinder } from '../../kernel/via.js'
import type { BlobFieldsConfig } from '../../with-shape/blobs/blob-compaction.js'

/**
 * Config a blob collection's `blobFields` declaration resolves to — the
 * binding's construction input. `purgeBlobsForRecord` is an OPTIONAL
 * vault/service-provided closure for the `erase` hook — undefined in this
 * task (no caller wires it yet), wired for real in #629 Task 10 ("posture
 * enforcement — forget + erase hooks live"), where it wraps the existing
 * `collection.blob(id).shredAllForRecord()` participation (`vault.forget()`'s
 * per-ref blob purge) and owns mapping its shredded/retainedShared/residue
 * accounting onto the report shape byte-identically to today's ledger entry.
 */
export interface BlobViaConfig {
  readonly fields: BlobFieldsConfig
  readonly collectionName: string
  /** Purge one record's blob slots (crypto-shred participation). Returns the erase report for `forget()`'s summary. */
  readonly purgeBlobsForRecord?: (id: string) => Promise<ViaEraseReport>
}

/**
 * `forget()`'s per-ref blob-purge participation: delegate to the wired
 * closure, or report a clean zero-shredded, zero-residue no-op until
 * Task 10 supplies one (mirrors the classified binding's dormant-erase
 * precedent).
 */
async function eraseBlobs(ctx: ViaEraseCtx, cfg: BlobViaConfig): Promise<ViaEraseReport> {
  if (cfg.purgeBlobsForRecord) return cfg.purgeBlobsForRecord(ctx.id)
  return { shredded: 0, residue: [] }
}

/**
 * `{ blobFields: { <field>: <knobs> } }` — declarative scalars
 * (`retainDays`/`external`/`public`/`backlink`) verbatim; predicate knobs
 * (`evictWhen`/`legalHold`/`retainUntil` — functions over the decrypted
 * record) as presence flags, since a predicate has no serializable form.
 */
function buildBlobDescribeFragment(fields: BlobFieldsConfig): Record<string, unknown> {
  return {
    blobFields: Object.fromEntries(
      Object.entries(fields).map(([field, p]) => [field, {
        ...(p.retainDays !== undefined ? { retainDays: p.retainDays } : {}),
        ...(p.evictWhen !== undefined ? { evictWhen: true } : {}),
        ...(p.legalHold !== undefined ? { legalHold: true } : {}),
        ...(p.retainUntil !== undefined ? { retainUntil: true } : {}),
        ...(p.external === true ? { external: true } : {}),
        ...(p.public === true ? { public: true } : {}),
        ...(p.backlink !== undefined ? { backlink: p.backlink } : {}),
      }]),
    ),
  }
}

export function blobBinding(cfg: BlobViaConfig): ViaBinding {
  return {
    brand: 'blob',
    // encryptedAtRest: 'envelope' — blob chunks are AEAD-encrypted envelopes
    // in `_blob_chunks` (service-side), not sealed record fields; queryable:
    // 'none' — nothing indexes blob content; exportable — vault.exportBlobs()
    // is a first-class door; forgettable — shredAllForRecord participates in
    // vault.forget().
    posture: { encryptedAtRest: 'envelope', queryable: 'none', exportable: true, forgettable: true },
    erase: (ctx) => eraseBlobs(ctx, cfg),
    describeFragment: () => buildBlobDescribeFragment(cfg.fields),
  }
}

export function linkBlobVia(): void {
  installViaBinder('blob', (c) => blobBinding(c as BlobViaConfig))
}
