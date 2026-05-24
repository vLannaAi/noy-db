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
import type { ShamirRecoveryProvider } from './shamir-recovery-provider.js'

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
  if (paper.length > 0) return true
  const shamir = await loadShamirRecoveryEntries(store, vault)
  return shamir.length > 0
}

/**
 * Whether at least one **strong** recovery profile is enrolled (#195).
 *
 * "Strong" excludes paper-alone — under managed-passphrase mode the
 * user has no memorized passphrase, so a stolen/lost paper sheet
 * would be a single point of total loss. Strong profiles today:
 *
 *   - `shamir` (k-of-n threshold; survives loss of up to n-k shares)
 *   - `multi-channel` (when shipped — #196 follow-up slice)
 *   - `admin-mediated` (when shipped — #196 follow-up slice)
 *
 * Managed mode requires this check to pass before `openVault` returns.
 */
export async function hasStrongRecoveryEnrolled(
  store: NoydbStore,
  vault: string,
): Promise<boolean> {
  const shamir = await loadShamirRecoveryEntries(store, vault)
  return shamir.length > 0
  // When multi-channel / admin-mediated land, extend this check.
}

// ─── Shamir recovery (#196 slice 1) ──────────────────────────────────────

/**
 * One Shamir-recovery entry as persisted in `_meta/recovery-shamir`.
 *
 * Like {@link PaperRecoveryEntry}, the entry composes
 * {@link WrappedDeksBlob} (DEKs wrapped under a fresh ephemeral
 * recovery secret) with profile-specific metadata. Unlike paper, the
 * "credential" was never visible to the user — it was 32 random
 * bytes split into N Shamir shares at enrollment. The shares ARE
 * the credential; the user holds them, the hub never sees them
 * again after `enrollRecovery` returns.
 *
 * Per the spec §5: the recovery secret is base64-encoded and
 * passed as the `credential` arg to
 * {@link mintWrappedDeksBlob} / {@link unwrapDeksFromBlob}. The
 * PBKDF2 round over high-entropy input is harmless overhead — it
 * keeps the shared primitive unchanged while letting Shamir reuse
 * the same wrapping pipeline as paper.
 */
export interface ShamirRecoveryEntry extends WrappedDeksBlob {
  /** Stable id for this entry. Allows multiple Shamir splits to coexist. */
  readonly entryId: string
  /** Threshold — minimum shares to reconstruct. */
  readonly k: number
  /** Total shares minted at enrollment. */
  readonly n: number
  /** x-coordinates of the n minted shares. Informational. Omitted as of 0.2
   *  (string-level provider doesn't expose share x-coords); kept optional so
   *  pre-0.2 entries still read. */
  readonly xCoords?: ReadonlyArray<number>
  /** ISO timestamp. */
  readonly enrolledAt: string
  /** Optional caller-supplied label (e.g., "2-of-3 board escrow"). */
  readonly label?: string
}

export interface ShamirRecoveryDoc {
  readonly _noydb_recovery: 1
  readonly profile: 'shamir'
  readonly entries: ReadonlyArray<ShamirRecoveryEntry>
}

const SHAMIR_DOC_ID = 'recovery-shamir'

/** Read the Shamir-recovery entries. Returns empty array when absent. */
export async function loadShamirRecoveryEntries(
  store: NoydbStore,
  vault: string,
): Promise<ReadonlyArray<ShamirRecoveryEntry>> {
  const env = await store.get(vault, '_meta', SHAMIR_DOC_ID)
  if (!env) return []
  try {
    const doc = JSON.parse(env._data) as ShamirRecoveryDoc
    if (doc.profile !== 'shamir' || !Array.isArray(doc.entries)) return []
    return doc.entries
  } catch {
    return []
  }
}

/** Replace the Shamir-recovery entries (used by enrollment and rotation). */
export async function saveShamirRecoveryEntries(
  store: NoydbStore,
  vault: string,
  entries: ReadonlyArray<ShamirRecoveryEntry>,
): Promise<void> {
  const doc: ShamirRecoveryDoc = {
    _noydb_recovery: 1,
    profile: 'shamir',
    entries,
  }
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(doc),
  }
  await store.put(vault, '_meta', SHAMIR_DOC_ID, envelope)
}

/**
 * Mint a fresh Shamir recovery entry from a DEK set.
 *
 * 1. Generates a 32-byte recovery secret.
 * 2. Wraps the DEK set under that secret via
 *    {@link mintWrappedDeksBlob} (the recovery secret is base64-
 *    encoded as the credential string — PBKDF2 over high-entropy
 *    input is harmless overhead).
 * 3. Splits the recovery secret via Shamir into `n` shares with
 *    threshold `k`.
 * 4. Zeros the in-memory recovery secret after wrapping + splitting.
 *
 * Returns:
 *   - `entry` — the {@link ShamirRecoveryEntry} to persist.
 *   - `shareStrings` — the `n` Base32-encoded share strings to
 *     return to the caller. The HUB MUST NOT PERSIST THESE; once
 *     returned they are the user's responsibility.
 *
 * @param deks - DEK set to wrap.
 * @param entryId - Stable id for this entry (caller-supplied or
 *                  hub-generated).
 * @param k - Threshold (>= 2).
 * @param n - Total shares (k <= n <= 255).
 * @param label - Optional caller label.
 */
export async function mintShamirRecoveryEntry(
  provider: ShamirRecoveryProvider,
  deks: Map<string, CryptoKey>,
  entryId: string,
  k: number,
  n: number,
  label?: string,
): Promise<{ entry: ShamirRecoveryEntry; shareStrings: string[] }> {
  const recoverySecret = crypto.getRandomValues(new Uint8Array(32))
  try {
    const credential = bytesToBase64(recoverySecret)
    const blob = await mintWrappedDeksBlob(deks, credential)
    const shareStrings = provider.splitToShares(recoverySecret, k, n)
    const entry: ShamirRecoveryEntry = {
      ...blob, entryId, k, n,
      enrolledAt: new Date().toISOString(),
      ...(label !== undefined && { label }),
    }
    return { entry, shareStrings }
  } finally {
    recoverySecret.fill(0)
  }
}

/**
 * Decrypt a Shamir recovery entry to recover the raw DEK set.
 *
 * Combines K or more `shares`, reconstructs the recovery secret,
 * unwraps the DEKs via {@link unwrapDeksFromBlob}.
 *
 * Throws (AES-GCM auth-tag mismatch) when the shares don't combine
 * to the secret originally used to mint the entry — typically
 * because they came from a different enrollment or were tampered
 * with. Callers iterating multiple entries should catch.
 */
export async function unwrapDeksFromShamirEntry(
  provider: ShamirRecoveryProvider,
  entry: ShamirRecoveryEntry,
  shareStrings: readonly string[],
): Promise<Map<string, CryptoKey>> {
  if (shareStrings.length < entry.k) {
    throw new Error(
      `Insufficient shares: this Shamir entry needs ${entry.k} of ${entry.n}, `
      + `but ${shareStrings.length} were provided.`,
    )
  }
  const secret = provider.combineShares(shareStrings)
  try {
    return await unwrapDeksFromBlob(entry, bytesToBase64(secret))
  } finally {
    secret.fill(0)
  }
}

function bytesToBase64(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
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
