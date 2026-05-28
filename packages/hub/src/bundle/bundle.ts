/**
 * `.noydb` container primitives — write, read, header-only read.
 *
 *. Wraps a `vault.dump()` JSON string in the
 * binary container described in `format.ts`.
 *
 * **Three primitives:**
 *
 *   - `writeNoydbBundle(vault, opts?)` — produces the
 *     full container bytes ready to write to disk or upload
 *   - `readNoydbBundleHeader(bytes)` — parses just the header
 *     without decompressing the body, fast file-type and
 *     metadata read for cloud listing UIs
 *   - `readNoydbBundle(bytes)` — full read: validates magic,
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
 * **Why split read/load?** `readNoydbBundle` returns the
 * *unwrapped JSON string*, not a Vault object. The caller
 * is responsible for piping that JSON into
 * `vault.load(json, passphrase)`. Splitting the layers
 * keeps the bundle module free of any crypto/passphrase
 * concerns — it's purely a format layer. The same `readNoydbBundle`
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
  NOYDB_BUNDLE_MAGIC,
  NOYDB_BUNDLE_PREFIX_BYTES,
  decodeBundleHeader,
  encodeBundleHeader,
  hasNoydbBundleMagic,
  readUint32BE,
  writeUint32BE,
  type CompressionAlgo,
  type NoydbBundleHeader,
} from './format.js'
import { BundleIntegrityError, BundleSealMismatchError, ValidationError } from '../errors.js'
import type { Vault } from '../vault.js'
import type { BundleRecipient } from '../team/keyring.js'
import { pickLocale } from '../meta/public-envelope/storage.js'
import type { PublicEnvelope } from '../meta/public-envelope/types.js'
import type { SealingKeyProvider, RecipientSealer, RecipientHint } from '../team/managed-passphrase.js'

// ─── #215 auto-credential types ───────────────────────────────────────────────

/**
 * The credential kinds that can be bundled for auto-unlock.
 * WebAuthn is intentionally excluded — it is hardware-bound and
 * cannot be embedded as a portable credential.
 */
export type AutoCredentialKind = 'passphrase' | 'password' | 'pin'

