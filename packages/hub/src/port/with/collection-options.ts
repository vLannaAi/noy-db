/**
 * Options for `Vault.collection()` — opening or declaring a collection (#841).
 *
 * ## Why this lives on the port
 *
 * The shape references descriptor types owned by services — `EmbeddingDescriptor`
 * (`with-lookup`), `ComputedFields` (`with-formula`), `FieldMeta` (`with-shape`) —
 * so it cannot sit in `kernel/`: `port-layering` forbids the spine from
 * statically importing a `with-*` service, and the grandfathered lists are
 * frozen per file. `port/with/` is the seam that exists for exactly this, and
 * port files may reach services freely — the same reasoning that placed the
 * strategy table here in #838.
 *
 * @internal
 */

import type { CacheOptions } from '../../kernel/collection.js'
import type { RefDescriptor } from '../../kernel/refs.js'
import type { StandardSchemaV1 } from '../../kernel/schema.js'
import type { ConflictPolicy, HistoryConfig, IndexDefFor, IndexFieldName, MoneyFieldsOpt, SensitiveOpt, TierMode } from '../../kernel/types.js'
import type { ViaFieldSpec } from '../../kernel/via/compose.js'
import type { ClassifiedEntry } from '../../port/with/classified-strategy.js'
import type { CrdtMode } from '../../with-commit/crdt/crdt.js'
import type { ComputedFields } from '../../with-formula/computed/index.js'
import type { EmbeddingDescriptor } from '../../with-lookup/embeddings/index.js'
import type { BlobFieldsConfig } from '../../with-shape/blobs/blob-compaction.js'
import type { FieldMeta } from '../../with-shape/introspection/field-meta.js'
import type { CollectionMeta } from '../../with-shape/introspection/meta.js'
import type { DictKeyDescriptor, I18nTextDescriptor, StaticDictDescriptor } from './i18n-strategy.js'
import type { LookupDescriptor } from '../../via/lookup/descriptor.js'
import type { ArchivePolicy } from '../../with-fork/archive/index.js'
import type { SchemaUpdateStrategy } from '../../with-shape/schema-update/types.js'
import type { AttestationFieldSchema } from '@noy-db/attestation'

/**
 * Options for {@link Vault.collection} — opening or declaring a collection.
 *
 * Extracted from a 124-line inline literal (#841). Naming it lets consumers
 * annotate a call, lets `describe()` reuse the shape, and means a new option
 * is one edit here rather than an edit buried in the middle of a 534-line
 * method.
 *
 * Named `OpenCollectionOptions`, not `CollectionOptions` as the issue
 * suggested, to keep a clear gap from the existing `CollectionOpts` in
 * `collection-config.ts` — that one is the `Collection` CONSTRUCTOR's input,
 * built from this one. A one-character difference between two adjacent
 * config types is exactly the wart #844 is about.
 */
export interface OpenCollectionOptions<
  T,
  S extends keyof T & string = never,
  Q extends keyof T & string = never,
  M extends keyof T & string = never,
