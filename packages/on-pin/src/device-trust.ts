/**
 * **Device-trust unlock mode** — "always safe to open on this device."
 *
 * The session DEKs are wrapped under a **non-extractable, device-bound
 * `crypto.subtle` key** and persisted in IndexedDB, so the vault reopens
 * on this device with **no user factor at all**: load the CryptoKey +
 * blob, unwrap, done. No network, no prompt.
 *
 * Sits beside PIN quick-lock in the session-resume family and shares its
 * plumbing (`keyring-codec.ts`): same serialized-keyring payload, same
 * AES-GCM wrap, same `kek: null` resumed keyring. The differences are
 * the wrapping key (device-generated, not credential-derived) and the
 * persistence (IndexedDB structured clone, not an in-memory state
 * object).
 *
 * ## Threat model (read before enabling)
 *
 * - **The OS lock screen IS the factor.** Anyone holding the unlocked
 *   device opens the vault. This is a deliberate, opt-in trade for
 *   mobile/embedded contexts (LIFF → detached PWA, kiosk, personal
 *   phone) where a repeated secret/PIN prompt kills the offline UX
 *   and the device lock is accepted as the effective user factor.
 * - **The key material cannot be exfiltrated.** The wrapping key is
 *   generated with `extractable: false` and persisted as a CryptoKey
 *   OBJECT via IndexedDB's structured clone — its raw bits never exist
 *   in JS. Malware must run *on the origin in the browser* to use it;
 *   it cannot steal the key itself.
 * - **Storage eviction silently disables the mode** (browser data
 *   clear, iOS ITP 7-day eviction). Resume then fails CLOSED with the
 *   typed {@link DeviceTrustNotFoundError} — the caller falls back to a
 *   real-factor unlock (secret, invite, OIDC) and may re-enroll.
 *   Never a lockout: the real factor always remains.
 * - **Enrollment requires an already-unlocked session** (session-resume
 *   family law). Device-trust is NEVER a first-unlock factor — a cold
 *   device with no prior unlock has nothing to wrap.
 * - **Revocation.** Locally, {@link clearDeviceTrust} deletes the key +
 *   blob — the mode is dead on this device. Keyring-side, the blob
 *   caches raw DEK bytes, so standard slot revocation + DEK rotation
 *   invalidate it: after the vault rotates its DEKs, the cached stale
 *   DEKs fail AES-GCM authentication against any newly written record.
 *
 * ## Policy gate + tier cap
 *
 * - Enrollment is gated by the `app:device-trust` policy gate
 *   ({@link DEVICE_TRUST_GATE}), evaluated with the hub's own
 *   `checkGate` engine when the caller passes the vault policy. The
 *   vault owner/admin forbids the mode by configuring
 *   `gates: { 'app:device-trust': { enabled: false, minTier: 3 } }`, or
 *   bounds it (e.g. `minTier: 1` = only a full-secret session may
 *   enroll, `factors: [...]` = require a fresh proof at enrollment).
 *   Unconfigured, the gate allows — matching the mode's opt-in design.
 * - A device-trust resume yields a **capped session tier**
 *   ({@link DeviceTrustState.resumeTier}) — default tier 3, the floor,
 *   same as a PIN resume and always below the secret tier 1. Pass
 *   it as `activeTier` to `checkGate` so sensitive gated operations
 *   still require a real factor.
 *
 * @module
 */

import { checkGate } from '@noy-db/hub'
import type {
  UnlockedKeyring,
  VaultPolicy,
  GateName,
  ActiveTier,
  FactorProof,
} from '@noy-db/hub'
import {
  serializeKeyring,
  deserializeKeyring,
  bytesToBase64,
  base64ToBytes,
} from './keyring-codec.js'

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * The policy gate evaluated at enrollment. Lives in the `app:*`
 * namespace deliberately: enrollment is a purely client-local operation
 * over DEKs the session already holds, so the gate is an owner-facing
 * policy switch, not a cryptographic boundary — and an unconfigured
 * `app:*` gate allows (built-in gates fail closed), which matches the
 * opt-in default: the mode works until the owner forbids it.
 */
export const DEVICE_TRUST_GATE: GateName = 'app:device-trust'

