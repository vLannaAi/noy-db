/**
 * **Invite + peer-recovery primitives.**
 *
 * Layered on top of `db.grant` (for invite, mints a NEW user) and
 * `db.recoverUser` (for peer-recovery, rewraps an EXISTING user under
 * a fresh temp passphrase). These flows are SIBLINGS of the existing
 * delegation-grant primitives in `./index.ts` — different threat
 * model, different on-disk audit shape, no server-held secret.
 *
 * ## Threat model
 *
 * The temp passphrase travels in the **URL fragment** — server-blind
 * transport (fragments don't traverse TLS proxies, don't appear in
 * access logs). Trade-off: any party who sees the URL can claim the
 * invite once. Single-use semantics close the window: `acceptInvite`
 * rotates the passphrase atomically, marking the audit doc accepted —
 * a second `acceptInvite` call rejects.
 *
 * ## What this module does NOT do
 *
 * - Send emails / construct HTTPS URLs (that's the application layer)
 * - Validate the invite under HTTPS (caller's responsibility)
 * - Coordinate with a server-held secret (delegation grants do that;
 *   invite is server-blind by design)
 *
 * @module
 */
import {
  generateULID,
  createNoydb,
  keyringRotatePassphrase,
  type Noydb,
  type NoydbStore,
  type EncryptedEnvelope,
  type Role,
  type FactorProof,
  type PassphrasePolicy,
} from '@noy-db/hub'

const INVITE_AUDIT_DOC_PREFIX = 'invite-audit-'
const INVITE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

// ─── Types ─────────────────────────────────────────────────────────────

/** Whether the payload mints a NEW user (invite) or rewraps an existing one (peer-recovery). */
export type InviteKind = 'invite' | 'peer-recovery'

/**
 * Serializable payload encoded into the URL fragment. The temp
 * passphrase is the secret; the rest is metadata the recipient
 * needs to open the right vault as the right user.
 */
export interface InvitePayload {
  /** ULID identifying this invite — used to look up the audit doc. */
  readonly tokenId: string
  readonly vault: string
  readonly userId: string
  readonly displayName?: string
  readonly role?: Role
  readonly kind: InviteKind
  /** Issuer's userId (for forensics; not enforced cryptographically). */
  readonly issuer: string
  /** Single-use temporary passphrase — replaced on `acceptInvite`. */
  readonly tempPhrase: string
  readonly expiresAt: string
}

/** Audit doc persisted at `_meta/invite-audit-<tokenId>`. */
export interface InviteAuditDoc {
  readonly _noydb_invite_audit: 1
  readonly tokenId: string
  readonly kind: InviteKind
  readonly issuer: string
  readonly target: string
  readonly expiresAt: string
  readonly issuedAt: string
  readonly revokedAt?: string
  readonly acceptedAt?: string
}

export interface IssueInviteOptions {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
  readonly ttlMs?: number
  /** Override the generated temp phrase (rare; deterministic tests). */
  readonly tempPhrase?: string
}

export interface IssuePeerRecoveryOptions {
  readonly userId: string
  readonly displayName?: string
  readonly role?: Role
  readonly ttlMs?: number
  readonly tempPhrase?: string
}

export interface IssueInviteResult {
  readonly payload: InvitePayload
  /**
   * URL-fragment-safe base64url encoding of the JSON payload. Embed
   * after a `#` in the application's invite URL. Decoded back at
   * accept time via `decodeInvitePayload`.
   */
  readonly encoded: string
}

export interface AcceptInviteOptions {
  /**
   * The recipient's NoydbStore. Typically the same shared store the
   * issuer used (e.g. a sync-peer pointing at a common backend) — the
   * recipient must reach the same `_keyring/<userId>` and
   * `_meta/invite-audit-<tokenId>` documents.
   */
  readonly store: NoydbStore
  /**
   * The recipient's chosen new passphrase. `acceptInvite` rotates
   * the temp phrase to this value atomically before returning. Must
   * pass the vault's phrase strength policy (or the recipient must
   * pass `validatePassphrase: false` via the underlying createNoydb
   * options — currently exposed via `noydbOptions`).
   */
  readonly newPhrase: string
  /**
   * Reference clock for TTL evaluation. Production callers leave
   * this `undefined`; tests pass a fixed date.
   */
  readonly now?: Date
  /**
   * Extra options forwarded to `createNoydb` when the recipient's
   * session opens. Useful for `policy`, `validatePassphrase`, or
   * `sessionPolicy` tweaks the application layer wants in scope.
   */
  readonly noydbOptions?: Omit<Parameters<typeof createNoydb>[0], 'store' | 'user' | 'secret'>
  /**
   * Forwarded to the inner `keyringRotatePassphrase` call so the
   * recipient's `newPhrase` is validated against the same policy the
   * vault uses elsewhere. Without this, the rotation step applies the
   * default phrase validator (lowercase letters + spaces) regardless
   * of any `customValidator` / `pattern` set on the vault — a
   * consumer using non-default phrase shapes (e.g. hyphen-separated
   * alphanumeric, BIP-39 word-lists, Thai/EN-mixed scripts) hits a
   * spurious `WeakPassphraseError`.
   *
   * `noydbOptions.policy.passphrase` is NOT auto-derived because
   * `noydbOptions` flows to the post-rotation `createNoydb`, not the
   * rotation itself. Passing the same `PassphrasePolicy` here and
   * (via `noydbOptions.policy.passphrase`) keeps both gates aligned.
   */
  readonly passphrasePolicy?: PassphrasePolicy
  /**
   * Skip phrase strength validation for the recipient's `newPhrase`.
   * Forwarded to the inner rotation. Use sparingly — bypasses the
   * structural rules that protect against weak phrases.
   */
  readonly allowWeakPassphrase?: boolean
}

