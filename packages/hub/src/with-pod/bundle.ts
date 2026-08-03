/**
 * `.noydb` container primitives — write, read, header-only read.
 *
 *. Wraps a `vault.dump()` JSON string in the
 * binary container described in `format.ts`.
 *
 * **Three primitives:**
 *
 *   - `writePod(vault, opts?)` — produces the
 *     full container bytes ready to write to disk or upload
 *   - `readPodHeader(bytes)` — parses just the header
 *     without decompressing the body, fast file-type and
 *     metadata read for cloud listing UIs
 *   - `readPod(bytes)` — full read: validates magic,
 *     header, integrity hash, and decompresses the body to
 *     return the original `dump()` JSON string for use with
 *     `vault.load()`
 *
 * **Compression strategy:** brotli when available (Node 22+,
 * Chrome 124+, Firefox 122+), gzip fallback elsewhere. The
 * algorithm choice is encoded in the format byte at offset 5,
 * so readers handle either transparently. Brotli wins ~30-50%
 * on JSON payloads with repeated keys (which vault dumps
 * are).
 *
 * **Why split read/load?** `readPod` returns the
 * *unwrapped JSON string*, not a Vault object. The caller
 * is responsible for piping that JSON into
 * `vault.load(json, secret)`. Splitting the layers
 * keeps the bundle module free of any crypto/secret
 * concerns — it's purely a format layer. The same `readPod`
 * call can also feed verification tools, format inspectors, or
 * archive utilities that don't care about decryption.
 */

import {
  COMPRESSION_BROTLI,
  COMPRESSION_GZIP,
  COMPRESSION_NONE,
  FLAG_COMPRESSED,
  FLAG_HAS_INTEGRITY_HASH,
  NOYDB_BUNDLE_FORMAT_VERSION,
  NOYDB_BUNDLE_FORMAT_VERSION_SIGNED,
  NOYDB_BUNDLE_MAGIC,
  NOYDB_BUNDLE_PREFIX_BYTES,
  decodeBundleHeader,
  encodeBundleHeader,
  hasNoydbBundleMagic,
  readUint32BE,
  writeUint32BE,
  type CompressionAlgo,
  type NoydbPodHeader,
  type UnlockMethod,
} from './format.js'
import { signRecord, verifyRecord } from './signature.js'
import type { Redirect } from './redirect.js'
import type { DocSigner } from '../with-audit/attestation/signer.js'
import { sha256Hex as sha256HexBytes } from '../kernel/enclave/index.js'
import { BundleIntegrityError, BundleSealMismatchError, ValidationError } from '../kernel/errors.js'
import type { Vault } from '../kernel/vault.js'
import type { BundleRecipient } from '../with-party/team/keyring.js'
import { pickLocale } from '../with-party/directory/cover/storage.js'
import type { Cover } from '../with-party/directory/cover/types.js'
import type { SealingKeyProvider, RecipientSealer, RecipientHint } from '../with-party/team/managed-secret.js'

// ─── Auto-credential types ────────────────────────────────────────────────────

/**
 * The credential kinds that can be bundled for auto-unlock.
 * WebAuthn is intentionally excluded — it is hardware-bound and
 * cannot be embedded as a portable credential.
 */
export type AutoCredentialKind = 'secret' | 'password' | 'pin'

/**
 * A typed credential for auto-unlock. Carries the credential `kind`
 * alongside the plaintext `value`, so consumers can dispatch the
 * correct login/prefill path rather than treating all credentials
 * as secrets.
 *
 * `bundle.ts` is a pure format layer — it carries the credential
 * without interpreting it. The consumer is responsible for
 * dispatching on `kind`.
 */
export interface AutoCredential {
  readonly kind: AutoCredentialKind
  readonly value: string
}

/**
 * Options accepted by `writePod`.
 *
 * - `compression: 'auto'` (default) — try brotli, fall back to gzip
 * - `compression: 'brotli'` — force brotli, throw if unsupported
 * - `compression: 'gzip'` — force gzip
 * - `compression: 'none'` — no compression (round-trip testing only)
 *
 * **Slice filtering:**
 * - `collections` — allowlist of collection names to include. Internal
 *   collections (keyrings, ledger) and excluded user collections are
 *   dropped from the bundle. Records inside included collections are
 *   carried through verbatim.
 * - `since` — only records whose envelope `_ts` is on/after the given
 *   instant survive. Operates on the unencrypted envelope timestamp,
 *   so plaintext access to records is not required.
 *
 * Both filters intersect (AND). When neither is provided the bundle is
 * a whole-vault snapshot, identical to today's behaviour.
 */
export interface WritePodOptions {
  readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none'
  /** Allowlist of user-collection names to include. */
  readonly collections?: readonly string[]
  /**
   * Drop records whose envelope `_ts` is strictly older than this
   * instant. Accepts a `Date` or any ISO-8601 string parseable by
   * `new Date()`.
   */
  readonly since?: Date | string
  /**
   * Plaintext-pipeline record predicate. Decrypts each record
   * with the vault's per-collection DEK, runs the predicate, and
   * keeps the original ciphertext for survivors (no re-encrypt —
   * preserves zero-knowledge cleanly). Records the predicate returns
   * `false` for are dropped from the bundle.
   *
   * Async predicates are supported. Mutating the record from inside
   * the predicate is undefined behaviour.
   */
  readonly where?: (
    record: unknown,
    ctx: { collection: string; id: string },
  ) => boolean | Promise<boolean>
  /**
   * Hierarchical-tier ceiling. Records whose envelope `_tier`
   * is strictly greater than this number are dropped. Operates on the
   * envelope `_tier` (no decryption needed) — vault.exportStream is
   * referenced in the issue body for symmetry, but the tier value
   * lives on the unencrypted envelope. Vault without tiers is a no-op.
   */
  readonly tierAtMost?: number
  /**
   * Single-recipient re-keying shorthand. When set, the
   * bundle's keyring is replaced with one freshly-derived entry sealed
   * with this secret. The recipient inherits the source keyring's
   * userId, role, and permissions. Mutually exclusive with `recipients`.
   */
  readonly exportSecret?: string
  /**
   * Multi-recipient re-keying. Replaces the bundle's keyring
   * map with one slot per recipient, each sealed with its own
   * secret. DEKs are unwrapped from the source keyring once and
   * re-wrapped per recipient — record ciphertext is unchanged.
   *
   * Mutually exclusive with `exportSecret`. When neither is set,
   * the bundle inherits the source keyring as-is (today's behaviour,
   * suited to personal backup-and-restore).
   */
  readonly recipients?: readonly BundleRecipient[]
  /**
   * Auto-unlock — unsealed per-user credentials.
   *
   * Generalises `autoSecrets` to support any bundleable credential
   * kind (`secret` | `password` | `pin`).
   *
   * Public-by-design: anyone holding the bundle bytes can read these
   * plaintext credentials. Use for demo data, sample vaults,
   * prospect onboarding.
   *
   * The `policy: 'public-by-design'` discriminant is mandatory. A
   * bare `{ perUser }` without it is rejected at write time — the
   * safety net against a careless call against a production vault.
   *
   * Mutually exclusive with `sealedCredentials`, `autoSecrets`,
   * and `sealedSecrets`.
   */
  readonly autoCredentials?: {
    readonly policy: 'public-by-design'
    readonly perUser: Record<string, AutoCredential>
  }
  /**
   * Auto-unlock — per-user credentials sealed under a
   * {@link SealingKeyProvider}.
   *
   * Generalises `sealedSecrets` to support any bundleable
   * credential kind (`secret` | `password` | `pin`).
   *
   * The hub seals each user's plaintext credential under `provider`
   * and embeds the resulting sealed envelopes in the bundle. The
   * recipient must hold a provider with a matching `pid` (i.e.,
   * `provider.id`) to auto-unseal on import.
   *
   * `mode: 'self-target'` — sender and recipient share the same
   * provider identity (same iCloud Keychain entry, same
   * MDM-provisioned bundle id, same KMS account, etc.).
   *
   * `mode: 'recipient-target'` — asymmetric sealing via a
   * {@link RecipientSealer}. Each user entry carries a
   * `credential` and a `hint` (the recipient's public material).
   * The bundle can only be unsealed by the holder of the matching
   * private key.
   *
   * Mutually exclusive with `autoCredentials`, `autoSecrets`,
   * and `sealedSecrets`.
   */
  readonly sealedCredentials?:
    | {
        readonly mode: 'self-target'
        readonly provider: SealingKeyProvider
        readonly perUser: Record<string, AutoCredential>
      }
    | {
        readonly mode: 'recipient-target'
        readonly provider: RecipientSealer
        readonly perUser: Record<string, { readonly credential: AutoCredential; readonly hint: RecipientHint }>
      }
  /**
   * @deprecated Use `autoCredentials` instead.
   *
   * Auto-unlock — unsealed per-user secrets.
   *
   * Public-by-design: anyone holding the bundle bytes can read these
   * plaintext credentials. Use for demo data, sample vaults,
   * prospect onboarding.
   *
   * The `policy: 'public-by-design'` discriminant is mandatory. A
   * bare `{ perUser }` without it is rejected at write time — the
   * safety net against a careless call against a production vault.
   *
   * Mutually exclusive with `autoCredentials`, `sealedCredentials`,
   * and `sealedSecrets`.
   */
  readonly autoSecrets?: {
    readonly policy: 'public-by-design'
    readonly perUser: Record<string, string>
  }
  /**
   * @deprecated Use `sealedCredentials` instead.
   *
   * Auto-unlock — per-user secrets sealed under a
   * {@link SealingKeyProvider} (self-target only).
   *
   * The hub seals each user's plaintext secret under `provider`
   * and embeds the resulting sealed envelopes in the bundle. The
   * recipient must hold a provider with a matching `pid` (i.e.,
   * `provider.id`) to auto-unseal on import.
   *
   * `mode: 'self-target'` is the only mode for `sealedSecrets` — sender
   * and recipient share the same provider identity (same iCloud Keychain
   * entry, same MDM-provisioned bundle id, same KMS account, etc.).
   * For recipient-target sealing via the `RecipientSealer` interface,
   * use `sealedCredentials` with `mode: 'recipient-target'` (§11.4).
   *
   * Mutually exclusive with `autoCredentials`, `sealedCredentials`,
   * and `autoSecrets`.
   */
  readonly sealedSecrets?: {
    readonly mode: 'self-target'
    readonly provider: SealingKeyProvider
    readonly perUser: Record<string, string>
  }
  /**
   * Pod-header signing control (#943).
   *
   *   - omitted (default) — sign the header iff the source vault has a
   *     persisted document signer (`vault._loadPodSigner()` returns
   *     non-null). A vault that never minted a signer produces an
   *     unsigned `formatVersion: 1` header, exactly as before.
   *   - `false` — never sign, even if a signer is persisted.
   *   - an explicit {@link DocSigner} — sign with the supplied keypair
   *     without touching the vault's persisted signer (test / advanced
   *     injection). Does not mint or persist anything.
   *
   * Signing NEVER mints a signer as a side effect of export: an absent
   * signer means an unsigned pod, not an on-the-fly key generation.
   */
  readonly sign?: false | DocSigner
  /**
   * Header L2 fields (#942) — pre-auth dispatch metadata written verbatim
   * into the pod header. See `NoydbPodHeader` for the disclosure rationale
   * of each. All optional; absence produces a legacy-shaped header exactly
   * as before.
   */
  readonly engineRange?: string
  readonly unlockMethods?: readonly UnlockMethod[]
  readonly hasApp?: boolean
  readonly species?: 'full' | 'connection' | 'snapshot' | 'redirect' | 'group'
  readonly pointerMode?: 'public' | 'private'
  /**
   * Signed "this moved, go there" pointer (#944), written verbatim into
   * the plaintext header. Pass an already-signed {@link Redirect}
   * (mint one via `signRedirect`) — `writePod` does not sign it for you.
   */
  readonly redirect?: Redirect
}

