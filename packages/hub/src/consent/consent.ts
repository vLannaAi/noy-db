/**
 * Consent boundaries — per-access audit log (v0.16 #218).
 *
 * ```ts
 * const audit = await vault.withConsent(
 *   { purpose: 'quarterly-review', consentHash: '7f3a...' },
 *   async () => {
 *     const invoices = await vault.collection<Invoice>('invoices').list()
 *     return invoices
 *   },
 * )
 *
 * const log = await vault.consentAudit({ since: '2026-01-01T00:00:00Z' })
 * // → entries: { actor, purpose, consentHash, ts, op, collection, id }
 * ```
 *
 * ## Contract
 *
 * Every `get` / `put` / `delete` that happens inside a `withConsent`
 * callback writes one entry to the reserved `_consent_audit`
 * collection. Entries are encrypted with the vault's consent-audit
 * DEK (separate from per-user-collection DEKs so access-log queries
 * don't require unwrapping individual collection keys). Outside a
 * `withConsent` scope, no entries are written — consent is
 * opt-in by design (GDPR Art. 7: *demonstrable*, *specific*
 * consent).
 *
 * ## Why store the hash, not the consent text?
 *
 * The `consentHash` is the sha256 of whatever consent receipt the
 * actor presented (a signed GDPR banner click, a HIPAA authorisation
 * PDF, an API-level `X-Consent-Hash` header). Storing only the hash:
 *
 *   1. Keeps the audit log small and indexable.
 *   2. Preserves zero-knowledge at the adapter — adapters see
 *      ciphertext envelopes of `{ actor, purpose, consentHash, ts,
 *      op, collection, id }`, never the consent record itself.
 *   3. Lets the regulator verify a presented consent doc matches
 *      the logged hash at audit time without the system ever
 *      possessing the doc.
 *
 * ## Concurrency
 *
 * The consent context lives on the {@link Vault} instance. Two
 * concurrent `withConsent` calls on the same Vault would stomp each
 * other — documented limitation; adopters needing per-flight scope
 * should use separate Vault instances or an AsyncLocalStorage shim.
 *
 * @module
 */
import type { EncryptedEnvelope, NoydbStore } from '../types.js'
import { encrypt, decrypt } from '../crypto.js'
import { generateULID } from '../bundle/ulid.js'

/** Reserved collection for consent-audit entries. */
export const CONSENT_AUDIT_COLLECTION = '_consent_audit'

/**
 * The consent scope active for a block of work. Set via
 * `vault.withConsent()`; observed by the collection's access hooks.
 */
export interface ConsentContext {
  /**
   * What this access is for. Used by the audit query (`consentAudit
   * ({ purpose })`) and carried in the stored entry. Free-form; the
   * regulator or compliance tooling decides the vocabulary.
   */
  readonly purpose: string
  /**
   * Hex-encoded sha256 of whatever consent artefact the actor
   * presented. Stored as-is in each entry.
   */
  readonly consentHash: string
}

/** Access operation recorded in an audit entry. */
export type ConsentOp = 'get' | 'put' | 'delete'

/** One consent-audit record, as decrypted for the caller. */
export interface ConsentAuditEntry {
  /** ULID — stable insertion-order key. */
  readonly id: string
  readonly timestamp: string
  readonly actor: string
  readonly purpose: string
  readonly consentHash: string
  readonly op: ConsentOp
  readonly collection: string
  readonly recordId: string
}

/** Filter passed to `vault.consentAudit()`. */
export interface ConsentAuditFilter {
  /** Only entries at or after this ISO timestamp. */
  readonly since?: string
  /** Only entries at or before this ISO timestamp. */
  readonly until?: string
  /** Match entries targeting this collection. */
  readonly collection?: string
  /** Match entries written by this actor. */
  readonly actor?: string
  /** Match entries with this purpose. */
  readonly purpose?: string
}

/**
 * Write one audit entry. Called by Vault's onAccess hook when a
 * consent context is active.
 */
export async function writeConsentEntry(
  adapter: NoydbStore,
  vault: string,
  encrypted: boolean,
  entry: Omit<ConsentAuditEntry, 'id' | 'timestamp'>,
  getDEK: (collection: string) => Promise<CryptoKey>,
): Promise<void> {
  const id = generateULID()
  const full: ConsentAuditEntry = {
    id,
    timestamp: new Date().toISOString(),
    ...entry,
  }
  const envelope = await buildEnvelope(full, encrypted, getDEK)
  await adapter.put(vault, CONSENT_AUDIT_COLLECTION, id, envelope)
}

/** Load + decrypt + filter all entries. */
export async function loadConsentEntries(
  adapter: NoydbStore,
  vault: string,
  encrypted: boolean,
  getDEK: (collection: string) => Promise<CryptoKey>,
  filter: ConsentAuditFilter = {},
): Promise<ConsentAuditEntry[]> {
  const ids = await adapter.list(vault, CONSENT_AUDIT_COLLECTION)
  const entries: ConsentAuditEntry[] = []

  for (const id of ids.sort()) {
    const envelope = await adapter.get(vault, CONSENT_AUDIT_COLLECTION, id)
    if (!envelope) continue
    const entry = await decryptEntry(envelope, encrypted, getDEK)
    if (!matchesFilter(entry, filter)) continue
    entries.push(entry)
  }
  return entries
}

// ── internals ──────────────────────────────────────────────────────

async function buildEnvelope(
  entry: ConsentAuditEntry,
  encrypted: boolean,
  getDEK: (collection: string) => Promise<CryptoKey>,
): Promise<EncryptedEnvelope> {
  const json = JSON.stringify(entry)
  if (!encrypted) {
    return {
      _noydb: 1,
      _v: 1,
      _ts: entry.timestamp,
      _iv: '',
      _data: json,
    }
  }
  const dek = await getDEK(CONSENT_AUDIT_COLLECTION)
  const { iv, data } = await encrypt(json, dek)
  return {
    _noydb: 1,
    _v: 1,
    _ts: entry.timestamp,
    _iv: iv,
    _data: data,
  }
}

async function decryptEntry(
  envelope: EncryptedEnvelope,
  encrypted: boolean,
  getDEK: (collection: string) => Promise<CryptoKey>,
): Promise<ConsentAuditEntry> {
  const json = encrypted
    ? await decrypt(envelope._iv, envelope._data, await getDEK(CONSENT_AUDIT_COLLECTION))
    : envelope._data
  return JSON.parse(json) as ConsentAuditEntry
}

function matchesFilter(entry: ConsentAuditEntry, f: ConsentAuditFilter): boolean {
  if (f.since && entry.timestamp < f.since) return false
  if (f.until && entry.timestamp > f.until) return false
  if (f.collection && entry.collection !== f.collection) return false
  if (f.actor && entry.actor !== f.actor) return false
  if (f.purpose && entry.purpose !== f.purpose) return false
  return true
}
