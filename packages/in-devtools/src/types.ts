import type { Vault, WriteEvent, WriteConflict, WriteHook, Unsubscribe, WriteQueue, AccessibleVault, CollectionMeta, VaultMeta } from '@noy-db/hub'
import type { CollectionDescriptor, CollectionStats, CollectionConfig, DescribedField } from '@noy-db/hub/introspection'
import type { MeterSnapshot } from '@noy-db/to-meter'

/** Minimal structural view of a to-meter handle the inspector reads (no runtime dep). */
export interface InspectorMeter {
  snapshot(): MeterSnapshot
}

/** Top-level accessible-vault entry (plain projection of the hub's AccessibleVault). */
export type VaultInfo = AccessibleVault // { id: string; role: Role }

/**
 * One collection in a snapshot — a flattened projection of the hub's
 * CollectionDescriptor. Field/index/ref/stats shapes are derived directly from
 * the hub types so they never drift.
 */
export interface InspectorCollection {
  readonly name: string
  readonly fields: CollectionDescriptor['fields']
  readonly indexes: CollectionDescriptor['indexes']
  readonly refs: CollectionDescriptor['refs']
  readonly stats?: CollectionStats
  /** Collection-level descriptive metadata (label/description/icon). */
  readonly meta?: CollectionMeta
  /** Per-field rich descriptors from collection.describe() (label/widget/money/dict/…). */
  readonly described?: readonly DescribedField[]
  /** Collection-level configuration (textIndexes/embeddings/crdt/provenance/…). */
  readonly config?: CollectionConfig
}

/** Structure + stats for one open vault. */
export interface InspectorSnapshot {
  readonly vault: string
  readonly collections: ReadonlyArray<InspectorCollection>
  /** Vault-level descriptive metadata (label/description/icon). */
  readonly meta?: VaultMeta
}

/** A page of decrypted records from one collection. */
export interface RecordPage {
  readonly rows: ReadonlyArray<unknown>
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** Live write event surfaced to subscribers (the hub's public WriteEvent, unchanged — already plain). */
export type InspectorWriteEvent = WriteEvent

/** Write-conflict surfaced to conflict subscribers (the hub's public WriteConflict, unchanged — already plain). */
export type InspectorWriteConflict = WriteConflict

/** Pending-write state. */
export interface PendingWrites {
  readonly pending: boolean
  readonly depth: number
}

/** The read-only inspector facade returned by createInspector(). */
export interface Inspector {
  listVaults(): Promise<ReadonlyArray<VaultInfo>>
  snapshot(vault: Vault): Promise<InspectorSnapshot>
  records(vault: Vault, collection: string, opts?: { limit?: number; offset?: number }): Promise<RecordPage>
  subscribe(handler: (event: InspectorWriteEvent) => void): () => void
  subscribeConflicts(handler: (c: InspectorWriteConflict) => void): () => void
  pendingWrites(): PendingWrites
  /** Aggregate store-op latency snapshot, or null when the store is not metered. */
  meterSnapshot(): MeterSnapshot | null
}

/**
 * The container of vaults the inspector reads from. A `Noydb` satisfies this
 * verbatim; a klum `VaultGroup` adapter conforms structurally — so the inspector
 * works on a single instance OR a federation without importing either.
 */
export interface InspectableContainer {
  listAccessibleVaults(): Promise<readonly AccessibleVault[]>
  openVault(name: string): Promise<Vault>
  onAfterWrite(handler: WriteHook): Unsubscribe
  onWriteConflict(handler: (c: WriteConflict) => void): Unsubscribe
  readonly writeQueue: WriteQueue
}
