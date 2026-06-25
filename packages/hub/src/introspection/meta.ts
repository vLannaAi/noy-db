/**
 * Descriptive metadata for the collection and vault levels of the metadata
 * ladder (field level = FieldMeta). Identity, not structure: label /
 * description / icon only. Descriptive, never prescriptive.
 * @module
 */

/** A collection's own descriptive metadata. */
export interface CollectionMeta {
  /** Friendly name; falls back to the humanized collection name. */
  label?: string
  description?: string
  /** Semantic icon NAME (e.g. a Lucide key), not styling. */
  icon?: string
  /** Plural form for list headers ("Invoice" → "Invoices"). */
  pluralLabel?: string
}

/** A vault's own descriptive metadata. */
export interface VaultMeta {
  label?: string
  description?: string
  icon?: string
}