/** @deprecated Use `WritePodOptions`. */
export type WriteNoydbBundleOptions = WritePodOptions

/**
 * Result returned by `readPod`. The caller is expected to
 * pass `dumpJson` into `vault.load(json, secret)` to
 * actually restore a vault. Splitting the layers keeps the
 * bundle module free of crypto concerns — see file-level docs.
 */
export interface NoydbBundleReadResult {
  readonly header: NoydbPodHeader
  readonly dumpJson: string
  /**
   * Auto-unlock material. Present only when
   * the header's `autoUnlock` flag is set AND the body's wrapped
   * structure survived parsing. Values are typed credentials — either
   * delivered plain (`kind: 'unsealed'`) or unsealed at read time
   * using one of the supplied `sealingProviders` (`kind: 'sealed'`).
   *
   * Consumers dispatch on `cred.kind` to choose the correct login /
   * prefill path. Pre-0.2 bundles (bare string entries) are coerced
   * to `{ kind: 'secret', value }` on read for back-compat.
   *
   * For `kind: 'sealed'` bundles read without `sealingProviders`, the
   * `value` field is the raw base64 sealed bytes — opaque to the
   * consumer until unsealed elsewhere.
   */
  readonly autoUnlock?: {
    readonly kind: 'unsealed' | 'sealed'
    readonly perUser: Record<string, AutoCredential>
  }
}

/**
 * Sealed credential entry as it appears in the bundle body's
 * `_autoUnlock.perUser` map when the bundle was written with
 * `sealedCredentials` (or the deprecated `sealedSecrets`).
 * Provider's sealed output is base64-encoded; the `pid` is the
 * dispatch key matched against recipient-supplied
 * `SealingKeyProvider.id`. The `kind` carries the plaintext-tier
 * metadata so the consumer can dispatch on credential type without
 * unsealing first.
 *
 * Back-compat: `kind` is absent in older bundles — readers must
 * default to `'secret'` when not present.
 */
interface SealedAutoUnlockEntry {
  readonly pid: string
  readonly sealed: string
  readonly alg: 'aes-256-gcm'
  readonly kind?: AutoCredentialKind
  /**
   * Recipient-target only: the RecipientHint the sender used to seal.
   * Carried for recipient verifiability ("yes this was sealed against
   * my published hint"). Self-target entries omit it. Pre-0.2 readers
   * ignore unknown fields, so this is back-compatible.
   */
  readonly hint?: RecipientHint
}

/**
 * Discriminated wrapper carried in the bundle body when the header's
 * `autoUnlock` flag is set. Without the flag, the body is the raw
 * `vault.dump()` JSON string.
 *
 * Back-compat: older bundles carry bare `string` values in the
 * unsealed `perUser` map. Readers must coerce those to
 * `{ kind: 'secret', value }`.
 */
interface AutoUnlockBody {
  readonly _noydb_bundle_body: 1
  readonly dump: string
  readonly _autoUnlock:
    | { readonly kind: 'unsealed'; readonly perUser: Record<string, AutoCredential | string> }
    | { readonly kind: 'sealed'; readonly perUser: Record<string, SealedAutoUnlockEntry> }
}

/**
 * Options accepted by {@link readPod} for the
 * auto-unlock paths. Without these the reader behaves exactly as before
 * (header parsed; body returned as `dumpJson`).
 */
export interface ReadNoydbBundleOptions {
  /**
   * Recipient-side sealing providers used to unseal entries from
   * `sealedSecrets`. The reader picks the one whose `.id`
   * matches each entry's `pid`. Multiple providers may be supplied
   * (different users may seal under different identities).
   *
   * When unset and the bundle carries sealed envelopes, the
   * `autoUnlock.perUser` map remains the SEALED entries unmodified
   * — callers can inspect them or unseal elsewhere.
   */
  readonly sealingProviders?: readonly SealingKeyProvider[]
  /**
   * Opt-in trial mode for unsealing — when an entry's `pid` doesn't
   * match a registered provider, try each provider whose alg
   * matches. Default `false` (strict-pid dispatch per foundation
   * §11.9.2). Surfaces extra credential prompts; use deliberately.
   */
  readonly attemptUnsealAcrossProviders?: boolean
}

// ─── Auto-unlock helpers ──────────────────────────────────────────────────────

/**
 * Internal normalized form of the auto-unlock options, computed once
 * from the four public-facing fields (autoCredentials, sealedCredentials,
 * autoSecrets, sealedSecrets). Callers work against this shape
 * so the build + validate paths share a single normalizer.
 */
interface NormalizedAutoUnlock {
  readonly mode: 'unsealed' | 'sealed-self' | 'sealed-recipient'
  readonly provider?: SealingKeyProvider | RecipientSealer
  readonly perUser: Record<string, AutoCredential>
  /** Present only for `sealed-recipient`. Same key set as `perUser`. */
  readonly hints?: Record<string, RecipientHint>
}

