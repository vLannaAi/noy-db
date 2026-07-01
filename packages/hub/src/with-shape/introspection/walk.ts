/**
 * Orchestrate the structural walk of a Vault, producing a
 * {@link VaultSchemaSnapshot}. Called from `Vault.dumpSchema()`.
 *
 * @module
 */

import { derivePersistedSchema } from '../persisted-schemas/derive.js'
import { loadPersistedSchema } from '../persisted-schemas/storage.js'
import { jsonSchemaToFields } from './fields.js'
import type {
  CollectionConfig,
  CollectionDescriptor,
  CollectionStats,
  DumpSchemaOptions,
  FieldDescriptor,
  InternalCollectionStats,
  MaterializedViewDescriptor,
  OverlayViewDescriptor,
  DerivationDescriptor,
  VaultSchemaSnapshot,
} from './types.js'
import type { Collection } from '../../collection.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import type { RefRegistry } from '../../refs.js'
import type { VaultMeta } from './meta.js'

/**
 * The minimal slice of Vault internal state the walker needs.
 * Exposed via `vault._introspectState()` to keep the public Vault
 * surface narrow.
 *
 * @internal
 */
export interface VaultIntrospectState {
  readonly name: string
  readonly adapter: NoydbStore
  readonly collectionCache: Map<string, Collection<unknown>>
  readonly refRegistry: RefRegistry
  readonly getDEK: (collectionName: string) => Promise<CryptoKey>
  /** The active unlocked keyring — role/permissions/userId for access-scoped ops. */
  readonly keyring: UnlockedKeyring
  readonly subsystems: Record<string, boolean>
  /** Vault-level descriptive metadata, when set via `openVault({meta})`. */
  readonly vaultMeta?: VaultMeta
  // Typed loosely on purpose — these are private subsystem registries
  // accessed only for "is anything registered" enumeration.
  readonly mvRegistry: unknown
  readonly overlayRegistry: unknown
  readonly derivationRegistry: unknown
  /**
   * Returns the registered schema-update strategy names for a collection,
   * or `undefined` when none are registered. Populated from
   * `vault.#schemaUpdateNames` in `_introspectState()`.
   */
  readonly getCollectionSchemaUpdateNames?: (col: string) => readonly string[] | undefined
  /**
   * Returns `true` when the collection has an archive policy registered
   * in `vault.archiveRegistry`, `false` otherwise. Populated from
   * `vault.archiveRegistry` in `_introspectState()`.
   */
  readonly hasCollectionArchive?: (col: string) => boolean
}

const INTERNAL_PREFIX = '_'

/** Reserved internal collections always present in any real vault. */
const KNOWN_INTERNAL_NAMES = ['_keyring', '_ledger', '_meta', '_schemas', '_deltas']

export async function dumpVaultSchema(
  vault: { _introspectState(): VaultIntrospectState },
  opts: DumpSchemaOptions,
): Promise<VaultSchemaSnapshot> {
  const state = vault._introspectState()
  const sampleSize = opts.sampleSize ?? 50
  const withStats = opts.withStats === true

  // 1. User-facing collections — alphabetical for diff stability
  const cacheNames = [...state.collectionCache.keys()]
  const storageNames = (await safeListAllCollections(state.adapter, state.name))
    .filter((n) => !n.startsWith(INTERNAL_PREFIX))
  const allNames = Array.from(new Set([...cacheNames, ...storageNames])).sort()

  const collections: Record<string, CollectionDescriptor> = {}
  for (const name of allNames) {
    collections[name] = await describeCollection(state, name, sampleSize, withStats)
  }

  // 2. Materialized views (placeholder — real walk in MV slice 2 follow-up)
  const materializedViews = describeMVs(state.mvRegistry)
  // 3. Overlay views
  const overlayViews = describeOverlays(state.overlayRegistry)
  // 4. Derivations
  const derivations = describeDerivations(state.derivationRegistry)

  // 5. Internal collections — only with stats
  let internal: Record<string, InternalCollectionStats> | undefined
  if (withStats) {
    internal = {}
    for (const name of KNOWN_INTERNAL_NAMES) {
      const stats = await statsForCollection(state.adapter, state.name, name)
      if (stats.records > 0) {
        internal[name] = { records: stats.records, bytes: stats.bytes }
      }
    }
  }

  const snap: VaultSchemaSnapshot = {
    _noydb_snapshot: 1,
    vault: state.name,
    emittedAt: new Date().toISOString(),
    subsystems: state.subsystems,
    ...(state.vaultMeta !== undefined ? { meta: state.vaultMeta } : {}),
    collections,
    materializedViews,
    overlayViews,
    derivations,
    ...(internal !== undefined ? { internal } : {}),
  }
  return snap
}

