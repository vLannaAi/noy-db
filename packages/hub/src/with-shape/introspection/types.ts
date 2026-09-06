/**
 * Types for {@link VaultSchemaSnapshot} — the structured object returned
 * by `vault.dumpSchema()`. Consumed by the upcoming `noydb describe`
 * CLI to emit human-readable YAML/JSON audit output.
 *
 * @see design-history/2026-05-22-schema-dump-design.md
 *
 * @module
 */

import type { PersistedSchemaKind } from '../persisted-schemas/types.js'
import type { Permission } from '../../kernel/types.js'
import type { CollectionMeta, VaultMeta } from './meta.js'

/** Flat snapshot of a vault's registered schema. */
export interface SchemaIntrospection {
  readonly collections: ReadonlyArray<{ name: string; docCount: number }>
  readonly guards: ReadonlyArray<{ collection: string; count: number }>
  readonly materializedViews: ReadonlyArray<{ name: string; sourceCollections: string[] }>
  readonly schemaUpdate: ReadonlyArray<{ collection: string; strategies: string[] }>
  readonly grants: ReadonlyArray<{ collection: string; permission: Permission }>
}

/** Where the field-level info in the snapshot came from. */
export type FieldSource = 'persisted' | 'live-validator' | 'sampled' | 'unknown'

export interface FieldDescriptor {
  /** Inferred type tag: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'null' | 'opaque'. */
  readonly type: string
  /** Where this field info was sourced from. */
  readonly source: FieldSource
  /** Optional constraints — minLength, maxLength, enum values, gt, etc. */
  readonly constraints?: Record<string, unknown>
  /** True when the schema marks this field optional. */
  readonly optional?: boolean
  /** Foreign-key target as `<collection>.<field>` when declared. */
  readonly references?: string
  /**
   * Read-shape sensitivity, declared as `FieldMeta.bulk` (#1363). Present only
   * when the collection is live in this process (the declaration lives in the
   * `fieldMeta` channel, which is not persisted with the schema).
   *
   * ⚠️ Telemetry, never a control: it tells a coverage sensor which
   * collections have a corpus worth accounting for. Against an insider holding
   * the device and local keys it prevents nothing — key custody does.
   */
  readonly bulk?: 'sensitive'
}

export interface CollectionStats {
  readonly records: number
  readonly bytes: number
  readonly bytesAvg: number
  readonly bytesMin: number
  readonly bytesMax: number
  /** ISO-8601 from min(_ts) across envelopes. Empty string when no records. */
  readonly oldest: string
  /** ISO-8601 from max(_ts) across envelopes. Empty string when no records. */
  readonly newest: string
}

/**
 * Collection-level configuration options surfaced by `dumpSchema()`.
 * Only fields that are actively configured are present; the object is
 * omitted entirely from `CollectionDescriptor.config` when nothing is set.
 * Reused by Task 5 in-devtools display.
 */
export interface CollectionConfig {
  readonly i18nFields?: readonly string[]
  readonly embeddings?: { readonly source: string | readonly string[]; readonly dim: number; readonly model?: string }
  readonly textIndexes?: readonly string[]
  readonly textIndexPersist?: boolean
  readonly perRecordKeys?: boolean
  readonly provenance?: boolean
  readonly tiers?: readonly number[]
  readonly tierMode?: string
  readonly crdt?: string
  /**
   * `true` when history is explicitly enabled for this collection.
   * Omitted when history is not configured or when the default vault-wide
   * setting applies without explicit per-collection configuration.
   */
  readonly history?: boolean
  /**
   * Present when the collection is registered in `vault.archiveRegistry`
   * (i.e. an archive policy was declared). `true` = archive policy present.
   */
  readonly archive?: boolean
  /**
   * Strategy names registered for schema updates on this collection.
   * Present only when at least one strategy is registered.
   */
  readonly schemaUpdate?: readonly string[]
  // conflictPolicy omitted: consumed at construction, no retained state to surface.
}