/**
 * Coerce a `Record<string, string>` (legacy secret-only map) into
 * a `Record<string, AutoCredential>` by tagging each entry as
 * `kind: 'secret'`. Used by the normalizer to promote the deprecated
 * `autoSecrets`/`sealedSecrets` sugar.
 */
function toAutoCredentials(m: Record<string, string>): Record<string, AutoCredential> {
  return Object.fromEntries(
    Object.entries(m).map(([u, value]) => [u, { kind: 'secret' as const, value }]),
  )
}

/**
 * Normalize the four auto-unlock option fields into a single
 * `NormalizedAutoUnlock` (or `null` when none is set). Enforces mutual
 * exclusion — exactly one of the four may be present. Promotes the
 * deprecated sugar fields to `AutoCredential` shape.
 *
 * Does NOT validate field-level constraints (policy marker, perUser
 * length, mode, provider presence, kind allowlist) — those are checked
 * in `validateAutoUnlockOptions` after normalization.
 */
function normalizeAutoUnlock(opts: WritePodOptions): NormalizedAutoUnlock | null {
  const set = [
    opts.autoCredentials,
    opts.sealedCredentials,
    opts.autoSecrets,
    opts.sealedSecrets,
  ].filter(v => v !== undefined).length
  if (set === 0) return null
  if (set > 1) {
    throw new ValidationError(
      'writePod: only one of autoCredentials / sealedCredentials / '
      + 'autoSecrets / sealedSecrets may be set.',
    )
  }
  if (opts.autoCredentials !== undefined) {
    return { mode: 'unsealed', perUser: opts.autoCredentials.perUser }
  }
  if (opts.autoSecrets !== undefined) {
    return { mode: 'unsealed', perUser: toAutoCredentials(opts.autoSecrets.perUser) }
  }
  if (opts.sealedCredentials !== undefined) {
    if (opts.sealedCredentials.mode === 'recipient-target') {
      const perUser: Record<string, AutoCredential> = {}
      const hints: Record<string, RecipientHint> = {}
      for (const [userId, entry] of Object.entries(opts.sealedCredentials.perUser)) {
        perUser[userId] = entry.credential
        hints[userId] = entry.hint
      }
      return { mode: 'sealed-recipient', provider: opts.sealedCredentials.provider, perUser, hints }
    }
    return { mode: 'sealed-self', provider: opts.sealedCredentials.provider, perUser: opts.sealedCredentials.perUser }
  }
  // sealedSecrets — only remaining option
  return {
    mode: 'sealed-self',
    provider: opts.sealedSecrets!.provider,
    perUser: toAutoCredentials(opts.sealedSecrets!.perUser),
  }
}

/**
 * Validate the auto-unlock options and return the resulting header
 * `autoUnlock` value (or null when no auto-unlock requested).
 *
 * Takes the pre-computed `NormalizedAutoUnlock` so the caller (i.e.
 * `writePod`) can pass the same object to `buildAutoUnlockWrapper`
 * without a second `normalizeAutoUnlock` call.
 *
 * Validation per spec (§3):
 *   - (mutual exclusion already enforced by normalizeAutoUnlock)
 *   - unsealed path: `policy: 'public-by-design'` marker required
 *   - non-empty `perUser` maps
 *   - sealed path: provider present; both `mode: 'self-target'` and `mode: 'recipient-target'` accepted; recipient-target requires a `RecipientSealer` provider and per-user `hint` (§11.4)
 *   - every AutoCredential.kind ∈ {secret, password, pin}
 *     (WebAuthn is hardware-bound and cannot be bundled)
 *
 * Throws {@link ValidationError} on any violation.
 */
function validateAutoUnlockOptions(
  opts: WritePodOptions,
  normalized: NormalizedAutoUnlock | null,
): 'unsealed' | 'sealed' | null {
  if (normalized === null) return null

  const VALID_KINDS: ReadonlySet<string> = new Set(['secret', 'password', 'pin'])

  // Validate every credential kind before any further checks.
  for (const [userId, cred] of Object.entries(normalized.perUser)) {
    if (!VALID_KINDS.has(cred.kind)) {
      throw new ValidationError(
        `writePod: credential for user '${userId}' has unsupported kind '${cred.kind}'. `
        + 'auto-unlock supports secret/password/pin only; WebAuthn is hardware-bound '
        + 'and cannot be bundled.',
      )
    }
  }

  if (normalized.mode === 'unsealed') {
    // Read the policy marker from whichever active option carries it.
    const policy = opts.autoCredentials?.policy ?? opts.autoSecrets?.policy
    if (policy !== 'public-by-design') {
      throw new ValidationError(
        'writePod: `autoCredentials` (or `autoSecrets`) requires '
        + '`policy: "public-by-design"`. '
        + 'This is an explicit opt-in marker — bundling plaintext credentials is '
        + 'safe only when those credentials are intended to be public (demo data, '
        + 'sample vaults). For production credentials, use `sealedCredentials` instead.',
      )
    }
    const userCount = Object.keys(normalized.perUser).length
    if (userCount === 0) {
      throw new ValidationError(
        'writePod: `autoCredentials.perUser` (or `autoSecrets.perUser`) '
        + 'must have at least one entry.',
      )
    }
    return 'unsealed'
  }

  // Sealed path — branch on mode.
  if (normalized.mode === 'sealed-recipient') {
    const provider = normalized.provider
    if (provider === undefined || typeof (provider as RecipientSealer).publishRecipientHint !== 'function'
        || typeof (provider as RecipientSealer).sealForRecipient !== 'function') {
      throw new ValidationError(
        'writePod: `sealedCredentials.provider` for mode \'recipient-target\' must be a '
        + 'RecipientSealer (publishRecipientHint + sealForRecipient). Self-only providers '
        + '(MemorySealingKeyProvider, at-macos-keychain, etc.) do not satisfy this contract.',
      )
    }
    const hints = normalized.hints
    if (hints === undefined) {
      throw new Error('unreachable — sealed-recipient normalization must populate hints')
    }
    for (const userId of Object.keys(normalized.perUser)) {
      const hint = hints[userId]
      if (hint === undefined) {
        throw new ValidationError(
          `writePod: \`sealedCredentials.perUser['${userId}']\` missing required \`hint\` for mode 'recipient-target'.`,
        )
      }
      if (hint.v !== 1) {
        throw new ValidationError(
          `writePod: \`sealedCredentials.perUser['${userId}'].hint.v\` must be 1 (got ${String(hint.v)}).`,
        )
      }
      if (typeof hint.pid !== 'string' || hint.pid.length === 0) {
        throw new ValidationError(
          `writePod: \`sealedCredentials.perUser['${userId}'].hint.pid\` must be a non-empty string identifying the recipient.`,
        )
      }
      if (hint.alg !== 'rsa-oaep-sha256') {
        throw new ValidationError(
          `writePod: \`sealedCredentials.perUser['${userId}'].hint.alg\` must be 'rsa-oaep-sha256' in slice 1 (got '${String(hint.alg)}').`,
        )
      }
      // Note: hint.pid identifies the recipient, not the sender — no pid===sender.id check here.
      // The sender holds a RecipientSealer that calls sealForRecipient(plaintext, hint);
      // the hint's pid is the dispatch key on the reader side (matched against recipient providers).
    }
    const userCount = Object.keys(normalized.perUser).length
    if (userCount === 0) {
      throw new ValidationError(
        'writePod: `sealedCredentials.perUser` must have at least one entry.',
      )
    }
    return 'sealed'
  }

  // mode === 'sealed-self'
  const selfTargetMode = opts.sealedCredentials?.mode ?? opts.sealedSecrets?.mode
  if (selfTargetMode !== 'self-target') {
    throw new ValidationError(
      `writePod: \`sealedCredentials.mode\` (or \`sealedSecrets.mode\`) must be `
      + `'self-target' or 'recipient-target' (got '${String(selfTargetMode)}').`,
    )
  }
  if (normalized.provider === undefined) {
    throw new ValidationError(
      'writePod: `sealedCredentials.provider` (or `sealedSecrets.provider`) '
      + 'is required (a `SealingKeyProvider`).',
    )
  }
  const userCount = Object.keys(normalized.perUser).length
  if (userCount === 0) {
    throw new ValidationError(
      'writePod: `sealedCredentials.perUser` (or `sealedSecrets.perUser`) '
      + 'must have at least one entry.',
    )
  }
  return 'sealed'
}

/**
 * Build the body wrapper carrying the dump + `_autoUnlock` blob.
 * Takes the pre-computed `NormalizedAutoUnlock` so both validate and
 * build work off the same normalized form (no double-normalize).
 */