/**
 * Session tier a device-trust resume may claim. Tier 1 (secret) is
 * deliberately unrepresentable — a no-factor resume can never claim the
 * full-unlock tier.
 */
export type DeviceTrustResumeTier = 2 | 3

/**
 * Default resume tier: 3, the floor — same tier as a PIN quick-resume
 * and below the secret tier (1), so policy-gated sensitive
 * operations still require a real factor.
 */
export const DEVICE_TRUST_DEFAULT_RESUME_TIER: DeviceTrustResumeTier = 3

const RECORD_KEY_PREFIX = 'noydb:device-trust:'
const DB_NAME = 'noydb-device-trust'
const OBJECT_STORE = 'records'

// ─── Errors ─────────────────────────────────────────────────────────────

/**
 * Thrown by `resumeDeviceTrust()` when no device-trust record exists for
 * the vault in browser storage.
 *
 * The device key + wrapped-DEKs blob are created at enrollment and
 * stored in IndexedDB on the enrolling device — they never leave it.
 * This error means storage was evicted (browser data clear, iOS ITP
 * eviction, private browsing) or the mode was never enrolled / was
 * cleared. Fail closed into a real-factor unlock (secret, invite,
 * OIDC), then re-enroll this device via `enrollDeviceTrust` — the real
 * factor always remains, so this is never a lockout.
 */
export class DeviceTrustNotFoundError extends Error {
  readonly code = 'DEVICE_TRUST_NOT_FOUND' as const
  constructor(vault: string) {
    super(
      `No device-trust record found for vault "${vault}". ` +
      'The device key and wrapped DEKs are created at enrollment and stored in browser storage; ' +
      'they were evicted, cleared, or never enrolled on this device. ' +
      'Unlock with a real factor (secret, invite, OIDC) and re-enroll via enrollDeviceTrust().',
    )
    this.name = 'DeviceTrustNotFoundError'
  }
}

/** Thrown when device-trust enrollment fails (see message for cause). */
export class DeviceTrustEnrollmentError extends Error {
  readonly code = 'DEVICE_TRUST_ENROLLMENT_FAILED' as const
  constructor(message = 'Device-trust enrollment failed.') {
    super(message)
    this.name = 'DeviceTrustEnrollmentError'
  }
}

/**
 * Thrown by `resumeDeviceTrust()` when a record exists but cannot be
 * unwrapped (corrupt blob, key/blob mismatch after a partial storage
 * wipe). Fail closed: unlock with a real factor and re-enroll.
 */
export class DeviceTrustInvalidError extends Error {
  readonly code = 'DEVICE_TRUST_INVALID' as const
  constructor(vault: string) {
    super(
      `Device-trust record for vault "${vault}" exists but could not be unwrapped ` +
      '(corrupt or mismatched key/blob). ' +
      'Unlock with a real factor (secret, invite, OIDC) and re-enroll via enrollDeviceTrust().',
    )
    this.name = 'DeviceTrustInvalidError'
  }
}

/**
 * Thrown when no `store` was supplied and the environment has no
 * `indexedDB` (Node, some workers). Pass an explicit
 * {@link DeviceTrustStore} implementation.
 */
