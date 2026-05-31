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
import { loadPersistedSchema, savePersistedSchema } from './storage.js'
import { computeSchemaDelta } from '../schema-update/delta.js'
import { evaluateStrategies } from '../schema-update/dispatch.js'
import type { SchemaUpdateStrategy, UpdateDecision } from '../schema-update/types.js'
import type { NoydbStore } from '../types.js'
import type { PersistedSchemaEnvelope } from './types.js'

export interface PersistSchemaResult {
  /** True when a fresh envelope was written to storage. */
  readonly written: boolean
  /** True when an existing envelope matched and the write was skipped. */
  readonly skipped: boolean
  /** The envelope that was either written or matched. */
  readonly envelope: PersistedSchemaEnvelope
  /** The update-strategy decision, present when strategies ran (#245). */
  readonly decision?: UpdateDecision
}

export async function persistSchemaIfNeeded(opts: {
  readonly store: NoydbStore
  readonly vault: string
  readonly collectionName: string
  readonly validator: unknown
  readonly dek: CryptoKey
  readonly strategies?: readonly SchemaUpdateStrategy[]
}): Promise<PersistSchemaResult> {
  const fresh = await derivePersistedSchema(opts.validator)
  const stored = await loadPersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek)

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
    // reject (or, in #232, cutover): do NOT overwrite the baseline — the
    // old schema stays the source of truth until the change is resolved.
    return { written: false, skipped: false, envelope: stored ?? fresh, decision }
  }

  await savePersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek, fresh)
  return { written: true, skipped: false, envelope: fresh, decision }
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
