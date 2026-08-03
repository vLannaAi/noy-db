/**
 * The pod-wide **schema manifest** record type (#941).
 *
 * This is an INDEX, not a full-inline manifest: `SchemaManifest.collections`
 * carries per-collection *metadata* (generation / content hash / field ids),
 * never the JSON Schema body itself. The JSON Schema stays the source of
 * truth at `_schemas/<collection>`, encrypted under that collection's own
 * DEK (see `with-shape/persisted-schemas`). Inlining full schemas into one
 * pod-wide manifest record would either leak every collection's schema to a
 * principal scoped to a single collection, or force the manifest itself
 * onto a collection-DEK it has no business holding — the index preserves
 * per-collection DEK isolation while still giving a single place to answer
 * "what schema generation is this pod at, and does collection X's stored
 * schema match its declared content hash."
 *
 * `aggregateHash` binds the whole per-collection index's content: it is
 * `sha256Hex(canonicalJson(collections))`, so any change to any collection's
 * entry (a new generation, a changed hash, added/renamed field ids) changes
 * `aggregateHash` too. Canonical JSON (sorted object keys, no whitespace)
 * makes the hash independent of the map's key insertion order.
 *
 * @module
 */

/** Per-collection entry inside a {@link SchemaManifest}'s `collections` index. */
export interface SchemaManifestEntry {
  /** The vault-wide schema-fence generation this collection's schema was last written at. */
  readonly generation: number
  /** SHA-256 (hex) of the collection's canonicalised JSON Schema (see `persisted-schemas/derive.ts`). */
  readonly contentHash: string
  /** Stable per-field ids (#946), keyed by the field's current name. Absent when the collection has none. */
  readonly fieldIds?: Record<string, string>
}

/**
 * The pod-wide schema manifest — one record per pod, stored at
 * `_manifest/schema` (see `storage.ts`). An INDEX over the per-collection
 * `_schemas/<collection>` entries, not the schemas themselves.
 */
export interface SchemaManifest {
  readonly v: 1
  readonly kind: 'schema'
  /** Pod-wide schema-fence generation (`FenceDoc.currentSchemaVersion`) as of this manifest's derivation. */
  readonly generation: number
  /** Per-collection index: collection name → its manifest entry. */
  readonly collections: Record<string, SchemaManifestEntry>
  /** `sha256Hex(canonicalJson(collections))` — the pod-wide content binding over the index. */
  readonly aggregateHash: string
}

/** The record id the schema manifest is stored under inside `_manifest`. */
export const MANIFEST_SCHEMA_RECORD_ID = 'schema' as const
