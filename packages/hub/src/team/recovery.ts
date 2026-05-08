/**
 * Recovery profile persistence + dispatch — issue #10.
 *
 * v0.1.0-pre.5 wires the **paper** profile end-to-end through
 * `@noy-db/on-recovery`. The other three profiles (Shamir,
 * multi-channel, admin-mediated) ship the API surface and throw
 * {@link RecoveryProfileNotImplementedError} during use; per-profile
 * dispatch lands in follow-up issues.
 *
 * Storage layout:
 *
 * ```
 * _meta/recovery-paper       — JSON { entries: RecoveryCodeEntry[] } produced by `on-recovery`.
 * _meta/recovery-shamir      — reserved
 * _meta/recovery-multi       — reserved
 * _meta/recovery-admin       — reserved
 * ```
 *
 * Like `_meta/policy` and `_meta/handle`, the documents are plain JSON
 * with empty `_iv` — the recovery-code wrapping is what protects the
 * KEK; the entries themselves are inert without the user's code.
 *
 * @module
 */
import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import {
  mintWrappedDeksBlob,
  unwrapDeksFromBlob,
  type WrappedDeksBlob,
} from './wrapped-deks.js'

/**
 * One paper recovery code as persisted in `_meta/recovery-paper`.
 *
 * The hub's KEK is intentionally non-extractable (see `crypto.ts`),
 * so the recovery entry can't AES-KW-wrap the KEK directly. Instead
 * we wrap a serialized DEK set: the entry holds the AES-GCM
 * ciphertext of `{ deks: { collection: rawDekBase64 } }`. Recovery
 * deserializes the DEK set, then mints a fresh KEK from the new
 * passphrase and rewraps the DEKs under it.
 *
 * This is the same pattern `@noy-db/on-pin` uses for tier-3 quick
 * resume — the cryptographic guarantee is identical (AES-GCM with a
 * PBKDF2-derived key), and it sidesteps the non-extractable-KEK
 * constraint cleanly.
 *
 * Type-level composition (#44): `PaperRecoveryEntry extends
 * WrappedDeksBlob` — the three crypto fields (`salt`, `iv`,
 * `wrappedDeks`) come from the shared primitive; `codeId` and
 * `enrolledAt` are paper-recovery's own metadata. Wire format
 * unchanged.
 */
export interface PaperRecoveryEntry extends WrappedDeksBlob {
  readonly codeId: string
  readonly enrolledAt: string
}

export interface PaperRecoveryDoc {
  readonly _noydb_recovery: 1
  readonly profile: 'paper'
  readonly entries: ReadonlyArray<PaperRecoveryEntry>
}

const PAPER_DOC_ID = 'recovery-paper'

/** Read the paper-recovery entries. Returns empty array when absent. */
export async function loadPaperRecoveryEntries(
  store: NoydbStore,
  vault: string,
): Promise<ReadonlyArray<PaperRecoveryEntry>> {
  const env = await store.get(vault, '_meta', PAPER_DOC_ID)
  if (!env) return []
  try {
    const doc = JSON.parse(env._data) as PaperRecoveryDoc
    if (doc.profile !== 'paper' || !Array.isArray(doc.entries)) return []
    return doc.entries
  } catch {
    return []
  }
}

/** Replace the paper-recovery entries (used after burn-on-recovery). */
export async function savePaperRecoveryEntries(
  store: NoydbStore,
  vault: string,
  entries: ReadonlyArray<PaperRecoveryEntry>,
): Promise<void> {
  const doc: PaperRecoveryDoc = {
    _noydb_recovery: 1,
    profile: 'paper',
    entries,
  }
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(doc),
  }
  await store.put(vault, '_meta', PAPER_DOC_ID, envelope)
}

/** Drop a single paper-recovery entry (burn-on-use). */
export async function burnPaperRecoveryEntry(
  store: NoydbStore,
  vault: string,
  codeId: string,
): Promise<void> {
  const entries = await loadPaperRecoveryEntries(store, vault)
  const remaining = entries.filter((e) => e.codeId !== codeId)
  await savePaperRecoveryEntries(store, vault, remaining)
}

/** Whether at least one recovery profile has any enrolled entries. */
export async function hasRecoveryEnrolled(
  store: NoydbStore,
  vault: string,
): Promise<boolean> {
  const paper = await loadPaperRecoveryEntries(store, vault)
  return paper.length > 0
}

/**
 * Generate one paper-recovery entry from an unlocked DEK set.
 *
 * Returns the serializable entry (persisted via
 * {@link savePaperRecoveryEntries}). The recovery flow unwraps the
 * DEK set, then mints a fresh KEK from the user's new passphrase.
 *
 * Thin wrapper over {@link mintWrappedDeksBlob} (#44) — the crypto
 * lives in the shared primitive; this function just adds paper-
 * recovery's own metadata (`codeId`, `enrolledAt`).
 *
 * @param deks      Map of collection-name → DEK (extractable).
 * @param code      The plaintext recovery code (caller-supplied;
 *                  pair this with `@noy-db/on-recovery`'s code
 *                  generator/parser if available).
 * @param codeId    Stable id used by `burnPaperRecoveryEntry`.
 */
export async function mintPaperRecoveryEntry(
  deks: Map<string, CryptoKey>,
  code: string,
  codeId: string,
): Promise<PaperRecoveryEntry> {
  const blob = await mintWrappedDeksBlob(deks, code)
  return {
    ...blob,
    codeId,
    enrolledAt: new Date().toISOString(),
  }
}

/**
 * Decrypt a recovery entry to recover the raw DEK set. Used by the
 * `recoverPassphrase` flow after the user's code has been parsed.
 *
 * Thin wrapper over {@link unwrapDeksFromBlob} (#44).
 *
 * @throws when the code does not match the entry (AES-GCM auth tag fail).
 */
export async function unwrapDeksFromPaperEntry(
  entry: PaperRecoveryEntry,
  code: string,
): Promise<Map<string, CryptoKey>> {
  return unwrapDeksFromBlob(entry, code)
}

// Legacy crypto helpers (deriveRecoveryWrappingKey, bytesToBase64,
// base64ToBytes) were inlined here pre-#44. They now live in the
// canonical wrap-DEKs primitive at `./wrapped-deks.ts` and are
// reached via `mintWrappedDeksBlob` / `unwrapDeksFromBlob`.