> {
  indexes?: readonly IndexDefFor<IndexFieldName<T, S, Q>>[]
  /** — auto-reconcile policy for persisted-index drift. */
  reconcileOnOpen?: 'off' | 'dry-run' | 'auto'
  prefetch?: boolean
  cache?: CacheOptions
  schema?: StandardSchemaV1<unknown, T>
  refs?: Record<string, RefDescriptor>
  /** — declare i18nText fields for locale-aware reads. */
  i18nFields?: Record<string, I18nTextDescriptor>
  /** — embedding config for write-time vector derivation + semantic retrieval. */
  embeddings?: EmbeddingDescriptor
  /** — string fields exposed to client-side `retrieve()`. */
  textIndexes?: readonly IndexFieldName<T, S>[]
  /** — the subset of `textIndexes` that records token positions, enabling phrase
   *  (`"tax invoice"`) and proximity (`"tax invoice"~3`) clauses in `retrieve()`.
   *  OPT-IN because positions roughly double the index payload for the fields
   *  named — declare only the fields a phrase query will actually target. */
  textIndexPositions?: readonly IndexFieldName<T, S>[]
  /** — pre-build the lexical index on open (eager-only). */
  warmIndexOnOpen?: boolean
  /** — persist the lexical index as an opaque encrypted blob at `_ftindex/<name>`. */
  textIndexPersist?: boolean
  /** — declare dictKey / staticDict fields for label resolution on reads. */
  dictKeyFields?: Record<string, DictKeyDescriptor | StaticDictDescriptor>
  /** — declare lookup() / enumOf() / dict() fields (#650 Task 2 — the 'lookup' via binding's three tiers). */
  lookupFields?: Record<string, LookupDescriptor>
  /** Consumer-neutral per-field descriptors (label/unit/semanticType/sensitivity…). See collection.describe(). */
  fieldMeta?: Record<string, FieldMeta>
  /** The collection's own descriptive metadata (label/description/icon). See collection.describe(). */
  meta?: CollectionMeta
  /** — declare money() fields for currency-safe decimal storage/formatting. */
  moneyFields?: MoneyFieldsOpt<T, M>
  viaFields?: Record<string, ViaFieldSpec> // via() composed fields; merged with the money/i18n sugar keys (field in both throws)
  /** — declare computed scalar fields, evaluated on write (schema-owned). Each entry may be
   *  a plain `(record) => value` function, OR `{ fn, deps }` to declare source fields for
   *  taint propagation (#638 Task 7 — supersedes the retired `computedDeps` option). */
  computed?: ComputedFields<T>
  /** — declare classified() sensitive-field descriptors. See the classified-fields spec. */
  classifiedFields?: Record<string, ClassifiedEntry>
  /** — per-collection conflict resolution policy. */
  conflictPolicy?: ConflictPolicy<T>
  /** — CRDT mode for collaborative editing without conflicts. */
  crdt?: CrdtMode
  /**
   * declare deterministic-encryption fields for blind
   * equality search. See `Collection` constructor docs for the full
   * trade-off. Requires `acknowledgeDeterministicRisk: true`.
   */
  deterministicFields?: readonly IndexFieldName<T, S>[]
  /** — explicit ack that deterministic encryption leaks equality. */
  acknowledgeDeterministicRisk?: boolean
  /** — explicit ack for the classified `equatable` knob (R8 door). Required
   *  when any classified field declares `equatable: true`. */
  acknowledgeEquatableRisk?: boolean
  /**
   * — structural group-encryption. Fields sealed into their own
   * `_sealed[field]` envelope slot (per-field key), kept out of the open
   * `_data` blob. Default-off; byte-identical output when absent.
   */
  sensitive?: SensitiveOpt<T, S>
  /**
   * — per-record content-encryption keys. When `true`, every record
   * body is encrypted under a fresh per-record CEK wrapped under the
   * collection DEK (`_cek`), stable across versions. Foundation for
   * per-record erasure / record-scoped sealing. Off by
   * default; non-adopting collections take the legacy path unchanged.
   */
  perRecordKeys?: boolean
  satelliteOf?: string // satellite pairing (spec #591)
  fields?: readonly string[] // satellite routing table (required with satelliteOf)
  joined?: string // registers the joined handle (see vault.joined())
  /**
   * Per-record provenance tracking. When `true`, `put()` calls that
   * supply a `source` option stamp `_source` / `_sourceTs` onto the
   * unencrypted envelope metadata. Off by default.
   */
  provenance?: boolean
  /**
   * declarative blob retention / TTL policy per slot
   * name. Values are `{ retainDays?, evictWhen? }`. Evaluated only
   * when `vault.compact()` runs.
   */
  blobFields?: BlobFieldsConfig<T>; blobTierPolicy?: 'isolate' | 'dedup' // — shared-blob rehome policy on tier move (#724/#741); default 'isolate'
  /** — declarative record archival policy: `{ archiveWhen, legalHold? }`. Evaluated when `vault.archive()` runs. */
  archive?: ArchivePolicy<T>
  /** — declared tiers for this collection. */
  tiers?: readonly number[]
  /**  — how lower-tier reads see above-tier records. */
  tierMode?: TierMode
  /**
   * Opt-in persisted JSON Schema. When `true` AND a Zod `schema` is
   * provided, hub derives a JSON Schema via `zod-to-json-schema`
   * (optional peer-dep) and writes an encrypted snapshot to
   * `_schemas/<collectionName>`. Re-runs on every open; hash-skip
   * avoids write churn when the schema is unchanged.
   *
   * Default: `false`. Non-Zod Standard Schema validators receive a
   * stub envelope flagging the kind without a JSON Schema body.
   *
   * @see design-history/2026-05-22-schema-dump-design.md
   */
  persistJsonSchema?: boolean
  /**
   * Ordered schema-update strategies. On a detected schema
   * change, evaluated in order; the first non-`allow` decision wins.
   * A `reject` is enforced at the write path (`put`/`delete` throw).
   * Requires `persistJsonSchema: true` (detection needs the baseline).
   */
  schemaUpdate?: readonly SchemaUpdateStrategy[]
  /** — declare the per-field schema for document attestation (issue side). */
  attestation?: AttestationFieldSchema
  /**
   * Per-collection history & tamper-ledger scoping. Overrides the
   * vault-wide `history` config for THIS collection only (wholesale, not
   * merged). `enabled: false` suppresses per-record snapshots for this
   * collection; `ledger: false` excludes its writes from the vault-wide
   * hash-chained tamper ledger. Lets you confine version snapshots +
   * tamper-evidence to the few collections where they carry legal weight,
   * without paying snapshot + ledger-entry-per-write across operational /
   * derived collections. Defaults to the vault-wide `history` config.
   */
  historyConfig?: HistoryConfig
  /**
   * Opt-in: keep the working set encrypted in RAM, decrypting on read (future phase).
   * Default false — the working set is plaintext.
   */
  ramCiphertext?: boolean
}