async function safeListAllCollections(adapter: NoydbStore, vault: string): Promise<string[]> {
  try {
    const snap = await adapter.loadAll(vault)
    return Object.keys(snap)
  } catch {
    return []
  }
}

async function describeCollection(
  state: VaultIntrospectState,
  collectionName: string,
  sampleSize: number,
  withStats: boolean,
): Promise<CollectionDescriptor> {
  let fields: Record<string, FieldDescriptor> = {}
  let validator: CollectionDescriptor['validator']

  const refsRaw = state.refRegistry.getOutbound(collectionName)
  const refs: CollectionDescriptor['refs'] = {}
  for (const [name, desc] of Object.entries(refsRaw)) {
    refs[name] = { target: desc.target, mode: desc.mode }
  }

  // 1. Try the persisted Route B envelope first.
  try {
    const dek = await state.getDEK(collectionName)
    const persisted = await loadPersistedSchema(state.adapter, state.name, collectionName, dek)
    if (persisted) {
      validator = { kind: persisted.kind, source: 'persisted' }
      if (persisted.jsonSchema) {
        fields = jsonSchemaToFields(persisted.jsonSchema, 'persisted', refsRaw)
      }
    }
  } catch {
    // No DEK or decrypt failure — fall through to live-validator
  }

  const liveColl = state.collectionCache.get(collectionName)

  // 2. Try the live in-process validator (when no persisted envelope).
  if (!validator) {
    const schema = liveColl?.getSchema()
    if (schema) {
      try {
        const derived = await derivePersistedSchema(schema)
        validator = { kind: derived.kind, source: 'live-validator' }
        if (derived.jsonSchema) {
          fields = jsonSchemaToFields(derived.jsonSchema, 'live-validator', refsRaw)
        }
      } catch {
        // Derivation failed (e.g. missing peer-dep) — silently leave fields empty
      }
    }
  }

  // 3. Sampling fallback — deferred to a follow-up. For now: empty when no schema.
  if (Object.keys(fields).length === 0 && sampleSize > 0) {
    // Sampling path not implemented in baseline slice 2; reserved for follow-up.
  }

  // Populate collection-level meta and config from the live collection when available.
  const collMeta = liveColl?.getMeta()
  const collConfig = liveColl?.getConfig()

  // Thread vault-level config (archive + schemaUpdate) that the Collection cannot see.
  const archivePresent = state.hasCollectionArchive?.(collectionName) === true
  const schemaUpdateNames = state.getCollectionSchemaUpdateNames?.(collectionName)
  const hasSchemaUpdate = schemaUpdateNames !== undefined && schemaUpdateNames.length > 0

  // Merge Collection-level config with vault-level fields. Omit config entirely
  // when all sources are empty.
  let mergedConfig: CollectionConfig | undefined
  if (collConfig !== undefined || archivePresent || hasSchemaUpdate) {
    mergedConfig = {
      ...(collConfig ?? {}),
      ...(archivePresent ? { archive: true as const } : {}),
      ...(hasSchemaUpdate ? { schemaUpdate: schemaUpdateNames } : {}),
    }
  }

  const descriptor: CollectionDescriptor = {
    fields,
    indexes: [],
    refs,
    ...(validator ? { validator } : {}),
    ...(collMeta !== undefined ? { meta: collMeta } : {}),
    ...(mergedConfig !== undefined ? { config: mergedConfig } : {}),
  }
  if (withStats) {
    const stats = await statsForCollection(state.adapter, state.name, collectionName)
    ;(descriptor as { stats?: CollectionStats }).stats = stats
  }
  return descriptor
}

async function statsForCollection(
  adapter: NoydbStore,
  vault: string,
  collection: string,
): Promise<CollectionStats> {
  const ids = await adapter.list(vault, collection)
  if (ids.length === 0) {
    return { records: 0, bytes: 0, bytesAvg: 0, bytesMin: 0, bytesMax: 0, oldest: '', newest: '' }
  }
  let total = 0
  let min = Number.POSITIVE_INFINITY
  let max = 0
  let oldest = '￿'
  let newest = ''
  for (const id of ids) {
    const env = await adapter.get(vault, collection, id)
    if (!env) continue
    const size = env._data.length
    total += size
    if (size < min) min = size
    if (size > max) max = size
    if (env._ts < oldest) oldest = env._ts
    if (env._ts > newest) newest = env._ts
  }
  return {
    records: ids.length,
    bytes: total,
    bytesAvg: Math.round(total / ids.length),
    bytesMin: min === Number.POSITIVE_INFINITY ? 0 : min,
    bytesMax: max,
    oldest: oldest === '￿' ? '' : oldest,
    newest,
  }
}

