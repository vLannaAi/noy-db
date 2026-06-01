import type {
  Noydb,
  Vault,
  WriteEvent,
  AccessibleVault,
  FieldDescriptor,
} from '@noy-db/hub'

/** Top-level accessible-vault entry (plain projection of the hub's AccessibleVault). */
export type VaultInfo = AccessibleVault // { id: string; role: Role }

/** One collection in a snapshot — a flattened projection of the hub's CollectionDescriptor. */
export interface InspectorCollection {
  readonly name: string
  readonly fields: Record<string, FieldDescriptor>
  readonly indexes: ReadonlyArray<{ readonly fields: ReadonlyArray<string>; readonly unique?: boolean }>
  readonly refs: Record<string, { readonly target: string; readonly mode: 'strict' | 'warn' | 'cascade' }>
  readonly stats?: {
    readonly records: number
    readonly bytes: number
    readonly bytesAvg: number
    readonly oldest: string
    readonly newest: string
  }
}

/** Structure + stats for one open vault. */
export interface InspectorSnapshot {
  readonly vault: string
  readonly collections: ReadonlyArray<InspectorCollection>
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
  pendingWrites(): PendingWrites
}

/** @internal — the hub handle the inspector reads from. */
export type InspectorNoydb = Noydb
