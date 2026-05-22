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
import type { NoydbStore } from '../types.js'
import type { PersistedSchemaEnvelope } from './types.js'

export interface PersistSchemaResult {
  /** True when a fresh envelope was written to storage. */
  readonly written: boolean
  /** True when an existing envelope matched and the write was skipped. */
  readonly skipped: boolean
  /** The envelope that was either written or matched. */
  readonly envelope: PersistedSchemaEnvelope
}

export async function persistSchemaIfNeeded(opts: {
  readonly store: NoydbStore
  readonly vault: string
  readonly collectionName: string
  readonly validator: unknown
  readonly dek: CryptoKey
}): Promise<PersistSchemaResult> {
  const fresh = await derivePersistedSchema(opts.validator)
  const stored = await loadPersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek)

  if (stored && isEquivalent(stored, fresh)) {
    return { written: false, skipped: true, envelope: stored }
  }

  await savePersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek, fresh)
  return { written: true, skipped: false, envelope: fresh }
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
