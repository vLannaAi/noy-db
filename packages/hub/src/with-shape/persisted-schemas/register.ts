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
import { resolveFieldIds } from './field-ids.js'
import { computeSchemaDelta } from '../schema-update/delta.js'
import { evaluateStrategies } from '../schema-update/dispatch.js'
import { loadFence, saveFence } from '../schema-update/fence.js'
import { isConflictError } from '../../kernel/errors.js'
import type { SchemaUpdateStrategy, UpdateDecision, SchemaDelta } from '../schema-update/types.js'
import type { NoydbStore, ClassifiedMarker } from '../../kernel/types.js'
import type { PersistedSchemaEnvelope } from './types.js'
import type { PairingMarker } from '../satellites/types.js'
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

    // Changed (or first registration). Compute the delta whenever we have a
    // comparable JSON-Schema baseline — independent of whether strategies
    // were registered (#946: the rename pairing it carries feeds the
    // fieldIds id-carry below even on a bare re-declare with no
    // `schemaUpdate` strategies configured). Strategies only run when
    // registered.
    let decision: UpdateDecision = { action: 'allow' }
    const strategies = opts.strategies ?? []
    let delta: SchemaDelta | undefined
    if (
      stored &&
      stored.kind === fresh.kind &&
      isPlainObject(stored.jsonSchema) &&
      isPlainObject(fresh.jsonSchema)
    ) {
      delta = computeSchemaDelta(stored.jsonSchema, fresh.jsonSchema, opts.collectionName)
      if (strategies.length > 0) {
        decision = await evaluateStrategies(delta, strategies, { collection: opts.collectionName })
      }
    }

    if (decision.action !== 'allow') {
      // reject (or cutover): do NOT overwrite the baseline — the
      // old schema stays the source of truth until the change is resolved.
      return { written: false, skipped: false, envelope: stored ?? fresh, decision }
    }

    // Preserve a previously-persisted classified marker (C-A / R10) and
    // satellite pairing marker (R-S9) — the schema derivation knows nothing
    // about them, so a naive overwrite here would drop the config-drift
    // guards' cross-session signals.
    let toSave: PersistedSchemaEnvelope = fresh
    if (stored?.classified !== undefined) toSave = { ...toSave, classified: stored.classified }
    if (stored?.satellite !== undefined) toSave = { ...toSave, satellite: stored.satellite }

    // #946: mint/preserve stable per-field ids (by name, carrying a
    // detected rename's id from its old name — see `delta.renamed`) and
    // stamp the vault-wide schema-fence generation this write happened at —
    // binds "generation N" to this envelope's content hash
    // (schemaFenceState() + loadPersistedSchema agree).
    const fieldIds = resolveFieldIds(fresh.jsonSchema, stored?.fieldIds, delta?.renamed)
    if (fieldIds !== undefined) toSave = { ...toSave, fieldIds }
    const fence = await loadFence(opts.store, opts.vault)
    toSave = { ...toSave, generation: fence.currentSchemaVersion }

    try {
      await savePersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek, toSave, version)
      if (toSave.hash !== null) {
        // This is the FIRST non-barrier writer to `_meta/schema-fence` —
        // previously only SchemaFenceController.#setState wrote it, and only
        // sequentially, under the drain barrier. There is no CAS on the fence
        // doc (out of scope to add here), so re-read it immediately before
        // writing rather than reusing the `fence` snapshot captured above
        // (before the potentially-slow `savePersistedSchema` call): spreading
        // a stale snapshot here would roll back `currentSchemaVersion`/
        // `fenceState` if a concurrent cutover (on a different collection)
        // advanced the fence in between — corrupting the vault-wide gate the
        // whole barrier + MigrationRequiredError check depends on. Re-reading
        // narrows (does not eliminate) that window to just this one overlay.
        const freshFence = await loadFence(opts.store, opts.vault)
        await saveFence(opts.store, opts.vault, { ...freshFence, schemaHash: toSave.hash })
      }
      return { written: true, skipped: false, envelope: toSave, decision }
    } catch (err) {
      if (isConflictError(err) && attempt < MAX_SCHEMA_CAS_RETRIES) continue
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
      if (isConflictError(err) && attempt < MAX_SCHEMA_CAS_RETRIES) continue
      throw err
    }
  }
}

/**
 * Persist (or refresh) the R-S9 satellite pairing marker into the collection's
 * `_schemas/<collection>` record, preserving any existing derived JSON-Schema
 * body. Idempotent — a no-op when an equivalent marker is already stored.
 * Independent of `persistJsonSchema`: called on satellite declaration so a
 * later divergent re-declaration can be detected cross-session.
 */
export async function persistSatelliteMarker(opts: {
  readonly store: NoydbStore
  readonly vault: string
  readonly collectionName: string
  readonly dek: EnclaveKey
  readonly marker: PairingMarker
}): Promise<void> {
  // Shares the `_schemas/<collection>` record with the JSON-Schema writer;
  // CAS on the loaded version so a concurrent schema (re)registration can't
  // silently drop the marker (and vice-versa) — see #583.
  for (let attempt = 0; ; attempt++) {
    const { version, payload: stored } = await loadPersistedSchemaEntry(
      opts.store, opts.vault, opts.collectionName, opts.dek,
    )
    if (stored?.satellite !== undefined && satelliteMarkersEqual(stored.satellite, opts.marker)) return
    const payload: PersistedSchemaEnvelope =
      stored !== undefined
        ? { ...stored, satellite: opts.marker }
        : {
            _noydb_schema: 1,
            kind: 'Unknown',
            jsonSchema: null,
            hash: null,
            derivedAt: new Date().toISOString(),
            satellite: opts.marker,
          }
    try {
      await savePersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek, payload, version)
      return
    } catch (err) {
      if (isConflictError(err) && attempt < MAX_SCHEMA_CAS_RETRIES) continue
      throw err
    }
  }
}

// #597: both equality checks below deliberately do NOT compare `epoch`. A
// live collection re-opening itself computes a fresh epoch candidate on
// every declare (marker.ts / config-drift.ts) that must still be treated as
// "the same marker" so the no-op fast path fires and the already-persisted
// epoch is left untouched — that's what makes epoch stable across re-opens.
// Comparing epoch here would break that fast path today, with no
// corresponding benefit: there is no delete-collection API yet, so a
// mismatched epoch can't (yet) mean "this name was reused for a genuinely
// new collection." Wiring an epoch-mismatch REJECTION is a deferred
// follow-up for whenever collection deletion ships.

function satelliteMarkersEqual(a: PairingMarker, b: PairingMarker): boolean {
  return a.base === b.base && a.fieldsHash === b.fieldsHash && (a.joined ?? null) === (b.joined ?? null)
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