async function buildAutoUnlockWrapper(
  dumpJson: string,
  normalized: NormalizedAutoUnlock,
): Promise<AutoUnlockBody> {
  if (normalized.mode === 'unsealed') {
    return {
      _noydb_bundle_body: 1,
      dump: dumpJson,
      _autoUnlock: {
        kind: 'unsealed',
        perUser: { ...normalized.perUser },
      },
    }
  }
  // Sealed path — branch on mode.
  const provider = normalized.provider
  if (provider === undefined) {
    throw new Error('unreachable — validation should have caught this')
  }
  const sealedPerUser: Record<string, SealedAutoUnlockEntry> = {}
  const encoder = new TextEncoder()

  if (normalized.mode === 'sealed-recipient') {
    const recipientSealer = provider as RecipientSealer
    const hints = normalized.hints
    if (hints === undefined) {
      throw new Error('unreachable — sealed-recipient normalization must populate hints')
    }
    for (const [userId, cred] of Object.entries(normalized.perUser)) {
      const hint = hints[userId]!
      const sealed = await recipientSealer.sealForRecipient(encoder.encode(cred.value), hint)
      sealedPerUser[userId] = {
        pid: hint.pid,                  // use the recipient's pid, not the sender's
        sealed: bytesToBase64(sealed),
        alg: 'aes-256-gcm',
        kind: cred.kind,
        hint,
      }
    }
  } else {
    // mode === 'sealed-self'
    const selfSealer = provider as SealingKeyProvider
    for (const [userId, cred] of Object.entries(normalized.perUser)) {
      const sealed = await selfSealer.seal(encoder.encode(cred.value))
      sealedPerUser[userId] = {
        pid: selfSealer.id,
        sealed: bytesToBase64(sealed),
        alg: 'aes-256-gcm',
        kind: cred.kind,
      }
    }
  }

  return {
    _noydb_bundle_body: 1,
    dump: dumpJson,
    _autoUnlock: { kind: 'sealed', perUser: sealedPerUser },
  }
}

/**
 * Parse the body bytes when the header signaled an auto-unlock.
 * Returns the inner `dump` JSON string + the `_autoUnlock` blob;
 * throws if the wrapper structure is malformed.
 */