export class DeviceTrustStorageError extends Error {
  readonly code = 'DEVICE_TRUST_STORAGE_UNAVAILABLE' as const
  constructor(message = 'IndexedDB is not available in this environment; pass an explicit DeviceTrustStore.') {
    super(message)
    this.name = 'DeviceTrustStorageError'
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Minimal async key-value storage for device-trust records. Values must
 * survive a structured clone (they contain a non-extractable
 * CryptoKey). The default is IndexedDB
 * ({@link indexedDbDeviceTrustStore}); tests and non-browser hosts
 * inject their own.
 */
export interface DeviceTrustStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Metadata persisted beside the device key. Unlike `PinResumeState`,
 * this is NOT the caller's to hold — it lives in the store (there is
 * nothing secret and nothing to keep in memory across a cold start).
 */
export interface DeviceTrustState {
  /** Schema marker. */
  readonly _noydb_device_trust: 1
  /** Vault this record resumes. */
  readonly vault: string
  /** Base64 AES-GCM IV for `wrappedKeyring`. */
  readonly iv: string
  /** Base64 AES-GCM ciphertext — serialized keyring wrapped under the device key. */
  readonly wrappedKeyring: string
  /** ISO-8601 enrollment timestamp. */
  readonly enrolledAt: string
  /** Session tier a resume from this record yields. */
  readonly resumeTier: DeviceTrustResumeTier
}

export interface EnrollDeviceTrustOptions {
  /** Vault name — keys the device-trust record in storage. */
  readonly vault: string
  /** Storage override. Default: IndexedDB. */
  readonly store?: DeviceTrustStore
  /**
   * The vault's policy document (`db.policy.getPolicy(vault)`). When
   * present, the {@link DEVICE_TRUST_GATE} gate is checked and a denial
   * throws the hub's `PolicyDeniedError`. When absent, no gate runs.
   */
  readonly policy?: VaultPolicy
  /** Tier of the enrolling session, for the gate check. Default: 1 (fresh full unlock). */
  readonly activeTier?: ActiveTier
  /** Factor proofs presented to the gate, if its policy requires any. */
  readonly factors?: ReadonlyArray<FactorProof>
  /** Session tier a resume will yield. Default: {@link DEVICE_TRUST_DEFAULT_RESUME_TIER}. */
  readonly resumeTier?: DeviceTrustResumeTier
}

export interface DeviceTrustStoreOptions {
  /** Storage override. Default: IndexedDB. */
  readonly store?: DeviceTrustStore
}

/** What `resumeDeviceTrust()` yields. */
export interface DeviceTrustResumeResult {
  /** The resumed session keyring (`kek: null`, like every session-resume). */
  readonly keyring: UnlockedKeyring
  /**
   * The capped session tier recorded at enrollment. Pass as
   * `activeTier` to `checkGate` so gated operations see the true
   * (no-factor) strength of this session.
   */
  readonly resumeTier: DeviceTrustResumeTier
}

/** Shape of the single structured-clone record persisted per vault. */
interface DeviceTrustRecord {
  readonly key: CryptoKey
  readonly state: DeviceTrustState
}

// ─── Implementation ─────────────────────────────────────────────────────

/**
 * Enroll device-trust for a vault against an already-unlocked keyring.
 *
 * Generates a fresh **non-extractable** AES-GCM device key
 * (`crypto.subtle.generateKey(..., extractable: false, ...)`), wraps
 * the session's serialized keyring under it, and persists the CryptoKey
 * OBJECT + blob as one structured-clone record. Re-enrolling the same
 * vault overwrites the previous record (fresh key, fresh blob).
 *
 * @throws {DeviceTrustEnrollmentError} when the keyring holds no DEKs
 *         (not an unlocked session) or a DEK is not extractable.
 * @throws `PolicyDeniedError` (hub) when `options.policy` forbids or
 *         bounds the {@link DEVICE_TRUST_GATE} gate.
 * @throws {DeviceTrustStorageError} when no store is available.
 */
export async function enrollDeviceTrust(
  keyring: UnlockedKeyring,
  options: EnrollDeviceTrustOptions,
): Promise<DeviceTrustState> {
  const resumeTier = options.resumeTier ?? DEVICE_TRUST_DEFAULT_RESUME_TIER
  if (resumeTier !== 2 && resumeTier !== 3) {
    throw new DeviceTrustEnrollmentError(
      `Invalid resumeTier ${String(resumeTier)} — a device-trust resume may only claim tier 2 or 3, never the secret tier.`,
    )
  }
  if (keyring.deks.size === 0) {
    throw new DeviceTrustEnrollmentError(
      'Keyring holds no DEKs — device-trust enrolls an already-unlocked session, never a cold one.',
    )
  }

  if (options.policy) {
    await checkGate(options.policy, DEVICE_TRUST_GATE, {
      activeTier: options.activeTier ?? 1,
      ...(options.factors !== undefined && { factors: options.factors }),
    })
  }

  const store = resolveStore(options.store)

  let serialized: Uint8Array
  try {
    serialized = await serializeKeyring(keyring)
  } catch (err) {
    throw new DeviceTrustEnrollmentError(
      'Failed to serialize keyring — DEK not extractable. ' +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // The device key: non-extractable by construction. Its raw bits never
  // exist in JS; it persists only as a structured-clone CryptoKey object.
  const deviceKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    deviceKey,
    serialized as BufferSource,
  )

  const state: DeviceTrustState = {
    _noydb_device_trust: 1,
    vault: options.vault,
    iv: bytesToBase64(iv),
    wrappedKeyring: bytesToBase64(new Uint8Array(ciphertext)),
    enrolledAt: new Date().toISOString(),
    resumeTier,
  }

  const record: DeviceTrustRecord = { key: deviceKey, state }
  await store.set(recordKey(options.vault), record)
  return state
}

/**
 * Resume a session from this device's device-trust record. No network,
 * no prompt: load the CryptoKey + blob from storage, unwrap, return the
 * keyring (`kek: null`) with its capped {@link DeviceTrustResumeResult.resumeTier}.
 *
 * @throws {DeviceTrustNotFoundError} when no record exists (evicted /
 *         cleared / never enrolled) — fail closed to a real-factor unlock.
 * @throws {DeviceTrustInvalidError} when the record exists but cannot
 *         be unwrapped.
 * @throws {DeviceTrustStorageError} when no store is available.
 */
export async function resumeDeviceTrust(
  vault: string,
  options: DeviceTrustStoreOptions = {},
): Promise<DeviceTrustResumeResult> {
  const store = resolveStore(options.store)
  const record = await store.get(recordKey(vault))
  if (record === undefined || record === null) {
    throw new DeviceTrustNotFoundError(vault)
  }
  if (!isDeviceTrustRecord(record)) {
    throw new DeviceTrustInvalidError(vault)
  }

  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(record.state.iv) as BufferSource },
      record.key,
      base64ToBytes(record.state.wrappedKeyring) as BufferSource,
    )
  } catch {
    throw new DeviceTrustInvalidError(vault)
  }

  const keyring = await deserializeKeyring(new Uint8Array(plaintext))
  return { keyring, resumeTier: record.state.resumeTier }
}