export interface CollectionDescriptor {
  readonly fields: Record<string, FieldDescriptor>
  readonly indexes: ReadonlyArray<{ readonly fields: ReadonlyArray<string>; readonly unique?: boolean }>
  readonly refs: Record<string, { readonly target: string; readonly mode: 'strict' | 'warn' | 'cascade'; readonly isArray?: true }>
  readonly validator?: {
    readonly kind: PersistedSchemaKind
    readonly source: 'persisted' | 'live-validator'
  }
  readonly stats?: CollectionStats
  readonly meta?: CollectionMeta
  readonly config?: CollectionConfig
  /**
   * #1447 — fields the datastore itself computes or resolves, as
   * `field → the via brands covering it` (`money`, `computed`, `i18n`,
   * `lookup`, `geo`, `classified`, `blob`). Absent when the collection
   * declares no via pipeline.
   *
   * Exists so a consumer can gate documentation against what the vault
   * actually enforces. The reported case: a rulebook described three
   * vault-computed fields as app-owned — the UNDERSTATING direction, which is
   * silent, because it produces app-side reimplementation of a guarantee that
   * already exists rather than a missing behaviour someone trips over.
   *
   * ⛔ Brand and field only. A binding's CONFIGURATION is deliberately absent:
   * a dump saying "this field is classified, sensitivity pii" is a map of the
   * columns worth attacking, in an artefact that by design leaves the vault.
   */
  readonly via?: Record<string, readonly string[]>
}

export interface MaterializedViewDescriptor {
  readonly sources: ReadonlyArray<string>
  readonly groupBy?: ReadonlyArray<string>
  readonly aggregate?: Record<string, string>
  readonly refresh: string
  readonly stats?: CollectionStats
}

export interface OverlayViewDescriptor {
  readonly base: string
  readonly overlay: string
}

export interface DerivationDescriptor {
  readonly source: string
  readonly outputs: ReadonlyArray<string>
  readonly name?: string
}

export interface InternalCollectionStats {
  readonly records: number
  readonly bytes: number
}

/**
 * A report section `dumpSchema()` is capable of emitting (#1447).
 *
 * ⛔ CAPABILITY OF THE EMITTER, NEVER CONTENT OF THIS DUMP. `reports` lists
 * what this hub *would* have reported, not what it found — a vault that
 * genuinely declares no via fields still lists `'via'`.
 *
 * That distinction is the entire point. A content-based list reintroduces the
 * ambiguity it exists to remove: a consumer could not tell "no via fields
 * here" from "this hub cannot report them", which is exactly how a
 * documentation gate switching to the live report passes VACUOUSLY on a hub
 * too old to answer. Measured by a consumer attempting that adoption.
 */
export type SnapshotReport = 'via' | 'stats'

export interface VaultSchemaSnapshot {
  readonly _noydb_snapshot: 2
  /**
   * Which report sections this snapshot's emitter can produce (#1447).
   *
   * Check this before concluding anything from an ABSENT section:
   *
   * ```ts
   * if (!snap.reports.includes('via')) throw new Error('hub cannot report via')
   * // only now is a missing `via` key evidence that a collection declares none
   * ```
   *
   * Required, and required deliberately: an optional field would leave
   * `undefined` meaning "old emitter", which is the same ambiguity one level up.
   * Every snapshot states what it can say.
   */
  readonly reports: readonly SnapshotReport[]
  readonly vault: string
  readonly emittedAt: string
  readonly subsystems: Record<string, boolean>
  readonly meta?: VaultMeta
  readonly collections: Record<string, CollectionDescriptor>
  readonly materializedViews: Record<string, MaterializedViewDescriptor>
  readonly overlayViews: Record<string, OverlayViewDescriptor>
  readonly derivations: Record<string, DerivationDescriptor>
  /** Only present when `dumpSchema({ withStats: true })` was called. */
  readonly internal?: Record<string, InternalCollectionStats>
}

export interface DumpSchemaOptions {
  /** When true, walk every collection's envelopes to compute counters. Default `false`. */
  readonly withStats?: boolean
  /** Sample N records per collection lacking a persisted/live schema. Default 50. `0` disables sampling. */
  readonly sampleSize?: number
}