function parseAutoUnlockBody(bodyString: string): { dump: string; blob: AutoUnlockBody['_autoUnlock'] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyString)
  } catch (err) {
    throw new BundleIntegrityError(
      'header declared autoUnlock but body could not be parsed as JSON wrapper: '
      + (err instanceof Error ? err.message : String(err)),
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BundleIntegrityError('autoUnlock body is not a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj['_noydb_bundle_body'] !== 1) {
    throw new BundleIntegrityError(
      'autoUnlock body missing `_noydb_bundle_body: 1` discriminator',
    )
  }
  if (typeof obj['dump'] !== 'string') {
    throw new BundleIntegrityError('autoUnlock body must carry a string `dump` field')
  }
  const blob = obj['_autoUnlock']
  if (typeof blob !== 'object' || blob === null) {
    throw new BundleIntegrityError('autoUnlock body missing `_autoUnlock` blob')
  }
  const blobObj = blob as Record<string, unknown>
  const kind = blobObj['kind']
  if (kind !== 'unsealed' && kind !== 'sealed') {
    throw new BundleIntegrityError(
      `autoUnlock blob has invalid kind ${String(kind)}; expected 'unsealed' or 'sealed'`,
    )
  }
  return {
    dump: obj['dump'],
    blob: blob as AutoUnlockBody['_autoUnlock'],
  }
}

/**
 * Transfer-seal payload. The destination DEKs, exported to raw
 * bytes and AES-256-GCM-sealed *as a set* under the one-time transfer
 * key. `adoptPartition` unseals this; `createOwnerOnAdoptedPartition`
 * re-wraps the raw DEKs under the recipient's KEK.
 */
export interface TransferSealPayload {
  readonly v: 1
  readonly alg: 'aes-256-gcm-pre-shared'
  readonly sealId: string
  /** base64(AES-256-GCM(transferKey, JSON of { collection: base64(rawDEK) })) — iv ‖ ct ‖ tag. */
  readonly payload: string
}

/**
 * Body wrapper for an extracted, transfer-sealed partition.
 * Sibling to {@link AutoUnlockBody}; selected by `header.bundleKind ===
 * 'extracted-partition'`. The inner `dump` is a re-keyed projection with
 * an empty `keyrings` map.
 */
export interface ExtractedPartitionBody {
  readonly _noydb_bundle_body: 1
  readonly dump: string
  readonly _transferSeal: TransferSealPayload
}

export function buildExtractedPartitionWrapper(
  dumpJson: string,
  seal: TransferSealPayload,
): ExtractedPartitionBody {
  return { _noydb_bundle_body: 1, dump: dumpJson, _transferSeal: seal }
}

export function parseExtractedPartitionBody(
  bodyString: string,
): { dump: string; seal: TransferSealPayload } {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyString)
  } catch (err) {
    throw new BundleIntegrityError(
      'header declared extracted-partition but body could not be parsed as JSON wrapper: '
      + (err instanceof Error ? err.message : String(err)),
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BundleIntegrityError('extracted-partition body is not a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj['_noydb_bundle_body'] !== 1) {
    throw new BundleIntegrityError(
      'extracted-partition body missing `_noydb_bundle_body: 1` discriminator',
    )
  }
  if (typeof obj['dump'] !== 'string') {
    throw new BundleIntegrityError('extracted-partition body must carry a string `dump` field')
  }
  const seal = obj['_transferSeal']
  if (typeof seal !== 'object' || seal === null) {
    throw new BundleIntegrityError('extracted-partition body missing `_transferSeal` blob')
  }
  const s = seal as Record<string, unknown>
  if (s['v'] !== 1 || s['alg'] !== 'aes-256-gcm-pre-shared'
      || typeof s['sealId'] !== 'string' || typeof s['payload'] !== 'string') {
    throw new BundleIntegrityError('extracted-partition `_transferSeal` blob is malformed')
  }
  return { dump: obj['dump'], seal: seal as TransferSealPayload }
}

/**
 * Coerce an unsealed perUser entry to `AutoCredential`. Older bundles
 * store bare strings; newer bundles store `{ kind, value }` objects.
 */
function coerceUnsealed(entry: AutoCredential | string): AutoCredential {
  if (typeof entry === 'string') return { kind: 'secret', value: entry }
  return entry
}

/**
 * Resolve the `_autoUnlock` blob into a typed per-user credential map.
 *
 * - For `kind: 'unsealed'`: pass through, coercing pre-0.2 bare strings
 *   to `{ kind: 'secret', value }`.
 * - For `kind: 'sealed'`: pick a `SealingKeyProvider` from
 *   `opts.sealingProviders` whose `.id` matches each entry's `pid`;
 *   unseal to `AutoCredential`. When no provider matches AND strict mode
 *   (default), throw `BundleSealMismatchError`. With
 *   `attemptUnsealAcrossProviders: true`, try each provider whose
 *   `alg` matches the envelope.
 *   Exception: if an unmatched entry carries a `hint` field (recipient-target
 *   entries), it passes through as `{ kind, value: base64sealed }` rather than
 *   throwing — multi-recipient bundles have N-1 unmatched entries from each
 *   recipient's perspective, and the consumer is expected to ignore entries
 *   not addressed to them.
 * - When `sealingProviders` is unset entirely on a `'sealed'` bundle,
 *   pass through the SEALED entries as `{ kind, value: base64sealed }` —
 *   the caller can inspect or unseal elsewhere.
 *
 * Pre-0.2 sealed entries missing `kind` default to `'secret'`.
 */
async function resolveAutoUnlock(
  blob: AutoUnlockBody['_autoUnlock'],
  opts: ReadNoydbBundleOptions,
): Promise<{ kind: 'unsealed' | 'sealed'; perUser: Record<string, AutoCredential> }> {
  if (blob.kind === 'unsealed') {
    const resolved: Record<string, AutoCredential> = {}
    for (const [userId, entry] of Object.entries(blob.perUser)) {
      resolved[userId] = coerceUnsealed(entry)
    }
    return { kind: 'unsealed', perUser: resolved }
  }
  // Sealed path.
  if (opts.sealingProviders === undefined || opts.sealingProviders.length === 0) {
    // Inspection mode — pass the sealed payload through as a typed
    // credential whose `value` is the opaque base64 sealed bytes.
    // The caller is signalled by `kind: 'sealed'` on the outer result.
    const passthrough: Record<string, AutoCredential> = {}
    for (const [userId, entry] of Object.entries(blob.perUser)) {
      passthrough[userId] = { kind: entry.kind ?? 'secret', value: entry.sealed }
    }
    return { kind: 'sealed', perUser: passthrough }
  }
  const providersByPid = new Map<string, SealingKeyProvider>()
  for (const p of opts.sealingProviders) providersByPid.set(p.id, p)

  const decoder = new TextDecoder()
  const unsealedMap: Record<string, AutoCredential> = {}

  for (const [userId, entry] of Object.entries(blob.perUser)) {
    const credKind: AutoCredentialKind = entry.kind ?? 'secret'
    const provider = providersByPid.get(entry.pid)
    if (provider === undefined) {
      if (opts.attemptUnsealAcrossProviders === true) {
        // Try each provider; first that succeeds wins.
        let opened: string | null = null
        for (const candidate of opts.sealingProviders) {
          try {
            const plaintextBytes = await candidate.unseal(base64ToBytes(entry.sealed))
            opened = decoder.decode(plaintextBytes)
            break
          } catch {
            // try next
          }
        }
        if (opened === null) {
          if (entry.hint !== undefined) {
            // Recipient-target entry not addressed to any held key — pass through sealed.
            // Other recipients' entries in a multi-recipient bundle are opaque to us.
            unsealedMap[userId] = { kind: credKind, value: entry.sealed }
            continue
          }
          throw new BundleSealMismatchError(userId, entry.pid)
        }
        unsealedMap[userId] = { kind: credKind, value: opened }
        continue
      }
      if (entry.hint !== undefined) {
        // Recipient-target entry not addressed to any held key — pass through sealed.
        // Multi-recipient bundles deliberately seal each user's entry under their own
        // public key; a reader holding only alice's key will not match bob's pid.
        unsealedMap[userId] = { kind: credKind, value: entry.sealed }
        continue
      }
      throw new BundleSealMismatchError(userId, entry.pid)
    }
    const plaintextBytes = await provider.unseal(base64ToBytes(entry.sealed))
    unsealedMap[userId] = { kind: credKind, value: decoder.decode(plaintextBytes) }
  }
  return { kind: 'sealed', perUser: unsealedMap }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Detect whether the runtime's `CompressionStream` supports brotli.
 *
 * Brotli requires Node 22+ / Chrome 124+ / Firefox 122+. The
 * detection runs the `CompressionStream` constructor in a
 * try/catch — unsupported formats throw `TypeError` synchronously,
 * making this a safe one-shot check that we cache for the
 * lifetime of the process.
 */
let cachedBrotliSupport: boolean | null = null
function supportsBrotliCompression(): boolean {
  if (cachedBrotliSupport !== null) return cachedBrotliSupport
  try {
    new CompressionStream('br' as CompressionFormat)
    cachedBrotliSupport = true
  } catch {
    cachedBrotliSupport = false
  }
  return cachedBrotliSupport
}

/** Test-only: reset the brotli detection cache between tests. */
export function resetBrotliSupportCache(): void {
  cachedBrotliSupport = null
}

/**
 * Pick the compression algorithm and the corresponding format byte
 * from a user option. Throws if the user explicitly requests brotli
 * on a runtime that doesn't support it — a silent fallback would
 * make the produced bundle smaller-than-expected and confuse
 * size-bound tests.
 */
function selectCompression(option: WritePodOptions['compression']): {
  format: CompressionAlgo
  streamFormat: CompressionFormat | null
} {
  const choice = option ?? 'auto'
  if (choice === 'none') return { format: COMPRESSION_NONE, streamFormat: null }
  if (choice === 'gzip') return { format: COMPRESSION_GZIP, streamFormat: 'gzip' }
  if (choice === 'brotli') {
    if (!supportsBrotliCompression()) {
      throw new Error(
        `writePod({ compression: 'brotli' }) is not supported on this ` +
          `runtime. Brotli requires Node 22+, Chrome 124+, or Firefox 122+. ` +
          `Use { compression: 'auto' } to fall back to gzip silently, or ` +
          `{ compression: 'gzip' } to be explicit.`,
      )
    }
    return { format: COMPRESSION_BROTLI, streamFormat: 'br' as CompressionFormat }
  }
  // 'auto' — prefer brotli, fall back to gzip
  if (supportsBrotliCompression()) {
    return { format: COMPRESSION_BROTLI, streamFormat: 'br' as CompressionFormat }
  }
  return { format: COMPRESSION_GZIP, streamFormat: 'gzip' }
}

/**
 * Pump a Uint8Array through a CompressionStream / DecompressionStream
 * and collect the output. Both APIs are universally available in
 * Node 18+ and modern browsers; the only variance is which
 * formats they support, handled by `selectCompression` above.
 *
 * Implementation: build a single-chunk ReadableStream from the
 * input, pipe through the transform, then drain the resulting
 * ReadableStream into a single concatenated Uint8Array. This is
 * O(N) memory in the input + output sizes, which is fine for the
 * dump-sized payloads (typically <50MB) targets.
 */
async function pumpThroughStream(
  input: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const readable = new Blob([input as BlobPart]).stream().pipeThrough(stream)
  const reader = readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value as Uint8Array)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * SHA-256 hex digest of `bytes`. Used for the bundle integrity
 * hash carried in the header. Web Crypto API only — no Node
 * crypto module, no third-party hash library.
 *
 * The output format is lowercase hex (64 chars for SHA-256). The
 * format validator pins this — uppercase or mixed-case digests
 * are rejected, so the writer and reader agree on canonicalization.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed Uint8Array. The
  // underlying buffer of `bytes` may be SharedArrayBuffer (e.g.
  // from a worker), which `subtle.digest` rejects via TypeScript's
  // BufferSource type. Allocating a fresh ArrayBuffer-backed view
  // sidesteps the type narrowing and is portable across all
  // runtimes — the copy cost is O(N) but bundle bodies are
  // typically <50MB, well below the threshold where the copy
  // matters.
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return sha256HexBytes(copy)
}

/**
 * Concatenate any number of Uint8Arrays into a single new buffer.
 * Used to assemble the final bundle from its prefix + header +
 * body parts.
 */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * Replace the bundle's keyrings with freshly built recipient slots,
 * one per supplied recipient. No-op when neither `exportSecret`
 * nor `recipients` is set — the source keyring is inherited as-is.
 *
 * The single-secret shorthand creates a one-recipient list whose
 * id, role, and permissions inherit from the source vault — useful
 * for "back up to a different secret" without changing role
 * semantics. The multi-recipient form wraps each slot independently
 * with its declared role + permissions.
 *
 * @internal
 */
async function applyRecipientRewrap(
  vault: Vault,
  dumpJson: string,
  opts: WritePodOptions,
): Promise<string> {
  if (opts.exportSecret === undefined && opts.recipients === undefined) {
    return dumpJson
  }

  const recipients: readonly BundleRecipient[] =
    opts.recipients ?? [
      {
        id: vault.userId,
        secret: opts.exportSecret as string,
        role: vault.role,
      },
    ]

  const recipientKeyrings = await vault.buildBundleRecipientKeyrings(recipients)

  const backup = JSON.parse(dumpJson) as { keyrings: unknown; [k: string]: unknown }
  backup.keyrings = recipientKeyrings
  return JSON.stringify(backup)
}

/**
 * Apply opt-in slice filters to a vault dump JSON string. Filters that
 * narrow the bundle without crossing the encryption boundary — both
 * operate on metadata (collection name, envelope `_ts`) and never need
 * to decrypt records. When neither filter is set, the dump is returned
 * unchanged so the no-arg path stays a pure passthrough.
 *
 * Internal-collection filtering: when a `collections` allowlist is
 * provided, the bundle still carries `_internal` (ledger entries) and
 * the keyrings — they're necessary for the receiver to verify and
 * unlock the bundle. The allowlist applies to the user-collection
 * map only.
 *
 * @internal
 */
function applySliceFilters(
  dumpJson: string,
  opts: WritePodOptions,
): string {
  const collectionsFilter = opts.collections
    ? new Set(opts.collections)
    : null
  const sinceMs =
    opts.since !== undefined ? new Date(opts.since).getTime() : null
  if (collectionsFilter === null && sinceMs === null) return dumpJson

  // Parse, prune, re-serialize. The dump shape is stable
  // (VaultBackup) so this is a one-off allocation; for vaults beyond
  // the documented 1K–50K target a streaming variant would be a
  // follow-up, but the simple parse path keeps the slice path
  // type-safe and trivially auditable.
  const backup = JSON.parse(dumpJson) as {
    collections?: Record<string, Record<string, { _ts?: string }>>
    [k: string]: unknown
  }

  if (backup.collections && typeof backup.collections === 'object') {
    const next: Record<string, Record<string, unknown>> = {}
    for (const [name, records] of Object.entries(backup.collections)) {
      if (collectionsFilter && !collectionsFilter.has(name)) continue
      if (sinceMs === null) {
        next[name] = records
        continue
      }
      const kept: Record<string, unknown> = {}
      for (const [id, env] of Object.entries(records)) {
        const envTs = env._ts ? new Date(env._ts).getTime() : NaN
        if (Number.isFinite(envTs) && envTs >= sinceMs) {
          kept[id] = env
        }
      }
      next[name] = kept
    }
    backup.collections = next as typeof backup.collections
  }

  return JSON.stringify(backup)
}

/**
 * Unconditionally drop satellite-collection records whose base row is dead
 * (absent or tombstoned — existence.ts rule 1) from a vault dump. Unlike
 * `applySliceFilters` / `applyPlaintextFilters`, this isn't opt-in: a
 * satellite envelope that outlived its base is dead ciphertext (plus its
 * wrapped keys) that should never leave the vault in a `.noydb` backup
 * (#591 Task 10 — closes the last enumerated existence-authority surface).
 *
 * Pairing info comes from the persisted `_schemas/<name>` marker rather
 * than the in-memory `SatelliteRegistry` — that registry is private to
 * `Vault` and the bundle-export path only has `Vault._introspectState()`
 * (adapter + vault name + per-collection DEK accessor), so it reads the
 * marker instead of widening the kernel's surface. See
 * `with-shape/satellites/dead-filter.ts`.
 *
 * No-ops (returns `dumpJson` unchanged) when the vault has no detectable
 * satellite collections at all, so vaults that never use satellites pay
 * no extra parse/reserialize cost. Also no-ops when `vault` doesn't
 * implement `_introspectState()` at all — some call sites pass a minimal
 * duck-typed vault-like object for unit tests (e.g.
 * `snapshots.test.ts`'s `makeMockVault`, which implements only
 * `getBundleHandle`/`dump`/`load`/`getCover`); a real `Vault`
 * always implements it.
 *
 * @internal
 */
async function applySatelliteLivenessFilter(
  vault: Vault,
  dumpJson: string,
): Promise<string> {
  const backup = JSON.parse(dumpJson) as {
    collections?: Record<string, Record<string, unknown>>
    [k: string]: unknown
  }
  if (!backup.collections || typeof backup.collections !== 'object') return dumpJson
  if (typeof vault._introspectState !== 'function') return dumpJson

  const { adapter, name, getDEK } = vault._introspectState()
  const { liveBaseIdSetsForBundle } = await import('../with-shape/satellites/dead-filter.js')
  const satLive = await liveBaseIdSetsForBundle(adapter, name, Object.keys(backup.collections), getDEK)
  if (satLive.size === 0) return dumpJson

  const next: Record<string, Record<string, unknown>> = {}
  for (const [collName, records] of Object.entries(backup.collections)) {
    const live = satLive.get(collName)
    if (!live) { next[collName] = records; continue }
    const kept: Record<string, unknown> = {}
    for (const [id, env] of Object.entries(records)) {
      if (live.has(id)) kept[id] = env
    }
    next[collName] = kept
  }
  backup.collections = next
  return JSON.stringify(backup)
}

/**
 * Apply opt-in plaintext-tier filters
 * to a vault dump. Operates BEFORE `applySliceFilters` so the metadata
 * pass sees the trimmed record set.
 *
 * The filter never re-encrypts: surviving records carry their original
 * envelope unchanged. Failing records are dropped from the
 * `collections` map. Internal collections (ledger, deltas) and the
 * keyrings map are untouched.
 *
 * @internal
 */
async function applyPlaintextFilters(
  vault: Vault,
  dumpJson: string,
  opts: WritePodOptions,
): Promise<string> {
  if (opts.where === undefined && opts.tierAtMost === undefined) {
    return dumpJson
  }

  type Env = { _ts?: string; _tier?: number; _iv: string; _data: string }
  const backup = JSON.parse(dumpJson) as {
    collections?: Record<string, Record<string, Env>>
    [k: string]: unknown
  }
  if (!backup.collections || typeof backup.collections !== 'object') {
    return dumpJson
  }

  const tierCeiling = opts.tierAtMost
  const where = opts.where

  const next: Record<string, Record<string, Env>> = {}
  for (const [collName, records] of Object.entries(backup.collections)) {
    const kept: Record<string, Env> = {}
    for (const [id, env] of Object.entries(records)) {
      // Tier ceiling — runs FIRST so we don't waste a decrypt on
      // records about to be dropped anyway. Envelope tier defaults to
      // 0 when absent (matches Vault's tier-0 conventions).
      if (tierCeiling !== undefined) {
        const tier = env._tier ?? 0
        if (tier > tierCeiling) continue
      }
      // Plaintext predicate — decrypt, run, keep on truthy. Errors
      // from inside the predicate propagate (callers want to see why
      // their filter blew up rather than getting a silent passthrough).
      if (where !== undefined) {
        const record = await vault._decryptEnvelopeForBundleFilter(
          env as never,
          collName,
        )
        const ok = await where(record, { collection: collName, id })
        if (!ok) continue
      }
      kept[id] = env
    }
    next[collName] = kept
  }
  backup.collections = next
  return JSON.stringify(backup)
}

/**
 * Write a `.noydb` bundle for the given vault.
 *
 * Pipeline:
 *   1. Resolve or create the compartment's stable bundle handle
 *      via `vault.getBundleHandle()` — same handle on
 *      every export from the same vault instance, so cloud
 *      adapters can use it as a primary key.
 *   2. `vault.dump()` → JSON string with encrypted records
 *      inside.
 *   3. UTF-8 encode the dump string.
 *   4. Compress (brotli if available, gzip fallback by default).
 *   5. Compute SHA-256 of the compressed body for integrity.
 *   6. Build the minimum-disclosure header from format version,
 *      handle, body length, body sha.
 *   7. Serialize: magic (4) + flags (1) + algo (1) + headerLen (4)
 *      + header JSON (N) + compressed body (M).
 *
 * The output is a single `Uint8Array`. Consumers writing to disk
 * pass it to `fs.writeFile`; consumers uploading to cloud storage
 * pass it as the request body. The `@noy-db/file` adapter wraps
 * this with a `saveBundle(path, vault)` helper.
 */
/**
 * Assemble the final `.noydb` container bytes from a body JSON string +
 * header extras. Shared by `writePod` and `extractPartition`
 * so both producers go through one compress/hash/prefix path.
 *
 * @internal
 */
export async function assembleBundleContainer(opts: {
  handle: string
  bodyJsonStr: string
  compression: WritePodOptions['compression']
  /** Header fields beyond the always-present four. */
  headerExtras?: Partial<Pick<NoydbPodHeader,
    | 'publicEnvelope' | 'autoUnlock' | 'bundleKind' | 'transferSeal'
    | 'engineRange' | 'unlockMethods' | 'hasApp' | 'species' | 'pointerMode' | 'redirect'
  >>
  /**
   * When present, the assembled header is signed (#943): the header is
   * bumped to `formatVersion: 2` and carries the sig/keyId/sigAlg tuple.
   * Absent → an unsigned `formatVersion: 1` header (partitions, and pods
   * from vaults without a signer, stay unsigned).
   */
  signer?: DocSigner
}): Promise<Uint8Array> {
  const dumpBytes = new TextEncoder().encode(opts.bodyJsonStr)
  const { format, streamFormat } = selectCompression(opts.compression)
  const body = streamFormat === null
    ? dumpBytes
    : await pumpThroughStream(dumpBytes, new CompressionStream(streamFormat))
  const bodySha256 = await sha256Hex(body)

  const header: NoydbPodHeader = {
    formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
    handle: opts.handle,
    bodyBytes: body.length,
    bodySha256,
    ...(opts.headerExtras?.publicEnvelope !== undefined ? { publicEnvelope: opts.headerExtras.publicEnvelope } : {}),
    ...(opts.headerExtras?.autoUnlock !== undefined ? { autoUnlock: opts.headerExtras.autoUnlock } : {}),
    ...(opts.headerExtras?.bundleKind !== undefined ? { bundleKind: opts.headerExtras.bundleKind } : {}),
    ...(opts.headerExtras?.transferSeal !== undefined ? { transferSeal: opts.headerExtras.transferSeal } : {}),
    ...(opts.headerExtras?.engineRange !== undefined ? { engineRange: opts.headerExtras.engineRange } : {}),
    ...(opts.headerExtras?.unlockMethods !== undefined ? { unlockMethods: opts.headerExtras.unlockMethods } : {}),
    ...(opts.headerExtras?.hasApp !== undefined ? { hasApp: opts.headerExtras.hasApp } : {}),
    ...(opts.headerExtras?.species !== undefined ? { species: opts.headerExtras.species } : {}),
    ...(opts.headerExtras?.pointerMode !== undefined ? { pointerMode: opts.headerExtras.pointerMode } : {}),
    ...(opts.headerExtras?.redirect !== undefined ? { redirect: opts.headerExtras.redirect } : {}),
  }
  // Header signing (#943): sign the header object as it will stand at
  // formatVersion 2 WITH keyId + sigAlg but WITHOUT `sig`, then attach the
  // resulting 3-tuple + bump the version. `signRecord`/`canonicalJson`
  // throw on any `undefined`, so the signed payload is built with only the
  // fields actually present (spread of the header carries no undefined
  // keys). Only produce formatVersion 2 WHEN signing — an unsigned pod
  // stays formatVersion 1 with no sig fields.
  const signed: NoydbPodHeader = opts.signer === undefined
    ? header
    : await (async (s: DocSigner): Promise<NoydbPodHeader> => {
        const toSign = { ...header, formatVersion: NOYDB_BUNDLE_FORMAT_VERSION_SIGNED, keyId: s.keyId, sigAlg: 'ed25519' as const }
        const sig = await signRecord(s.privateKeyPkcs8B64, toSign)
        return { ...toSign, sig }
      })(opts.signer)
  const headerBytes = encodeBundleHeader(signed)

  const prefix = new Uint8Array(NOYDB_BUNDLE_PREFIX_BYTES)
  prefix.set(NOYDB_BUNDLE_MAGIC, 0)
  prefix[4] = (streamFormat === null ? 0 : FLAG_COMPRESSED) | FLAG_HAS_INTEGRITY_HASH
  prefix[5] = format
  writeUint32BE(prefix, 6, headerBytes.length)

  return concatBytes([prefix, headerBytes, body])
}

export async function writePod(
  vault: Vault,
  opts: WritePodOptions = {},
): Promise<Uint8Array> {
  if (opts.exportSecret !== undefined && opts.recipients !== undefined) {
    throw new Error(
      'writePod: pass either exportSecret or recipients, not both',
    )
  }

  // Auto-unlock: normalize once, validate + build from the
  // same NormalizedAutoUnlock object so there's no double-normalize call.
  const normalizedAutoUnlock = normalizeAutoUnlock(opts)
  const autoUnlockMode = validateAutoUnlockOptions(opts, normalizedAutoUnlock)

  const handle = await vault.getBundleHandle()
  const dumpJson = await vault.dump()

  // Satellite existence-authority filter (#591 Task 10) — unconditional,
  // runs before every other filter so dead-ciphertext satellite records
  // never reach recipient rewrap or the opt-in filters below.
  const satelliteFiltered = await applySatelliteLivenessFilter(vault, dumpJson)

  // Re-keying: when caller supplied recipients (or the single-recipient
  // shorthand), substitute the bundle's `keyrings` map with freshly
  // built recipient slots before slice filters run.
  const rekeyed = await applyRecipientRewrap(vault, satelliteFiltered, opts)
  // Plaintext-tier filters run BEFORE
  // the metadata-only slice — that way the metadata pass sees the
  // already-trimmed record set and the two filter chains compose
  // cleanly.
  const plainFiltered = await applyPlaintextFilters(vault, rekeyed, opts)
  const filtered = applySliceFilters(plainFiltered, opts)

  // If no auto-unlock requested, body remains the raw dump JSON.
  // Otherwise build the wrapped body containing the
  // dump + `_autoUnlock` blob and serialize.
  const bodyJsonStr = normalizedAutoUnlock === null
    ? filtered
    : JSON.stringify(await buildAutoUnlockWrapper(filtered, normalizedAutoUnlock))
  // Snapshot the source vault's cover into the header when one is
  // persisted. `Vault.getCover` tolerates a missing document and
  // returns undefined, which we propagate as "no cover in the
  // header." Vaults without a `_meta/public-envelope` document
  // (the frozen wire name) produce minimum-disclosure headers
  // exactly like before, preserving back-compat.
  const cover = await vault.getCover()

  // Resolve the header signer (#943): explicit `false` disables signing;
  // an explicit DocSigner is used verbatim (no vault touch); otherwise fall
  // back to the vault's persisted signer, which is `null` (unsigned) when
  // none was ever minted — export never mints one.
  const signer = opts.sign === false
    ? undefined
    : opts.sign !== undefined
      ? opts.sign
      : (await vault._loadPodSigner()) ?? undefined

  return assembleBundleContainer({
    handle,
    bodyJsonStr,
    compression: opts.compression,
    headerExtras: {
      // `publicEnvelope` is the frozen wire key for the cover (#799).
      ...(cover !== undefined ? { publicEnvelope: cover } : {}),
      ...(autoUnlockMode !== null ? { autoUnlock: autoUnlockMode } : {}),
      // Header L2 fields (#942) — passed through verbatim from opts.
      ...(opts.engineRange !== undefined ? { engineRange: opts.engineRange } : {}),
      ...(opts.unlockMethods !== undefined ? { unlockMethods: opts.unlockMethods } : {}),
      ...(opts.hasApp !== undefined ? { hasApp: opts.hasApp } : {}),
      ...(opts.species !== undefined ? { species: opts.species } : {}),
      ...(opts.pointerMode !== undefined ? { pointerMode: opts.pointerMode } : {}),
      ...(opts.redirect !== undefined ? { redirect: opts.redirect } : {}),
    },
    ...(signer !== undefined ? { signer } : {}),
  })
}

/** @deprecated Use `writePod`. */
export const writeNoydbBundle = writePod

/**
 * Internal helper shared by both readers — parses just the prefix
 * + header region of a bundle without touching the body. Returns
 * the parsed header plus the offset where the body starts and the
 * compression algorithm needed to decompress it.
 *
 * Throws on any format violation: missing/invalid magic, truncated
 * prefix, header length larger than the file, or unknown
 * compression algorithm.
 */
function parsePrefixAndHeader(bytes: Uint8Array): {
  header: NoydbPodHeader
  bodyOffset: number
  algo: CompressionAlgo
  flags: number
} {
  if (!hasNoydbBundleMagic(bytes)) {
    throw new Error(
      `Not a .noydb bundle: missing 'NDB1' magic prefix. The first 4 bytes ` +
        `are ${[...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}.`,
    )
  }
  if (bytes.length < NOYDB_BUNDLE_PREFIX_BYTES) {
    throw new Error(
      `Truncated .noydb bundle: file is only ${bytes.length} bytes, ` +
        `which is less than the ${NOYDB_BUNDLE_PREFIX_BYTES}-byte fixed prefix.`,
    )
  }
  const flags = bytes[4]!
  const algo = bytes[5]!
  if (algo !== COMPRESSION_NONE && algo !== COMPRESSION_GZIP && algo !== COMPRESSION_BROTLI) {
    throw new Error(
      `.noydb bundle declares unknown compression algorithm ${algo}. ` +
        `Known values: 0 (none), 1 (gzip), 2 (brotli).`,
    )
  }
  const headerLength = readUint32BE(bytes, 6)
  const bodyOffset = NOYDB_BUNDLE_PREFIX_BYTES + headerLength
  if (bodyOffset > bytes.length) {
    throw new Error(
      `Truncated .noydb bundle: declared header length ${headerLength} ` +
        `would extend past end of file (${bytes.length} bytes).`,
    )
  }
  const headerBytes = bytes.slice(NOYDB_BUNDLE_PREFIX_BYTES, bodyOffset)
  const header = decodeBundleHeader(headerBytes)
  return { header, bodyOffset, algo: algo as CompressionAlgo, flags }
}

/**
 * Read just the bundle header — no body decompression, no
 * integrity verification. Intended for cloud-listing UIs that want
 * to show the handle and size before downloading the full body.
 *
 * Returns the same `NoydbPodHeader` shape as the writer, with
 * minimum-disclosure validation already applied.
 *
 * **Cost** — O(prefix + header bytes). The header is normally well
 * under 1 KB, but may grow to roughly 256 KB when a `publicEnvelope`
 * with an inline icon is present. Cloud-listing UIs that previously
 * assumed sub-KB header reads should account for this when sizing
 * range requests against bundles that may carry icons.
 */
export function readPodHeader(bytes: Uint8Array): NoydbPodHeader {
  return parsePrefixAndHeader(bytes).header
}

/** @deprecated Use `readPodHeader`. */
export const readNoydbBundleHeader = readPodHeader

/**
 * Outcome of {@link verifyPodHeader}.
 *
 *   - `verified`  — the header carried a sig-tuple, its `keyId` is in
 *     `trustedKeys`, and the signature checks out over the canonical
 *     header bytes.
 *   - `unsigned`  — the header carried no signature (a legacy v1 pod, or a
 *     v2 pod written with `{ sign: false }`). Not an error; just unauthenticated.
 *   - `untrusted` — the header is signed but its `keyId` is not one the
 *     caller trusts. The signature was NOT checked.
 *   - `tampered`  — the header is signed by a trusted key but the signature
 *     does not verify: the signed bytes were altered, or the mapped public
 *     key is not the one that actually signed.
 */
export interface PodVerifyResult {
  readonly status: 'verified' | 'unsigned' | 'untrusted' | 'tampered'
  /** The header's `keyId`, present whenever the header carried a sig-tuple. */
  readonly keyId?: string
}

/**
 * Authenticate a pod header (#943) — a pure, dependency-free, WebCrypto-only
 * verifier. Given only the raw pod bytes and a `trustedKeys` map
 * (`keyId → publicKeyB64` the caller already trusts), it reports whether the
 * header was signed by a trusted document signer.
 *
 * Pairs with the signing half in `assembleBundleContainer`/`writePod`: the
 * signed payload is the final wire header with `sig` removed, so verification
 * reconstructs it by stripping EXACTLY the `sig` field — `keyId`, `sigAlg`,
 * and every other header field stay in the verified payload.
 *
 * No store, enclave, or vault dependency — reachable from a static page with
 * only the pod bytes, the trusted-key map, and `globalThis.crypto`.
 *
 * SECURITY — authenticity is not integrity. A `verified` result proves the
 * header (which includes the *claimed* `bodySha256`) is signed by a trusted
 * key; it does NOT prove the body matches that hash. To trust the pod's
 * BODY you MUST also confirm the body hashes to `header.bodySha256` — call
 * `readPod`, which throws `BundleIntegrityError` on mismatch. A `verified`
 * header paired with a swapped body is caught only by that integrity check.
 * This function stays body-free by design so a static page can authenticate a
 * header without decompressing the body; composing the two checks is the
 * caller's responsibility. See `docs/subsystems/pod-signature.md`.
 */
export async function verifyPodHeader(
  bytes: Uint8Array,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<PodVerifyResult> {
  const { header } = parsePrefixAndHeader(bytes)

  // No signature tuple → unsigned, regardless of formatVersion. The format
  // layer guarantees sig/keyId/sigAlg are all-or-nothing, so any one being
  // absent means the header is unsigned.
  if (header.sig === undefined || header.keyId === undefined || header.sigAlg === undefined) {
    return { status: 'unsigned' }
  }

  const publicKeyB64 = trustedKeys[header.keyId]
  if (publicKeyB64 === undefined) {
    return { status: 'untrusted', keyId: header.keyId }
  }

  // Reconstruct the signed payload: the FINAL wire header minus EXACTLY `sig`.
  const payload: Record<string, unknown> = { ...header }
  delete payload['sig']

  const ok = await verifyRecord(publicKeyB64, header.sig, payload)
  return { status: ok ? 'verified' : 'tampered', keyId: header.keyId }
}

/**
 * Read just the bundle's cover (`https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md`)
 * — without verifying the body or even parsing the dump JSON. Pass
 * the raw bundle bytes; receive the owner-curated metadata or
 * `undefined` if the bundle was written without one.
 *
 * Locale-resolves any `name` / `description` map fields when `locale`
 * is supplied. Omitting `locale` returns the raw cover.
 *
 * Same security caveat as the on-vault read path — the cover is an
 * **untrusted hint** in v1; the encrypted body remains
 * the source of truth for vault contents.
 */
export function readPodCover(
  bytes: Uint8Array,
  opts: { readonly locale?: string } = {},
): Cover | undefined {
  const header = parsePrefixAndHeader(bytes).header
  const env = header.publicEnvelope
  if (!env) return undefined
  if (opts.locale === undefined) return env
  return {
    ...env,
    ...(env.name !== undefined ? { name: pickLocale(env.name, opts.locale, env.defaultLocale) } : {}),
    ...(env.description !== undefined ? { description: pickLocale(env.description, opts.locale, env.defaultLocale) } : {}),
  }
}

/**
 * Read just the bundle's Redirect record (#944) — without verifying the
 * body or even parsing the dump JSON. Pass the raw bundle bytes; receive
 * the header's `redirect` field or `undefined` if the bundle was written
 * without one.
 *
 * The record is returned UNVERIFIED: `validateBundleHeader` only checks
 * its shape at parse time (a parser has no `trustedKeys`). Callers that
 * intend to follow the redirect MUST separately call `verifyRedirect`
 * (`redirect.js`) before trusting `target`.
 */
export function readPodRedirect(bytes: Uint8Array): Redirect | undefined {
  return parsePrefixAndHeader(bytes).header.redirect
}

/**
 * Read a full `.noydb` bundle: validate magic + header, verify
 * integrity hash over the body bytes, decompress, and return the
 * original `vault.dump()` JSON string ready to pass to
 * `vault.load()`.
 *
 * Throws `BundleIntegrityError` if the body's actual SHA-256 does
 * not match the value declared in the header. Distinct from a
 * format error so consumers can pattern-match in catch blocks
 * (corrupted-in-transit vs malformed-by-producer).
 *
 * Note: this function does NOT take a secret. The dump JSON
 * inside the body still contains encrypted records — restoring
 * the vault requires `vault.load(dumpJson, secret)`
 * after this call. Splitting the layers keeps the bundle module
 * free of crypto concerns and lets the same code feed format
 * inspectors that never decrypt anything.
 */
export async function readPod(
  bytes: Uint8Array,
  opts: ReadNoydbBundleOptions = {},
): Promise<NoydbBundleReadResult> {
  const { header, bodyOffset, algo } = parsePrefixAndHeader(bytes)
  const body = bytes.slice(bodyOffset)

  // Length check before hash check — a length mismatch is the
  // cheapest tamper signal and produces a more actionable error.
  if (body.length !== header.bodyBytes) {
    throw new BundleIntegrityError(
      `body length ${body.length} does not match header.bodyBytes ` +
        `${header.bodyBytes}. The bundle was truncated or padded ` +
        `between write and read.`,
    )
  }

  const actualSha = await sha256Hex(body)
  if (actualSha !== header.bodySha256) {
    throw new BundleIntegrityError(
      `body sha256 ${actualSha} does not match header.bodySha256 ` +
        `${header.bodySha256}. The bundle bytes were modified between ` +
        `write and read — refuse to decompress.`,
    )
  }

  let dumpBytes: Uint8Array
  if (algo === COMPRESSION_NONE) {
    dumpBytes = body
  } else {
    const streamFormat: CompressionFormat =
      algo === COMPRESSION_BROTLI ? ('br' as CompressionFormat) : 'gzip'
    try {
      dumpBytes = await pumpThroughStream(body, new DecompressionStream(streamFormat))
    } catch (err) {
      throw new BundleIntegrityError(
        `decompression failed: ${(err as Error).message}. The bundle ` +
          `passed the integrity hash but the body is not valid ` +
          `${streamFormat} data — likely a producer bug.`,
      )
    }
  }

  const bodyString = new TextDecoder('utf-8', { fatal: true }).decode(dumpBytes)

  // When the header signals auto-unlock, the body is a
  // JSON wrapper carrying the dump string + the auto-unlock blob.
  // When absent, the body IS the raw dump JSON.
  if (header.autoUnlock === undefined) {
    return { header, dumpJson: bodyString }
  }
  const { dump, blob } = parseAutoUnlockBody(bodyString)
  const autoUnlock = await resolveAutoUnlock(blob, opts)
  return { header, dumpJson: dump, autoUnlock }
}

/** @deprecated Use `readPod`. */
export const readNoydbBundle = readPod