/**
 * Local revocation: delete this device's device-trust record (key +
 * blob). The mode is dead on this device until re-enrolled from a
 * real-factor unlock. Idempotent.
 */
export async function clearDeviceTrust(
  vault: string,
  options: DeviceTrustStoreOptions = {},
): Promise<void> {
  const store = resolveStore(options.store)
  await store.delete(recordKey(vault))
}

/** Whether a device-trust record exists for the vault on this device. */
export async function isDeviceTrustEnrolled(
  vault: string,
  options: DeviceTrustStoreOptions = {},
): Promise<boolean> {
  const store = resolveStore(options.store)
  const record = await store.get(recordKey(vault))
  return isDeviceTrustRecord(record)
}

// ─── Default IndexedDB store ────────────────────────────────────────────

/**
 * The default {@link DeviceTrustStore}: one IndexedDB database
 * (`noydb-device-trust`) with a single object store. IndexedDB's
 * structured clone is what lets a non-extractable CryptoKey persist as
 * an OBJECT — the key survives, its bits stay unreadable.
 */
export function indexedDbDeviceTrustStore(dbName: string = DB_NAME): DeviceTrustStore {
  let dbPromise: Promise<IDBDatabase> | undefined

  function open(): Promise<IDBDatabase> {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(OBJECT_STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
    })
    return dbPromise
  }

  async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE, mode)
      const req = op(tx.objectStore(OBJECT_STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
    })
  }

  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: async (key, value) => {
      await run('readwrite', (s) => s.put(value, key))
    },
    delete: async (key) => {
      await run('readwrite', (s) => s.delete(key))
    },
  }
}

// ─── Internals ──────────────────────────────────────────────────────────

function resolveStore(store: DeviceTrustStore | undefined): DeviceTrustStore {
  if (store) return store
  if (typeof indexedDB === 'undefined') {
    throw new DeviceTrustStorageError()
  }
  return indexedDbDeviceTrustStore()
}

function recordKey(vault: string): string {
  return RECORD_KEY_PREFIX + vault
}

function isDeviceTrustRecord(value: unknown): value is DeviceTrustRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { key?: unknown; state?: unknown }
  if (typeof CryptoKey === 'undefined' || !(record.key instanceof CryptoKey)) return false
  const state = record.state as { _noydb_device_trust?: unknown } | undefined
  return typeof state === 'object' && state !== null && state._noydb_device_trust === 1
}