export interface AcceptInviteResult {
  readonly db: Noydb
  readonly payload: InvitePayload
}

// ─── Errors ────────────────────────────────────────────────────────────

export class InviteExpiredError extends Error {
  readonly code = 'INVITE_EXPIRED' as const
  constructor(public readonly expiresAt: string) {
    super(`Invite expired at ${expiresAt}.`)
    this.name = 'InviteExpiredError'
  }
}

export class InviteRevokedError extends Error {
  readonly code = 'INVITE_REVOKED' as const
  constructor(public readonly tokenId: string, public readonly revokedAt: string) {
    super(`Invite ${tokenId} was revoked at ${revokedAt}.`)
    this.name = 'InviteRevokedError'
  }
}

export class InviteAlreadyAcceptedError extends Error {
  readonly code = 'INVITE_ALREADY_ACCEPTED' as const
  constructor(public readonly tokenId: string, public readonly acceptedAt: string) {
    super(`Invite ${tokenId} was already accepted at ${acceptedAt}. Single-use semantics enforced.`)
    this.name = 'InviteAlreadyAcceptedError'
  }
}

export class InviteAuditMissingError extends Error {
  readonly code = 'INVITE_AUDIT_MISSING' as const
  constructor(public readonly tokenId: string) {
    super(
      `Invite audit doc for ${tokenId} not found. The issuer may have used a different ` +
        'store, or the audit doc was deleted. Refusing to open a session — this is the ' +
        'revoked-link-shadow-keyring defense from #32.',
    )
    this.name = 'InviteAuditMissingError'
  }
}

// ─── Issue (server / issuer side) ──────────────────────────────────────

/**
 * Mint an invite for a NEW user. Generates a random temp phrase,
 * calls `db.grant({ userId, passphrase: tempPhrase })`, writes the
 * audit doc, and returns the URL-encodable payload.
 *
 * The recipient claims via `acceptInvite(encoded, { store, newPhrase })`;
 * the rotation inside `acceptInvite` invalidates the temp phrase
 * (single-use by construction).
 *
 * The issuing `db` must be constructed with `teamStrategy: withTeam()`
 * (from `@noy-db/hub/team`) — minting an invite is a multi-user grant,
 * which is the opt-in team capability since noy-db 0.3 (#267).
 *
 * @throws Whatever `db.grant` throws (TeamNotEnabledError when the issuing
 *         db lacks `withTeam()`, PrivilegeEscalationError,
 *         WeakPassphraseError if the temp phrase fails policy, …)
 */
export async function issueInvite(
  db: Noydb,
  vault: string,
  options: IssueInviteOptions,
): Promise<IssueInviteResult> {
  const tokenId = generateULID()
  const ttlMs = options.ttlMs ?? INVITE_DEFAULT_TTL_MS
  const tempPhrase = options.tempPhrase ?? generateTempPhrase()
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const issuer = (db as unknown as { options: { user: string } }).options.user

  // Mint the new user under the temp phrase. The recipient will
  // overwrite the wrapping at acceptInvite time via rotatePassphrase.
  await db.grant(vault, {
    userId: options.userId,
    displayName: options.displayName,
    role: options.role,
    passphrase: tempPhrase,
    // Allow weak temp phrase — random-generated phrases are
    // high-entropy but may not satisfy the human-typeable rules
    // (lowercase + spaces + min words). The recipient's chosen
    // newPhrase will be validated normally.
    allowWeakPassphrase: true,
  })

  const payload: InvitePayload = {
    tokenId,
    vault,
    userId: options.userId,
    displayName: options.displayName,
    role: options.role,
    kind: 'invite',
    issuer,
    tempPhrase,
    expiresAt,
  }

  await writeAuditDoc(getStore(db), vault, {
    _noydb_invite_audit: 1,
    tokenId,
    kind: 'invite',
    issuer,
    target: options.userId,
    expiresAt,
    issuedAt: new Date().toISOString(),
  })

  return { payload, encoded: encodeInvitePayload(payload) }
}