function describeMVs(registry: unknown): Record<string, MaterializedViewDescriptor> {
  if (!registry || typeof registry !== 'object') return {}
  const items = listFromRegistry(registry as Record<string, unknown>)
  const out: Record<string, MaterializedViewDescriptor> = {}
  // Each item is RegisteredMV { spec, dependencies, outputCollection, ... }
  for (const item of items) {
    const reg = item as {
      spec?: {
        name?: string
        unionSources?: ReadonlyArray<{ collection: string }>
        groupBy?: string | ReadonlyArray<string>
        aggregate?: Record<string, unknown>
        refresh?: string
      }
      dependencies?: ReadonlySet<string>
    }
    const spec = reg.spec
    if (!spec?.name) continue
    const sources = spec.unionSources
      ? spec.unionSources.map((u) => u.collection)
      : (reg.dependencies ? [...reg.dependencies].sort() : [])
    const groupBy = spec.groupBy
      ? Array.isArray(spec.groupBy) ? [...spec.groupBy] : [spec.groupBy]
      : undefined
    const aggregate = spec.aggregate ? Object.fromEntries(
      Object.entries(spec.aggregate).map(([k, v]) => [k, summariseAggregateOp(v)]),
    ) : undefined
    out[spec.name] = {
      sources,
      ...(groupBy ? { groupBy } : {}),
      ...(aggregate ? { aggregate } : {}),
      refresh: spec.refresh ?? 'eager',
    }
  }
  return out
}

function describeOverlays(registry: unknown): Record<string, OverlayViewDescriptor> {
  if (!registry || typeof registry !== 'object') return {}
  const specs = listFromRegistry(registry as Record<string, unknown>)
  const out: Record<string, OverlayViewDescriptor> = {}
  for (const spec of specs) {
    const s = spec as { name?: string; base?: string; overlay?: string }
    if (!s.name || !s.base || !s.overlay) continue
    out[s.name] = { base: s.base, overlay: s.overlay }
  }
  return out
}

function describeDerivations(registry: unknown): Record<string, DerivationDescriptor> {
  if (!registry || typeof registry !== 'object') return {}
  const items = listFromRegistry(registry as Record<string, unknown>)
  const out: Record<string, DerivationDescriptor> = {}
  for (const item of items) {
    // `all()` on DerivationRegistry returns RegisteredStrategy objects:
    // { spec: DerivationStrategy, strategyHash }. Read `spec` and fall
    // back to the item itself for forward-compat with other registries.
    const reg = item as { spec?: { source?: string; outputs?: Record<string, { collection: string }> }; source?: string; outputs?: Record<string, { collection: string }> }
    const s = reg.spec ?? reg
    if (!s.source) continue
    const outputCollections = s.outputs
      ? Object.values(s.outputs).map((o) => (o as { collection: string }).collection)
      : []
    // Key by sorted output-collection names so co-sourced derivations don't
    // collide. A single-output derivation keys as just that collection name
    // (e.g. 'billSummary'); multi-output keys as sorted join (e.g. 'a+b').
    // Falls back to source when no outputs are declared (defensive).
    const key = outputCollections.length > 0
      ? [...outputCollections].sort().join('+')
      : s.source
    out[key] = {
      source: s.source,
      outputs: outputCollections,
    }
  }
  return out
}

function listFromRegistry(reg: Record<string, unknown>): readonly unknown[] {
  // Registries expose different accessor methods; try the common ones.
  for (const method of ['all', 'list', 'specs', 'values']) {
    const fn = reg[method]
    if (typeof fn === 'function') {
      try {
        const out = (fn as () => unknown).call(reg)
        if (Array.isArray(out)) return out
        if (out && typeof (out as { values?: () => unknown }).values === 'function') {
          return [...(out as { values: () => Iterable<unknown> }).values()]
        }
      } catch {
        continue
      }
    }
  }
  return []
}

function summariseAggregateOp(value: unknown): string {
  if (value && typeof value === 'object') {
    const op = (value as { op?: string; kind?: string; field?: string }).op
      ?? (value as { kind?: string }).kind
    const field = (value as { field?: string }).field
    if (op && field) return `${op}(${field})`
    if (op) return op
  }
  return String(value)
}