/**
 * A typed credential for auto-unlock. Carries the credential `kind`
 * alongside the plaintext `value`, so consumers can dispatch the
 * correct login/prefill path rather than treating all credentials
 * as passphrases.
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
 * Options accepted by `writeNoydbBundle`.
 *
 * - `compression: 'auto'` (default) — try brotli, fall back to gzip
 * - `compression: 'brotli'` — force brotli, throw if unsupported
 * - `compression: 'gzip'` — force gzip
 * - `compression: 'none'` — no compression (round-trip testing only)
 *
 * **Slice filtering** (added in ):
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
export interface WriteNoydbBundleOptions {
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
   * with this passphrase. The recipient inherits the source keyring's
   * userId, role, and permissions. Mutually exclusive with `recipients`.
   */
  readonly exportPassphrase?: string
  /**
   * Multi-recipient re-keying. Replaces the bundle's keyring
   * map with one slot per recipient, each sealed with its own
   * passphrase. DEKs are unwrapped from the source keyring once and
   * re-wrapped per recipient — record ciphertext is unchanged.
   *
   * Mutually exclusive with `exportPassphrase`. When neither is set,
   * the bundle inherits the source keyring as-is (today's behaviour,
   * suited to personal backup-and-restore).
   */
  readonly recipients?: readonly BundleRecipient[]
  /**
   * Auto-unlock — unsealed per-user credentials (#215).
   *
   * Generalises `autoPassphrases` to support any bundleable credential
   * kind (`passphrase` | `password` | `pin`).
   *
   * Public-by-design: anyone holding the bundle bytes can read these
   * plaintext credentials. Use for demo data, sample vaults,
   * prospect onboarding.
   *
   * The `policy: 'public-by-design'` discriminant is mandatory. A
   * bare `{ perUser }` without it is rejected at write time — the
   * safety net against a careless call against a production vault.
   *
   * Mutually exclusive with `sealedCredentials`, `autoPassphrases`,
   * and `sealedPassphrases`.
   */
  readonly autoCredentials?: {
    readonly policy: 'public-by-design'
    readonly perUser: Record<string, AutoCredential>
  }
  /**
   * Auto-unlock — per-user credentials sealed under a
   * {@link SealingKeyProvider} (#215).
   *
   * Generalises `sealedPassphrases` to support any bundleable
   * credential kind (`passphrase` | `password` | `pin`).
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
   * Mutually exclusive with `autoCredentials`, `autoPassphrases`,
   * and `sealedPassphrases`.
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
   * @deprecated Use `autoCredentials` instead (#215).
   *
   * Auto-unlock — unsealed per-user passphrases (#197 slice 1).
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
   * and `sealedPassphrases`.
   */
  readonly autoPassphrases?: {
    readonly policy: 'public-by-design'
    readonly perUser: Record<string, string>
  }
  /**
   * @deprecated Use `sealedCredentials` instead (#215).
   *
   * Auto-unlock — per-user passphrases sealed under a
   * {@link SealingKeyProvider} (#197 slice 1, self-target only).
   *
   * The hub seals each user's plaintext passphrase under `provider`
   * and embeds the resulting sealed envelopes in the bundle. The
   * recipient must hold a provider with a matching `pid` (i.e.,
   * `provider.id`) to auto-unseal on import.
   *
   * `mode: 'self-target'` is the only mode in slice 1 — sender and
   * recipient share the same provider identity (same iCloud Keychain
   * entry, same MDM-provisioned bundle id, same KMS account, etc.).
   * Recipient-target sealing via the `RecipientSealer` interface
   * (foundation §11.4) is deferred to a follow-up slice.
   *
   * Mutually exclusive with `autoCredentials`, `sealedCredentials`,
   * and `autoPassphrases`.
   */
  readonly sealedPassphrases?: {
    readonly mode: 'self-target'
    readonly provider: SealingKeyProvider
    readonly perUser: Record<string, string>
  }
}

/**
 * Result returned by `readNoydbBundle`. The caller is expected to
 * pass `dumpJson` into `vault.load(json, passphrase)` to
 * actually restore a vault. Splitting the layers keeps the
 * bundle module free of crypto concerns — see file-level docs.
 */