/**
 * Mint a peer-recovery for an EXISTING user. Generates a random temp
 * phrase, calls `db.recoverUser` (atomic; closes the partial-failure
 * window of compose-from-primitives), writes the audit doc, returns
 * the payload.
 *
 * Owner→owner is allowed (the policy gate `peer-recover-user` carries
 * the freshness factor). The `factors` argument forwards to the gate.
 */
export async function issuePeerRecovery(
  db: Noydb,
  vault: string,
  options: IssuePeerRecoveryOptions,
  factors?: { factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean },
): Promise<IssueInviteResult> {
  const tokenId = generateULID()
  const ttlMs = options.ttlMs ?? INVITE_DEFAULT_TTL_MS
  const tempPhrase = options.tempPhrase ?? generateTempPhrase()
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const issuer = (db as unknown as { options: { user: string } }).options.user

  await db.team.recoverUser(
    vault,
    {
      userId: options.userId,
      passphrase: tempPhrase,
      ...(options.role !== undefined && { role: options.role }),
      ...(options.displayName !== undefined && { displayName: options.displayName }),
      // Same allow-weak rationale as issueInvite.
      allowWeakPassphrase: true,
    },
    factors,
  )

  const payload: InvitePayload = {
    tokenId,
    vault,
    userId: options.userId,
    ...(options.displayName !== undefined && { displayName: options.displayName }),
    ...(options.role !== undefined && { role: options.role }),
    kind: 'peer-recovery',
    issuer,
    tempPhrase,
    expiresAt,
  }

  await writeAuditDoc(getStore(db), vault, {
    _noydb_invite_audit: 1,
    tokenId,
    kind: 'peer-recovery',
    issuer,
    target: options.userId,
    expiresAt,
    issuedAt: new Date().toISOString(),
  })

  return { payload, encoded: encodeInvitePayload(payload) }
}

/**
 * Mark an outstanding invite as revoked. After this, `acceptInvite`
 * for the same token rejects with `InviteRevokedError` BEFORE opening
 * any session — closes the "revoked-link silent shadow keyring"
 * defense (without the audit doc check, a revoked link could fall
 * through to `createNoydb`'s no-keyring auto-create path and create
 * a fresh empty vault).
 *
 * Idempotent — revoking an already-revoked invite is a no-op.
 *
 * Note: this does NOT delete the granted/recovered keyring; it only
 * marks the invite token as unusable. To fully cancel the invite,
 * call `db.revoke(vault, { userId })` separately. The two are split
 * because peer-recovery doesn't have a "cancel" — the target user
 * already existed.
 */
export async function revokeInvite(
  db: Noydb,
  vault: string,
  encodedOrPayload: string | InvitePayload,
): Promise<void> {
  const payload = typeof encodedOrPayload === 'string'
    ? decodeInvitePayload(encodedOrPayload)
    : encodedOrPayload
  const store = getStore(db)
  const audit = await readAuditDoc(store, vault, payload.tokenId)
  if (!audit) {
    // Nothing to revoke — token was never issued or audit was deleted.
    // Don't throw; revokeInvite is meant to be best-effort.
    return
  }
  if (audit.revokedAt !== undefined) {
    // Idempotent.
    return
  }
  await writeAuditDoc(store, vault, {
    ...audit,
    revokedAt: new Date().toISOString(),
  })
}

// ─── Accept (recipient side) ───────────────────────────────────────────

/**
 * Open the recipient's session under the invite. Validates TTL +
 * revoke + already-accepted, opens `createNoydb` with the temp
 * phrase, immediately rotates to `newPhrase`, marks the audit doc
 * accepted, returns the live `Noydb` instance.
 *
 * Single-use is enforced two ways:
 *   1. The rotation inside this function invalidates the temp phrase.
 *   2. The audit doc's `acceptedAt` field is set on success — a
 *      second `acceptInvite` call sees it and throws
 *      `InviteAlreadyAcceptedError`.
 *
 * @throws {@link InviteExpiredError} when TTL has passed.
 * @throws {@link InviteRevokedError} when the issuer has revoked.
 * @throws {@link InviteAlreadyAcceptedError} on second call.
 * @throws {@link InviteAuditMissingError} when no audit doc — closes
 *         the revoked-link-shadow-keyring defense.
 */
