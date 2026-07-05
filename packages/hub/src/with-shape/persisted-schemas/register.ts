/**
 * Orchestrate the derive → hash → skip-or-write cycle for a collection's
 * persisted JSON Schema. Called by the Vault at collection-registration
 * time when the developer opts in via `collection({ persistJsonSchema:
 * true })`.
 *
 * Skip semantics:
 *
 *   - Zod validators: skip when the new hash equals the stored hash.
 *   - Non-Zod (stub envelopes have hash=null): skip when the stored
 *     envelope's `kind` matches the freshly-detected kind (since there's
 *     no body to compare yet — a kind change is the only signal).
 *
 * @module
 */

import { derivePersistedSchema } from './derive.js'
import { loadPersistedSchemaEntry, savePersistedSchema } from './storage.js'
import { computeSchemaDelta } from '../schema-update/delta.js'
import { evaluateStrategies } from '../schema-update/dispatch.js'
import { ConflictError } from '../../kernel/errors.js'
import type { SchemaUpdateStrategy, UpdateDecision } from '../schema-update/types.js'
import type { NoydbStore, ClassifiedMarker } from '../../kernel/types.js'
import type { PersistedSchemaEnvelope } from './types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'

/**
 * Max optimistic-CAS retries for the shared `_schemas/<collection>` record
 * (#583). Only two writers ever contend (the JSON-Schema writer and the
 * classified-marker writer), so one retry suffices; the headroom covers a
 * pathological re-order. Exhausting it rethrows the {@link ConflictError}
 * rather than silently losing a write.
 */
const MAX_SCHEMA_CAS_RETRIES = 5

export interface PersistSchemaResult {
  /** True when a fresh envelope was written to storage. */
  readonly written: boolean
  /** True when an existing envelope matched and the write was skipped. */
  readonly skipped: boolean
  /** The envelope that was either written or matched. */
  readonly envelope: PersistedSchemaEnvelope
  /** The update-strategy decision, present when strategies ran. */
  readonly decision?: UpdateDecision
}

export async function persistSchemaIfNeeded(opts: {
  readonly store: NoydbStore
  readonly vault: string
  readonly collectionName: string
  readonly validator: unknown
  readonly dek: EnclaveKey
  readonly strategies?: readonly SchemaUpdateStrategy[]
}): Promise<PersistSchemaResult> {
  const fresh = await derivePersistedSchema(opts.validator)

  // The `_schemas/<collection>` record is shared with the classified-marker
  // writer, so a plain load→save loses whichever writer put first (#583). Read
  // the version at load time and CAS on it; on conflict re-read (picking up the
  // other writer's field), re-evaluate, and retry.
  for (let attempt = 0; ; attempt++) {
    const { version, payload: stored } = await loadPersistedSchemaEntry(
      opts.store, opts.vault, opts.collectionName, opts.dek,
    )

    if (stored && isEquivalent(stored, fresh)) {
      return { written: false, skipped: true, envelope: stored, decision: { action: 'allow' } }
    }

    // Changed (or first registration). Run update strategies only when we
    // have a comparable JSON-Schema baseline and strategies were registered.
    let decision: UpdateDecision = { action: 'allow' }
    const strategies = opts.strategies ?? []
    if (
      stored &&
      strategies.length > 0 &&
      stored.kind === fresh.kind &&
      isPlainObject(stored.jsonSchema) &&
      isPlainObject(fresh.jsonSchema)
    ) {
      const delta = computeSchemaDelta(stored.jsonSchema, fresh.jsonSchema, opts.collectionName)
      decision = await evaluateStrategies(delta, strategies, { collection: opts.collectionName })
    }

    if (decision.action !== 'allow') {
      // reject (or cutover): do NOT overwrite the baseline — the
      // old schema stays the source of truth until the change is resolved.
      return { written: false, skipped: false, envelope: stored ?? fresh, decision }
    }

    // Preserve a previously-persisted classified marker (C-A / R10) — the schema
    // derivation knows nothing about it, so a naive overwrite here would drop the
    // config-drift guard's cross-session signal.
    const toSave: PersistedSchemaEnvelope =
      stored?.classified !== undefined ? { ...fresh, classified: stored.classified } : fresh
    try {
      await savePersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek, toSave, version)
      return { written: true, skipped: false, envelope: toSave, decision }
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_SCHEMA_CAS_RETRIES) continue
      throw err
    }
  }
}

/**
 * Persist (or refresh) the C-A / R10 classified marker into the collection's
 * `_schemas/<collection>` record, preserving any existing derived JSON-Schema
 * body. Idempotent — a no-op when an equivalent marker is already stored.
 * Independent of `persistJsonSchema`: called on the first classified write so a
 * later naive handle can detect the drift cross-session.
 */
export async function persistClassifiedMarker(opts: {
  readonly store: NoydbStore
  readonly vault: string
  readonly collectionName: string
  readonly dek: EnclaveKey
  readonly marker: ClassifiedMarker
}): Promise<void> {
  // Shares the `_schemas/<collection>` record with the JSON-Schema writer;
  // CAS on the loaded version so a concurrent schema (re)registration can't
  // silently drop the marker (and vice-versa) — see #583.
  for (let attempt = 0; ; attempt++) {
    const { version, payload: stored } = await loadPersistedSchemaEntry(
      opts.store, opts.vault, opts.collectionName, opts.dek,
    )
    if (stored?.classified !== undefined && markersEqual(stored.classified, opts.marker)) return
    const payload: PersistedSchemaEnvelope =
      stored !== undefined
        ? { ...stored, classified: opts.marker }
        : {
            _noydb_schema: 1,
            kind: 'Unknown',
            jsonSchema: null,
            hash: null,
            derivedAt: new Date().toISOString(),
            classified: opts.marker,
          }
    try {
      await savePersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek, payload, version)
      return
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_SCHEMA_CAS_RETRIES) continue
      throw err
    }
  }
}

function markersEqual(a: ClassifiedMarker, b: ClassifiedMarker): boolean {
  return sameSet(a.digestOnly, b.digestOnly) && sameSet(a.equatable, b.equatable)
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

function isPlainObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isEquivalent(a: PersistedSchemaEnvelope, b: PersistedSchemaEnvelope): boolean {
  if (a.kind !== b.kind) return false
  // Zod path: real hashes — compare directly.
  if (a.hash && b.hash) return a.hash === b.hash
  // Stub path: both have hash=null. Kind equality is the only signal we have.
  if (a.hash === null && b.hash === null) return true
  // Mixed (one has a hash, the other doesn't) — treat as changed.
  return false
}