export interface NoydbBundleReadResult {
  readonly header: NoydbBundleHeader
  readonly dumpJson: string
  /**
   * Auto-unlock material (#197, widened in #215). Present only when
   * the header's `autoUnlock` flag is set AND the body's wrapped
   * structure survived parsing. Values are typed credentials — either
   * delivered plain (`kind: 'unsealed'`) or unsealed at read time
   * using one of the supplied `sealingProviders` (`kind: 'sealed'`).
   *
   * Consumers dispatch on `cred.kind` to choose the correct login /
   * prefill path. Pre-0.2 bundles (bare string entries) are coerced
   * to `{ kind: 'passphrase', value }` on read for back-compat.
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
 * `sealedCredentials` (or the deprecated `sealedPassphrases`).
 * Provider's sealed output is base64-encoded; the `pid` is the
 * dispatch key matched against recipient-supplied
 * `SealingKeyProvider.id`. The `kind` carries the plaintext-tier
 * metadata so the consumer can dispatch on credential type without
 * unsealing first.
 *
 * Back-compat: `kind` is absent in pre-0.2 bundles — readers must
 * default to `'passphrase'` when not present.
 */
interface SealedAutoUnlockEntry {
  readonly pid: string
  readonly sealed: string
  readonly alg: 'aes-256-gcm'
  readonly kind?: AutoCredentialKind
  readonly hint?: Record<string, unknown>
}

/**
 * Discriminated wrapper carried in the bundle body when the header's
 * `autoUnlock` flag is set. Without the flag, the body is the raw
 * `vault.dump()` JSON string (the pre-#197 shape).
 *
 * Back-compat: pre-0.2 bundles carry bare `string` values in the
 * unsealed `perUser` map. Readers must coerce those to
 * `{ kind: 'passphrase', value }`.
 */
interface AutoUnlockBody {
  readonly _noydb_bundle_body: 1
  readonly dump: string
  readonly _autoUnlock:
    | { readonly kind: 'unsealed'; readonly perUser: Record<string, AutoCredential | string> }
    | { readonly kind: 'sealed'; readonly perUser: Record<string, SealedAutoUnlockEntry> }
}

/**
 * Options accepted by {@link readNoydbBundle} for the #197
 * auto-unlock paths. Without these the reader behaves exactly as
 * pre-#197 (header parsed; body returned as `dumpJson`).
 */
export interface ReadNoydbBundleOptions {
  /**
   * Recipient-side sealing providers used to unseal entries from
   * `sealedPassphrases`. The reader picks the one whose `.id`
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

// ─── #197/#215 auto-unlock helpers ────────────────────────────────────────────

/**
 * Internal normalized form of the auto-unlock options, computed once
 * from the four public-facing fields (autoCredentials, sealedCredentials,
 * autoPassphrases, sealedPassphrases). Callers work against this shape
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
 * Coerce a `Record<string, string>` (legacy passphrase-only map) into
 * a `Record<string, AutoCredential>` by tagging each entry as
 * `kind: 'passphrase'`. Used by the normalizer to promote the deprecated
 * `autoPassphrases`/`sealedPassphrases` sugar.
 */
function toAutoCredentials(m: Record<string, string>): Record<string, AutoCredential> {
  return Object.fromEntries(
    Object.entries(m).map(([u, value]) => [u, { kind: 'passphrase' as const, value }]),
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
function normalizeAutoUnlock(opts: WriteNoydbBundleOptions): NormalizedAutoUnlock | null {
  const set = [
    opts.autoCredentials,
    opts.sealedCredentials,
    opts.autoPassphrases,
    opts.sealedPassphrases,
  ].filter(v => v !== undefined).length
  if (set === 0) return null
  if (set > 1) {
    throw new ValidationError(
      'writeNoydbBundle: only one of autoCredentials / sealedCredentials / '
      + 'autoPassphrases / sealedPassphrases may be set.',
    )
  }
  if (opts.autoCredentials !== undefined) {
    return { mode: 'unsealed', perUser: opts.autoCredentials.perUser }
  }
  if (opts.autoPassphrases !== undefined) {
    return { mode: 'unsealed', perUser: toAutoCredentials(opts.autoPassphrases.perUser) }
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
  // sealedPassphrases — only remaining option
  return {
    mode: 'sealed-self',
    provider: opts.sealedPassphrases!.provider,
    perUser: toAutoCredentials(opts.sealedPassphrases!.perUser),
  }
}

/**
 * Validate the auto-unlock options and return the resulting header
 * `autoUnlock` value (or null when no auto-unlock requested).
 *
 * Takes the pre-computed `NormalizedAutoUnlock` so the caller (i.e.
 * `writeNoydbBundle`) can pass the same object to `buildAutoUnlockWrapper`
 * without a second `normalizeAutoUnlock` call.
 *
 * Validation per spec (#197 + #215 §3):
 *   - (mutual exclusion already enforced by normalizeAutoUnlock)
 *   - unsealed path: `policy: 'public-by-design'` marker required
 *   - non-empty `perUser` maps
 *   - sealed path: provider present; runtime accepts `mode: 'self-target'` only in this slice (recipient-target rejected per §11.4 until the next commit lifts the guard)
 *   - every AutoCredential.kind ∈ {passphrase, password, pin}
 *     (WebAuthn is hardware-bound and cannot be bundled)
 *
 * Throws {@link ValidationError} on any violation.
 */
function validateAutoUnlockOptions(
  opts: WriteNoydbBundleOptions,
  normalized: NormalizedAutoUnlock | null,
): 'unsealed' | 'sealed' | null {
  if (normalized === null) return null

  const VALID_KINDS: ReadonlySet<string> = new Set(['passphrase', 'password', 'pin'])

  // Validate every credential kind before any further checks.
  for (const [userId, cred] of Object.entries(normalized.perUser)) {
    if (!VALID_KINDS.has(cred.kind)) {
      throw new ValidationError(
        `writeNoydbBundle: credential for user '${userId}' has unsupported kind '${cred.kind}'. `
        + 'auto-unlock supports passphrase/password/pin only; WebAuthn is hardware-bound '
        + 'and cannot be bundled.',
      )
    }
  }

  if (normalized.mode === 'unsealed') {
    // Read the policy marker from whichever active option carries it.
    const policy = opts.autoCredentials?.policy ?? opts.autoPassphrases?.policy
    if (policy !== 'public-by-design') {
      throw new ValidationError(
        'writeNoydbBundle: `autoCredentials` (or `autoPassphrases`) requires '
        + '`policy: "public-by-design"`. '
        + 'This is an explicit opt-in marker — bundling plaintext credentials is '
        + 'safe only when those credentials are intended to be public (demo data, '
        + 'sample vaults). For production credentials, use `sealedCredentials` instead.',
      )
    }
    const userCount = Object.keys(normalized.perUser).length
    if (userCount === 0) {
      throw new ValidationError(
        'writeNoydbBundle: `autoCredentials.perUser` (or `autoPassphrases.perUser`) '
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
        'writeNoydbBundle: `sealedCredentials.provider` for mode \'recipient-target\' must be a '
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
          `writeNoydbBundle: \`sealedCredentials.perUser['${userId}']\` missing required \`hint\` for mode 'recipient-target'.`,
        )
      }
      if (hint.v !== 1) {
        throw new ValidationError(
          `writeNoydbBundle: \`sealedCredentials.perUser['${userId}'].hint.v\` must be 1 (got ${hint.v}).`,
        )
      }
      if (hint.alg !== 'rsa-oaep-sha256') {
        throw new ValidationError(
          `writeNoydbBundle: \`sealedCredentials.perUser['${userId}'].hint.alg\` must be 'rsa-oaep-sha256' in slice 1 (got '${hint.alg}').`,
        )
      }
      if (hint.pid !== provider.id) {
        throw new ValidationError(
          `writeNoydbBundle: \`sealedCredentials.perUser['${userId}'].hint.pid\` ('${hint.pid}') does not match the provider id ('${provider.id}'). `
          + 'Sender cannot seal for a recipient whose hint points at a different provider.',
        )
      }
    }
    const userCount = Object.keys(normalized.perUser).length
    if (userCount === 0) {
      throw new ValidationError(
        'writeNoydbBundle: `sealedCredentials.perUser` must have at least one entry.',
      )
    }
    return 'sealed'
  }

  // mode === 'sealed-self'
  const selfTargetMode = opts.sealedCredentials?.mode ?? opts.sealedPassphrases?.mode
  if (selfTargetMode !== 'self-target') {
    throw new ValidationError(
      `writeNoydbBundle: \`sealedCredentials.mode\` (or \`sealedPassphrases.mode\`) must be `
      + `'self-target' or 'recipient-target' (got '${String(selfTargetMode)}').`,
    )
  }
  if (normalized.provider === undefined) {
    throw new ValidationError(
      'writeNoydbBundle: `sealedCredentials.provider` (or `sealedPassphrases.provider`) '
      + 'is required (a `SealingKeyProvider`).',
    )
  }
  const userCount = Object.keys(normalized.perUser).length
  if (userCount === 0) {
    throw new ValidationError(
      'writeNoydbBundle: `sealedCredentials.perUser` (or `sealedPassphrases.perUser`) '
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
  // Sealed path — seal each user's credential value under the provider.
  if (normalized.mode === 'sealed-recipient') {
    // Actual sealing logic is deferred to Task 5; validation already
    // rejects recipient-target at this stage so this branch is unreachable
    // in the current slice.
    throw new Error('unreachable — validator rejects recipient-target in this slice')
  }
  // normalized.mode === 'sealed-self'
  const provider = normalized.provider as SealingKeyProvider | undefined
  if (provider === undefined) {
    throw new Error('unreachable — validation should have caught this')
  }
  const sealedPerUser: Record<string, SealedAutoUnlockEntry> = {}
  const encoder = new TextEncoder()
  for (const [userId, cred] of Object.entries(normalized.perUser)) {
    const sealed = await provider.seal(encoder.encode(cred.value))
    sealedPerUser[userId] = {
      pid: provider.id,
      sealed: bytesToBase64(sealed),
      alg: 'aes-256-gcm',
      kind: cred.kind,
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
 * Transfer-seal payload (#206). The destination DEKs, exported to raw
 * bytes and AES-256-GCM-sealed *as a set* under the one-time transfer
 * key. `adoptPartition` (#207) unseals this; `createOwnerOnAdoptedPartition`
 * (#208) re-wraps the raw DEKs under the recipient's KEK.
 */
export interface TransferSealPayload {
  readonly v: 1
  readonly alg: 'aes-256-gcm-pre-shared'
  readonly sealId: string
  /** base64(AES-256-GCM(transferKey, JSON of { collection: base64(rawDEK) })) — iv ‖ ct ‖ tag. */
  readonly payload: string
}

/**
 * Body wrapper for an extracted, transfer-sealed partition (#203/#206).
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
 * Coerce an unsealed perUser entry to `AutoCredential`. Pre-0.2 bundles
 * store bare strings; 0.2+ bundles store `{ kind, value }` objects.
 */
function coerceUnsealed(entry: AutoCredential | string): AutoCredential {
  if (typeof entry === 'string') return { kind: 'passphrase', value: entry }
  return entry
}

/**
 * Resolve the `_autoUnlock` blob into a typed per-user credential map.
 *
 * - For `kind: 'unsealed'`: pass through, coercing pre-0.2 bare strings
 *   to `{ kind: 'passphrase', value }`.
 * - For `kind: 'sealed'`: pick a `SealingKeyProvider` from
 *   `opts.sealingProviders` whose `.id` matches each entry's `pid`;
 *   unseal to `AutoCredential`. When no provider matches AND strict mode
 *   (default), throw `BundleSealMismatchError`. With
 *   `attemptUnsealAcrossProviders: true`, try each provider whose
 *   `alg` matches the envelope.
 * - When `sealingProviders` is unset entirely on a `'sealed'` bundle,
 *   pass through the SEALED entries as `{ kind, value: base64sealed }` —
 *   the caller can inspect or unseal elsewhere.
 *
 * Pre-0.2 sealed entries missing `kind` default to `'passphrase'`.
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
      passthrough[userId] = { kind: entry.kind ?? 'passphrase', value: entry.sealed }
    }
    return { kind: 'sealed', perUser: passthrough }
  }
  const providersByPid = new Map<string, SealingKeyProvider>()
  for (const p of opts.sealingProviders) providersByPid.set(p.id, p)

  const decoder = new TextDecoder()
  const unsealedMap: Record<string, AutoCredential> = {}

  for (const [userId, entry] of Object.entries(blob.perUser)) {
    const credKind: AutoCredentialKind = entry.kind ?? 'passphrase'
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
          throw new BundleSealMismatchError(userId, entry.pid)
        }
        unsealedMap[userId] = { kind: credKind, value: opened }
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
function selectCompression(option: WriteNoydbBundleOptions['compression']): {
  format: CompressionAlgo
  streamFormat: CompressionFormat | null
} {
  const choice = option ?? 'auto'
  if (choice === 'none') return { format: COMPRESSION_NONE, streamFormat: null }
  if (choice === 'gzip') return { format: COMPRESSION_GZIP, streamFormat: 'gzip' }
  if (choice === 'brotli') {
    if (!supportsBrotliCompression()) {
      throw new Error(
        `writeNoydbBundle({ compression: 'brotli' }) is not supported on this ` +
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
  const digest = await crypto.subtle.digest('SHA-256', copy)
  const view = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, '0')
  }
  return hex
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
 * one per supplied recipient. No-op when neither `exportPassphrase`
 * nor `recipients` is set — the source keyring is inherited as-is.
 *
 * The single-passphrase shorthand creates a one-recipient list whose
 * id, role, and permissions inherit from the source vault — useful
 * for "back up to a different passphrase" without changing role
 * semantics. The multi-recipient form wraps each slot independently
 * with its declared role + permissions.
 *
 * @internal
 */
async function applyRecipientRewrap(
  vault: Vault,
  dumpJson: string,
  opts: WriteNoydbBundleOptions,
): Promise<string> {
  if (opts.exportPassphrase === undefined && opts.recipients === undefined) {
    return dumpJson
  }

  const recipients: readonly BundleRecipient[] =
    opts.recipients ?? [
      {
        id: vault.userId,
        passphrase: opts.exportPassphrase as string,
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
  opts: WriteNoydbBundleOptions,
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
  opts: WriteNoydbBundleOptions,
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
 * header extras. Shared by `writeNoydbBundle` and `extractPartition`
 * so both producers go through one compress/hash/prefix path.
 *
 * @internal
 */
export async function assembleBundleContainer(opts: {
  handle: string
  bodyJsonStr: string
  compression: WriteNoydbBundleOptions['compression']
  /** Header fields beyond the always-present four. */
  headerExtras?: Partial<Pick<NoydbBundleHeader, 'publicEnvelope' | 'autoUnlock' | 'bundleKind' | 'transferSeal'>>
}): Promise<Uint8Array> {
  const dumpBytes = new TextEncoder().encode(opts.bodyJsonStr)
  const { format, streamFormat } = selectCompression(opts.compression)
  const body = streamFormat === null
    ? dumpBytes
    : await pumpThroughStream(dumpBytes, new CompressionStream(streamFormat))
  const bodySha256 = await sha256Hex(body)

  const header: NoydbBundleHeader = {
    formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
    handle: opts.handle,
    bodyBytes: body.length,
    bodySha256,
    ...(opts.headerExtras?.publicEnvelope !== undefined ? { publicEnvelope: opts.headerExtras.publicEnvelope } : {}),
    ...(opts.headerExtras?.autoUnlock !== undefined ? { autoUnlock: opts.headerExtras.autoUnlock } : {}),
    ...(opts.headerExtras?.bundleKind !== undefined ? { bundleKind: opts.headerExtras.bundleKind } : {}),
    ...(opts.headerExtras?.transferSeal !== undefined ? { transferSeal: opts.headerExtras.transferSeal } : {}),
  }
  const headerBytes = encodeBundleHeader(header)

  const prefix = new Uint8Array(NOYDB_BUNDLE_PREFIX_BYTES)
  prefix.set(NOYDB_BUNDLE_MAGIC, 0)
  prefix[4] = (streamFormat === null ? 0 : FLAG_COMPRESSED) | FLAG_HAS_INTEGRITY_HASH
  prefix[5] = format
  writeUint32BE(prefix, 6, headerBytes.length)

  return concatBytes([prefix, headerBytes, body])
}

export async function writeNoydbBundle(
  vault: Vault,
  opts: WriteNoydbBundleOptions = {},
): Promise<Uint8Array> {
  if (opts.exportPassphrase !== undefined && opts.recipients !== undefined) {
    throw new Error(
      'writeNoydbBundle: pass either exportPassphrase or recipients, not both',
    )
  }

  // #197/#215 — auto-unlock: normalize once, validate + build from the
  // same NormalizedAutoUnlock object so there's no double-normalize call.
  const normalizedAutoUnlock = normalizeAutoUnlock(opts)
  const autoUnlockMode = validateAutoUnlockOptions(opts, normalizedAutoUnlock)

  const handle = await vault.getBundleHandle()
  const dumpJson = await vault.dump()

  // Re-keying: when caller supplied recipients (or the single-recipient
  // shorthand), substitute the bundle's `keyrings` map with freshly
  // built recipient slots before slice filters run.
  const rekeyed = await applyRecipientRewrap(vault, dumpJson, opts)
  // Plaintext-tier filters run BEFORE
  // the metadata-only slice — that way the metadata pass sees the
  // already-trimmed record set and the two filter chains compose
  // cleanly.
  const plainFiltered = await applyPlaintextFilters(vault, rekeyed, opts)
  const filtered = applySliceFilters(plainFiltered, opts)

  // If no auto-unlock requested, body remains the raw dump JSON
  // (pre-#197 shape). Otherwise build the wrapped body containing the
  // dump + `_autoUnlock` blob and serialize.
  const bodyJsonStr = normalizedAutoUnlock === null
    ? filtered
    : JSON.stringify(await buildAutoUnlockWrapper(filtered, normalizedAutoUnlock))
  // Snapshot the source vault's public envelope into the header
  // when one is persisted. `Vault.getPublicEnvelope` tolerates a
  // missing document and returns undefined, which we propagate as
  // "no envelope in the header." Vaults without a
  // `_meta/public-envelope` document produce minimum-disclosure
  // headers exactly like before, preserving back-compat.
  const publicEnvelope = await vault.getPublicEnvelope()

  return assembleBundleContainer({
    handle,
    bodyJsonStr,
    compression: opts.compression,
    headerExtras: {
      ...(publicEnvelope !== undefined ? { publicEnvelope } : {}),
      ...(autoUnlockMode !== null ? { autoUnlock: autoUnlockMode } : {}),
    },
  })
}

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
  header: NoydbBundleHeader
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
 * Returns the same `NoydbBundleHeader` shape as the writer, with
 * minimum-disclosure validation already applied.
 *
 * **Cost** — O(prefix + header bytes). The header is normally well
 * under 1 KB, but may grow to roughly 256 KB when a `publicEnvelope`
 * with an inline icon is present. Cloud-listing UIs that previously
 * assumed sub-KB header reads should account for this when sizing
 * range requests against bundles that may carry icons.
 */
export function readNoydbBundleHeader(bytes: Uint8Array): NoydbBundleHeader {
  return parsePrefixAndHeader(bytes).header
}

/**
 * Read just the bundle's public envelope (`docs/subsystems/public-envelope.md`)
 * — without verifying the body or even parsing the dump JSON. Pass
 * the raw bundle bytes; receive the owner-curated metadata or
 * `undefined` if the bundle was written without one.
 *
 * Locale-resolves any `name` / `description` map fields when `locale`
 * is supplied. Omitting `locale` returns the raw envelope.
 *
 * Same security caveat as the on-vault read path — the public
 * envelope is **untrusted hint** in v1; the encrypted body remains
 * the source of truth for vault contents.
 */
export function readNoydbBundlePublicEnvelope(
  bytes: Uint8Array,
  opts: { readonly locale?: string } = {},
): PublicEnvelope | undefined {
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
 * Note: this function does NOT take a passphrase. The dump JSON
 * inside the body still contains encrypted records — restoring
 * the vault requires `vault.load(dumpJson, passphrase)`
 * after this call. Splitting the layers keeps the bundle module
 * free of crypto concerns and lets the same code feed format
 * inspectors that never decrypt anything.
 */
export async function readNoydbBundle(
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

  // #197 — when the header signaled an auto-unlock, the body is a
  // JSON wrapper carrying the dump string + the auto-unlock blob.
  // When absent, the body IS the raw dump JSON (pre-#197 shape).
  if (header.autoUnlock === undefined) {
    return { header, dumpJson: bodyString }
  }
  const { dump, blob } = parseAutoUnlockBody(bodyString)
  const autoUnlock = await resolveAutoUnlock(blob, opts)
  return { header, dumpJson: dump, autoUnlock }
}
