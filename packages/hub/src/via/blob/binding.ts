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
 * forbids under `via/*`).
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
 *
 * `covers` (#629 Task 8) is a passive coverage predicate, not a pipeline
 * hook — it lets `ViaPipeline.postureFor` recognize a `blobFields` slot so
 * `.where()`/`.orderBy()`/`.aggregate()` can refuse it (posture
 * `queryable: 'none'`); it does not participate in clause building or
 * evaluation.
 */
import type { ViaBinding, ViaEraseCtx, ViaEraseReport } from '../../kernel/via/index.js'
import { installViaBinder } from '../../kernel/via/index.js'
import type { BlobFieldsConfig } from '../../with-shape/blobs/blob-compaction.js'

/**
 * Config a blob collection's `blobFields` declaration resolves to — the
 * binding's construction input. `purgeBlobsForRecord` is an OPTIONAL
 * vault/service-provided closure for the `erase` hook, mapping
 * `collection.blob(id).shredAllForRecord()`'s `{shredded, retainedShared,
 * residue}: string[]` accounting onto `ViaEraseReport` — `shredded`/
 * `retainedShared` become counts, each residue eTag becomes a tagged
 * `{kind: 'blob-residue', eTag}` entry.
 *
 * DELIBERATELY left unwired by `compileViaBindings` (#629 Task 10, resolved
 * within parity-first — see task-10-report.md "blob purge" section):
 * `per-blob-cek.test.ts`/`forget.test.ts` prove blob-shred-on-forget is
 * gated SOLELY on the vault's `blobsStrategy` being configured, never on a
 * given collection's OWN `blobFields` declaration (`.blob(id)` is callable,
 * and IS exercised by those tests, on collections with no `blobFields` at
 * all). Routing it exclusively through this binding would silently stop
 * blob crypto-shredding for every such collection; `vault.forget()` keeps
 * calling `collection.blob(id).shredAllForRecord()` directly for that
 * reason. The hook stays real/tested (see `blob-binding.test.ts`) for a
 * future caller that wants it.
 */
export interface BlobViaConfig {
  readonly fields: BlobFieldsConfig
  readonly collectionName: string
  /** Purge one record's blob slots (crypto-shred participation). Returns the erase report for `forget()`'s summary. */
  readonly purgeBlobsForRecord?: (id: string) => Promise<ViaEraseReport>
}

/**
 * `forget()`'s per-ref blob-purge participation: delegate to the wired
 * closure, or report a clean zero-shredded, zero-residue no-op — the
 * default in production too (#629 Task 10 deliberately leaves this unwired;
 * see `BlobViaConfig`'s doc comment).
 */
async function eraseBlobs(ctx: ViaEraseCtx, cfg: BlobViaConfig): Promise<ViaEraseReport> {
  if (cfg.purgeBlobsForRecord) return cfg.purgeBlobsForRecord(ctx.id)
  return { shredded: 0, residue: [] }
}

/**
 * One field's blob knobs as they appear on `describeFragment()`'s payload
 * (#657 — the second real `ViaBinding.describeFragment` consumer after
 * `lookup`'s; see `with-shape/introspection/describe.ts`'s `buildDescription`).
 * Declarative scalars (`retainDays`/`external`/`public`/`backlink`) verbatim;
 * predicate knobs (`evictWhen`/`legalHold`/`retainUntil` — functions over the
 * decrypted record) as presence flags, since a predicate has no serializable
 * form — mirrors `buildBlobDescribeFragment`'s per-field shape below.
 */
export interface BlobDescribeFragmentEntry {
  readonly retainDays?: number
  readonly evictWhen?: true
  readonly legalHold?: true
  readonly retainUntil?: true
  readonly external?: true
  readonly public?: true
  readonly backlink?: string
}

/** The `'blob'` binding's `describeFragment()` payload shape. */
export interface BlobDescribeFragment {
  readonly blobFields: Record<string, BlobDescribeFragmentEntry>
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
    covers: (field) => field in cfg.fields,
    erase: (ctx) => eraseBlobs(ctx, cfg),
    describeFragment: () => buildBlobDescribeFragment(cfg.fields),
  }
}

export function linkBlobVia(): void {
  installViaBinder('blob', (c) => blobBinding(c as BlobViaConfig))
}