export async function acceptInvite(
  encoded: string,
  options: AcceptInviteOptions,
): Promise<AcceptInviteResult> {
  const payload = decodeInvitePayload(encoded)
  const now = options.now ?? new Date()

  // Pre-flight: TTL + audit + revoke + already-accepted checks all
  // run before opening any noydb session. This is the
  // "revoked-link-shadow-keyring defense" — a missing audit doc must
  // NOT silently fall through to createNoydb's auto-create path.
  if (now.getTime() > Date.parse(payload.expiresAt)) {
    throw new InviteExpiredError(payload.expiresAt)
  }
  const audit = await readAuditDoc(options.store, payload.vault, payload.tokenId)
  if (!audit) {
    throw new InviteAuditMissingError(payload.tokenId)
  }
  if (audit.revokedAt !== undefined) {
    throw new InviteRevokedError(payload.tokenId, audit.revokedAt)
  }
  if (audit.acceptedAt !== undefined) {
    throw new InviteAlreadyAcceptedError(payload.tokenId, audit.acceptedAt)
  }

  // Atomic rotate inside acceptInvite. We call the
  // team-level `keyringRotatePassphrase` directly rather than going
  // through `db.rotatePassphrase`, which is gated by the
  // `rotate-passphrase` policy gate (PERSONAL_POLICY requires a
  // factor proof there). In the invite flow, the temp phrase reaching
  // the recipient through a trusted issuer-side audit-trailed channel
  // IS the freshness proof — the policy gate's factor requirement
  // doesn't apply to "rotate FROM a temp phrase delivered via the
  // invite mechanism." The audit-doc-presence check above + this
  // single rotation closes the single-use semantics by construction.
  await keyringRotatePassphrase(options.store, payload.vault, payload.userId, {
    oldPassphrase: payload.tempPhrase,
    newPassphrase: options.newPhrase,
    ...(options.passphrasePolicy !== undefined && { passphrasePolicy: options.passphrasePolicy }),
    ...(options.allowWeakPassphrase !== undefined && { allowWeakPassphrase: options.allowWeakPassphrase }),
  })

  // Mark accepted — second acceptInvite for this token throws.
  await writeAuditDoc(options.store, payload.vault, {
    ...audit,
    acceptedAt: new Date().toISOString(),
  })

  // Open the recipient's session under the now-rotated phrase. The
  // returned `db` handle is what they use going forward.
  const db = await createNoydb({
    store: options.store,
    user: payload.userId,
    secret: options.newPhrase,
    ...options.noydbOptions,
  })
  await db.openVault(payload.vault)

  return { db, payload }
}

// ─── Encoding ──────────────────────────────────────────────────────────

/** Encode the payload as a URL-fragment-safe base64url string. */
export function encodeInvitePayload(payload: InvitePayload): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  return base64UrlEncode(bytes)
}

/** Decode a base64url string back to an InvitePayload. */
export function decodeInvitePayload(encoded: string): InvitePayload {
  const bytes = base64UrlDecode(encoded)
  const json = new TextDecoder().decode(bytes)
  return JSON.parse(json) as InvitePayload
}

// ─── Internals ─────────────────────────────────────────────────────────

/** Best-effort getter for the `NoydbStore` from a `Noydb` instance. */
function getStore(db: Noydb): NoydbStore {
  // The store is configured at createNoydb time but not exposed via a
  // public getter; reaching into options is the documented escape
  // hatch (the same pattern used for direct store access).
  return (db as unknown as { options: { store: NoydbStore } }).options.store
}

async function readAuditDoc(
  store: NoydbStore,
  vault: string,
  tokenId: string,
): Promise<InviteAuditDoc | undefined> {
  const env = await store.get(vault, '_meta', INVITE_AUDIT_DOC_PREFIX + tokenId)
  if (!env) return undefined
  try {
    return JSON.parse(env._data) as InviteAuditDoc
  } catch {
    return undefined
  }
}

async function writeAuditDoc(
  store: NoydbStore,
  vault: string,
  doc: InviteAuditDoc,
): Promise<void> {
  const envelope: EncryptedEnvelope = {
    _noydb: 1 as const,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(doc),
  }
  await store.put(vault, '_meta', INVITE_AUDIT_DOC_PREFIX + doc.tokenId, envelope)
}

/**
 * Generate a high-entropy random temp passphrase. Uses 256 bits of
 * entropy, base32-encoded — readable enough to log for forensics
 * without being trivially copy-paste typeable.
 */
function generateTempPhrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  // Use the existing magic-link ULID format pattern: hex bytes joined
  // with hyphens every 8 chars. Functionally equivalent to base32 for
  // a temp string the user never types.
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(s: string): Uint8Array {
  // Pad back to a multiple of 4 if needed.
  let padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  padded += '='.repeat(padLen)
  const decoded = atob(padded)
  const out = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i)
  return out
}
