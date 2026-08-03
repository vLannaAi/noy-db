/**
 * `.noydb` container format — byte layout, header schema, validators.
 *
 *. Wraps a `vault.dump()` JSON string in a thin
 * binary container with a magic-byte prefix, a minimum-disclosure
 * unencrypted header, and a compressed body.
 *
 * **Byte layout** (read in order from offset 0):
 *
 * ```
 * +--------+--------+--------+--------+
 * |  N=78  |  D=68  |  B=66  |  1=49  |  Magic 'NDB1' (4 bytes)
 * +--------+--------+--------+--------+
 * | flags  | compr  |  header_length (uint32 BE)            |
 * +--------+--------+--------+--------+--------+--------+--------+
 * | header_length bytes of UTF-8 JSON header                       ...
 * +--------+--------+
 * | compressed body bytes                                            ...
 * ```
 *
 * Total fixed prefix before the header JSON is **10 bytes**:
 *   - 4 bytes magic
 *   - 1 byte flags
 *   - 1 byte compression algorithm
 *   - 4 bytes header length (uint32 big-endian)
 *
 * **Why a binary container** at all? `vault.dump()` already
 * produces a JSON string with encrypted records inside. Wrapping it
 * again seems redundant — but the wrap is what makes the file safe
 * to drop into cloud storage (Drive, Dropbox, iCloud) without
 * leaking the vault name and exporter identity through the
 * cloud's metadata API. The minimum-disclosure header is the only
 * thing visible without downloading and decompressing the body.
 * The dump JSON inside the body still contains the original
 * metadata, but that's only readable by someone who already has the
 * file bytes — the same person who could read the encrypted records
 * with the right secret.
 *
 * **Why minimum disclosure** in the header? Because consumers will
 * inevitably store these in services where the filename, file size,
 * and any unencrypted metadata are indexed for search. A field like
 * `vault: "Acme Corp"` would let an attacker (or a curious
 * cloud admin) enumerate which compartments exist and who exported
 * them, even with zero access to the encrypted body. The header
 * carries only what's needed to identify the file as a NOYDB
 * bundle and verify its integrity — nothing about the contents.
 */

import type { Cover } from '../with-party/directory/cover/types.js'

/** Magic bytes 'NDB1' (ASCII), identifying a NOYDB bundle. */
export const NOYDB_BUNDLE_MAGIC = new Uint8Array([0x4e, 0x44, 0x42, 0x31])

/** Total fixed prefix before the header JSON: 4+1+1+4 bytes. */
export const NOYDB_BUNDLE_PREFIX_BYTES = 10

/** Current bundle format version. Bumped on layout changes. Default for unsigned pods. */
export const NOYDB_BUNDLE_FORMAT_VERSION = 1

/** Format version for pods carrying a header signature (`sig`/`keyId`/`sigAlg`). */
export const NOYDB_BUNDLE_FORMAT_VERSION_SIGNED = 2

/**
 * Bitfield interpretation of the flags byte.
 *
 * Bit 0 — body is compressed (0 = raw, 1 = compressed)
 * Bit 1 — header carries an integrity hash over the body bytes
 * Bits 2-7 — reserved, must be 0 in
 */
export const FLAG_COMPRESSED = 0b0000_0001
export const FLAG_HAS_INTEGRITY_HASH = 0b0000_0010

/**
 * Compression algorithm encoding for the byte at offset 5.
 *
 * `none` is admitted for round-trip testing and for callers that
 * want to bundle without compression (e.g. when piping into a
 * separately compressed transport). `gzip` is the universally
 * available baseline (Node 18+, all modern browsers). `brotli` is
 * preferred when the runtime supports it — typically 30-50% smaller
 * for JSON payloads — but Node 22+ / Chrome 124+ / Firefox 122+
 * are required, so the writer feature-detects at runtime and falls
 * back to gzip. The reader must handle all three.
 */
export const COMPRESSION_NONE = 0
export const COMPRESSION_GZIP = 1
export const COMPRESSION_BROTLI = 2

export type CompressionAlgo = 0 | 1 | 2

/**
 * The unencrypted header carried in every `.noydb` bundle.
 *
 * **Minimum-disclosure rules:** these are the ONLY allowed keys.
 * Any other key in a parsed header causes
 * `validateBundleHeader` to throw. The set is kept short to
 * minimize attack surface from cloud-storage metadata indexing —
 * see the file-level doc comment for the rationale.
 *
 * Forbidden in particular:
 *   - `vault` / `_compartment` — would leak the tenant name
 *   - `exporter` / `_exported_by` — would leak user identity
 *   - `timestamp` / `_exported_at` — would leak activity timing
 *   - `kdfParams` / salt fields — would leak crypto config that
 *     could narrow brute-force search space
 *   - any field starting with `_` (reserved by the dump format)
 */
export interface NoydbPodHeader {
  /** Bundle format version — bumped on layout changes. */
  readonly formatVersion: number
  /**
   * Opaque ULID identifier — generated once per vault and
   * stable across re-exports of the same vault. Does not
   * leak any information about contents (the timestamp prefix is
   * just monotonicity for sortability, not exporter activity —
   * see `bundle/ulid.ts` for the design notes).
   */
  readonly handle: string
  /** Compressed body length in bytes. Lets readers verify completeness without decompressing. */
  readonly bodyBytes: number
  /** SHA-256 of the compressed body bytes (lowercase hex). Lets readers verify integrity without decompressing. */
  readonly bodySha256: string
  /**
   * Owner-curated cover (`https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md`).
   * Optional — present only when the source vault has a
   * `_meta/public-envelope` document AND the writer's hub is opted
   * into the feature. Treat as **untrusted hint**; the body's
   * encrypted contents remain the source of truth.
   *
   * The JSON key keeps its frozen wire name `publicEnvelope` (#799
   * renamed only the developer surface — existing bundles stay
   * readable byte-for-byte).
   *
   * The cover deliberately widens the minimum-disclosure rule
   * for explicit, owner-curated label fields (name, icon, …). Every
   * other unknown header key still rejects at parse time.
   */
  readonly publicEnvelope?: Cover
  /**
   * Auto-unlock material indicator. When present, the bundle
   * body wraps the dump JSON in a structure carrying per-user
   * secrets — either plaintext (`'unsealed'`, public-by-design)
   * or sealed under a `SealingKeyProvider` (`'sealed'`, requires
   * matching provider on the recipient side).
   *
   * Visible pre-decompression so cloud listing UIs can warn before
   * download: "this bundle opens itself for anyone holding the file"
   * (unsealed) or "this bundle is sealed for a specific provider"
   * (sealed).
   *
   * Absent → the body is a raw `vault.dump()` JSON string (the
   * the legacy shape; back-compatible).
   */
  readonly autoUnlock?: 'unsealed' | 'sealed'
  /**
   * Bundle's role in the source → destination lifecycle.
   *   - omitted / 'snapshot' (default): backup/copy of an existing vault.
   *   - 'extracted-partition': re-keyed projection awaiting adoption.
   */
  readonly bundleKind?: 'snapshot' | 'extracted-partition'
  /**
   * Transfer-seal INDICATOR — metadata only, no payload (the
   * sealed DEKs live in the body). Present iff
   * bundleKind === 'extracted-partition'.
   */
  readonly transferSeal?: {
    readonly v: 1
    readonly alg: 'aes-256-gcm-pre-shared'
    readonly sealId: string
  }
  /**
   * Non-secret 16-hex-char fingerprint identifying the signing key
   * used for `sig`. A hash prefix, not the key itself — discloses no
   * crypto config, safe under minimum-disclosure. Present iff `sig`
   * and `sigAlg` are also present (all-or-nothing 3-tuple), and only
   * on `formatVersion === 2` headers.
   */
  readonly keyId?: string
  /**
   * Signature authenticating the rest of the header (base64url,
   * no padding). Verifies the header wasn't tampered with in
   * transit/storage — see `with-pod/signature.ts`. Part of the
   * sig/keyId/sigAlg 3-tuple.
   */
  readonly sig?: string
  /**
   * Signature algorithm for `sig`. Named `sigAlg` (not `alg`) to
   * avoid confusion with `transferSeal.alg`. Part of the
   * sig/keyId/sigAlg 3-tuple.
   */
  readonly sigAlg?: 'ed25519'
}

/** @deprecated Use `NoydbPodHeader`. */
export type NoydbBundleHeader = NoydbPodHeader

/**
 * Allowlist of header keys. Any key not in this set is forbidden
 * and causes `validateBundleHeader` to throw. Kept as a Set for
 * O(1) lookup; the validator iterates over the parsed header and
 * checks each key against this set.
 */
const ALLOWED_HEADER_KEYS: ReadonlySet<string> = new Set([
  'formatVersion',
  'handle',
  'bodyBytes',
  'bodySha256',
  'publicEnvelope',
  'autoUnlock',
  'bundleKind',
  'transferSeal',
  'sig',
  'keyId',
  'sigAlg',
])

/**
 * Validate a parsed bundle header. Throws on any deviation from
 * the minimum-disclosure schema:
 *
 *   - Missing required field
 *   - Wrong type for any field
 *   - Any extra key not in `ALLOWED_HEADER_KEYS`
 *   - Unsupported `formatVersion`
 *   - Negative or non-integer `bodyBytes`
 *   - Malformed `handle` (must be 26-char Crockford base32)
 *   - Malformed `bodySha256` (must be 64-char lowercase hex)
 *
 * The error messages name the offending field so consumers can
 * fix the producer rather than the reader.
 */
export function validateBundleHeader(
  parsed: unknown,
): asserts parsed is NoydbPodHeader {
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      `.noydb bundle header must be a JSON object, got ${parsed === null ? 'null' : typeof parsed}`,
    )
  }
  // Disallow any unknown key — minimum disclosure means we reject
  // forward-compat extension keys at the format layer; new fields
  // require a format version bump and a new validator.
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_HEADER_KEYS.has(key)) {
      throw new Error(
        `.noydb bundle header contains forbidden key "${key}". ` +
          `Only minimum-disclosure fields are allowed: ` +
          `${[...ALLOWED_HEADER_KEYS].join(', ')}.`,
      )
    }
  }
  const h = parsed as Record<string, unknown>
  if (
    typeof h['formatVersion'] !== 'number' ||
    (h['formatVersion'] !== NOYDB_BUNDLE_FORMAT_VERSION && h['formatVersion'] !== NOYDB_BUNDLE_FORMAT_VERSION_SIGNED)
  ) {
    throw new Error(
      `.noydb bundle header.formatVersion must be ${NOYDB_BUNDLE_FORMAT_VERSION} or ${NOYDB_BUNDLE_FORMAT_VERSION_SIGNED}, ` +
        `got ${String(h['formatVersion'])}. The reader does not support ` +
        `forward-compat versions; upgrade the reader to handle newer bundles.`,
    )
  }
  if (typeof h['handle'] !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(h['handle'])) {
    throw new Error(
      `.noydb bundle header.handle must be a 26-character Crockford base32 ULID, ` +
        `got ${typeof h['handle'] === 'string' ? `"${h['handle']}"` : String(h['handle'])}.`,
    )
  }
  if (typeof h['bodyBytes'] !== 'number' || !Number.isInteger(h['bodyBytes']) || h['bodyBytes'] < 0) {
    throw new Error(
      `.noydb bundle header.bodyBytes must be a non-negative integer, ` +
        `got ${String(h['bodyBytes'])}.`,
    )
  }
  if (typeof h['bodySha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(h['bodySha256'])) {
    throw new Error(
      `.noydb bundle header.bodySha256 must be a 64-character lowercase hex string, ` +
        `got ${typeof h['bodySha256'] === 'string' ? `"${h['bodySha256']}"` : String(h['bodySha256'])}.`,
    )
  }
  if (h['publicEnvelope'] !== undefined) {
    const env = h['publicEnvelope']
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw new Error(
        `.noydb bundle header.publicEnvelope must be a JSON object when present, got ${typeof env}.`,
      )
    }
    const e = env as Record<string, unknown>
    if (e['_noydb_public'] !== 1) {
      throw new Error(
        `.noydb bundle header.publicEnvelope._noydb_public must be 1, got ${String(e['_noydb_public'])}.`,
      )
    }
    if (typeof e['version'] !== 'number' || !Number.isInteger(e['version']) || e['version'] < 1) {
      throw new Error(
        `.noydb bundle header.publicEnvelope.version must be a positive integer, got ${String(e['version'])}.`,
      )
    }
  }
  if (h['autoUnlock'] !== undefined) {
    if (h['autoUnlock'] !== 'unsealed' && h['autoUnlock'] !== 'sealed') {
      const got = typeof h['autoUnlock'] === 'string' ? `"${h['autoUnlock']}"` : typeof h['autoUnlock']
      throw new Error(
        `.noydb bundle header.autoUnlock must be 'unsealed' or 'sealed' when present, got ${got}.`,
      )
    }
  }
  if (h['bundleKind'] !== undefined) {
    if (h['bundleKind'] !== 'snapshot' && h['bundleKind'] !== 'extracted-partition') {
      const got = typeof h['bundleKind'] === 'string' ? `"${h['bundleKind']}"` : typeof h['bundleKind']
      throw new Error(
        `.noydb bundle header.bundleKind must be 'snapshot' or 'extracted-partition' when present, got ${got}.`,
      )
    }
  }
  if (h['transferSeal'] !== undefined) {
    const ts = h['transferSeal']
    if (ts === null || typeof ts !== 'object' || Array.isArray(ts)) {
      throw new Error(`.noydb bundle header.transferSeal must be a JSON object when present, got ${typeof ts}.`)
    }
    const t = ts as Record<string, unknown>
    if (t['v'] !== 1) {
      throw new Error(`.noydb bundle header.transferSeal.v must be 1, got ${String(t['v'])}.`)
    }
    if (t['alg'] !== 'aes-256-gcm-pre-shared') {
      throw new Error(`.noydb bundle header.transferSeal.alg must be 'aes-256-gcm-pre-shared', got ${String(t['alg'])}.`)
    }
    if (typeof t['sealId'] !== 'string' || t['sealId'].length === 0) {
      throw new Error(`.noydb bundle header.transferSeal.sealId must be a non-empty string, got ${String(t['sealId'])}.`)
    }
  }
  if (h['keyId'] !== undefined) {
    if (typeof h['keyId'] !== 'string' || !/^[0-9a-f]{16}$/.test(h['keyId'])) {
      throw new Error(
        `.noydb bundle header.keyId must be a 16-character lowercase hex fingerprint, ` +
          `got ${typeof h['keyId'] === 'string' ? `"${h['keyId']}"` : typeof h['keyId']}.`,
      )
    }
  }
  if (h['sig'] !== undefined) {
    if (typeof h['sig'] !== 'string' || h['sig'].length === 0 || !/^[A-Za-z0-9_-]+$/.test(h['sig'])) {
      throw new Error(
        `.noydb bundle header.sig must be a non-empty base64url string, ` +
          `got ${typeof h['sig'] === 'string' ? `"${h['sig']}"` : typeof h['sig']}.`,
      )
    }
  }
  if (h['sigAlg'] !== undefined) {
    if (h['sigAlg'] !== 'ed25519') {
      const got = typeof h['sigAlg'] === 'string' ? `"${h['sigAlg']}"` : typeof h['sigAlg']
      throw new Error(`.noydb bundle header.sigAlg must be 'ed25519' when present, got ${got}.`)
    }
  }
  // Cross-field invariant: the seal indicator and the extracted-partition
  // kind imply each other. An extracted partition is unlocked via its
  // transfer seal; a seal without the kind is a malformed header.
  const isExtracted = h['bundleKind'] === 'extracted-partition'
  const hasSeal = h['transferSeal'] !== undefined
  if (hasSeal && !isExtracted) {
    throw new Error(
      `.noydb bundle header.transferSeal requires bundleKind === 'extracted-partition'.`,
    )
  }
  if (isExtracted && !hasSeal) {
    throw new Error(
      `.noydb bundle header with bundleKind === 'extracted-partition' must carry a transferSeal indicator.`,
    )
  }
  // An extracted partition's unlock path IS the transfer seal. A parallel
  // autoUnlock credential would create two unlock paths and weaken the
  // one-time-seal guarantee. Reject the combination.
  if (isExtracted && h['autoUnlock'] !== undefined) {
    throw new Error(
      `.noydb bundle header cannot carry both autoUnlock and bundleKind === 'extracted-partition' — `
      + `an extracted partition is unlocked via its transfer seal, not an auto-credential.`,
    )
  }
  // Cross-field invariant: sig/keyId/sigAlg authenticate the header as a
  // unit — a partial tuple (e.g. sig without keyId) is a malformed or
  // truncated signature, not a valid unsigned header. Signed headers also
  // require formatVersion 2 so older readers refuse them instead of
  // silently ignoring the signature.
  const sigFieldsPresent = [h['sig'], h['keyId'], h['sigAlg']].filter((v) => v !== undefined).length
  if (sigFieldsPresent > 0 && sigFieldsPresent < 3) {
    throw new Error(
      `.noydb bundle header.sig, .keyId, and .sigAlg must be present together or not at all ` +
        `(got ${sigFieldsPresent} of 3).`,
    )
  }
  if (sigFieldsPresent === 3 && h['formatVersion'] !== NOYDB_BUNDLE_FORMAT_VERSION_SIGNED) {
    throw new Error(
      `.noydb bundle header with sig/keyId/sigAlg must have formatVersion === ${NOYDB_BUNDLE_FORMAT_VERSION_SIGNED}, ` +
        `got ${String(h['formatVersion'])}.`,
    )
  }
}

/**
 * Encode a header object to UTF-8 JSON bytes after validating
 * minimum disclosure. Used by the writer to serialize the header
 * region of the container.
 */
export function encodeBundleHeader(header: NoydbPodHeader): Uint8Array {
  validateBundleHeader(header)
  // Stable key ordering — JSON.stringify with no replacer uses
  // insertion order, which is fine here because we control the
  // object construction. Stable ordering means two bundles with
  // identical contents produce byte-identical headers.
  const json = JSON.stringify({
    formatVersion: header.formatVersion,
    handle: header.handle,
    bodyBytes: header.bodyBytes,
    bodySha256: header.bodySha256,
    ...(header.publicEnvelope !== undefined ? { publicEnvelope: header.publicEnvelope } : {}),
    ...(header.autoUnlock !== undefined ? { autoUnlock: header.autoUnlock } : {}),
    ...(header.bundleKind !== undefined ? { bundleKind: header.bundleKind } : {}),
    ...(header.transferSeal !== undefined ? { transferSeal: header.transferSeal } : {}),
    // Encode order here is the WIRE-byte contract only — it does NOT
    // affect the signature. The signer (Task 4/5) signs the header
    // object via canonicalJson, which re-sorts keys independent of
    // this insertion order.
    ...(header.sig !== undefined ? { sig: header.sig } : {}),
    ...(header.keyId !== undefined ? { keyId: header.keyId } : {}),
    ...(header.sigAlg !== undefined ? { sigAlg: header.sigAlg } : {}),
  })
  return new TextEncoder().encode(json)
}

/**
 * Parse a bundle header from its UTF-8 JSON bytes. Throws on
 * invalid JSON or any minimum-disclosure violation.
 */
export function decodeBundleHeader(bytes: Uint8Array): NoydbPodHeader {
  const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(
      `.noydb bundle header is not valid JSON: ${(err as Error).message}`,
    )
  }
  validateBundleHeader(parsed)
  return parsed
}

/**
 * Read a uint32 from `bytes` at `offset` in big-endian byte order.
 * No bounds check — callers must guarantee `offset + 4 <= bytes.length`.
 * Used to decode the header length field; kept inline so the parser
 * doesn't depend on DataView allocation per call.
 */
export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 24 >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  )
}

/**
 * Write a uint32 to `bytes` at `offset` in big-endian byte order.
 * No bounds check — callers must guarantee `offset + 4 <= bytes.length`.
 */
export function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

/**
 * Verify the magic prefix of a bundle. Returns true if the first
 * 4 bytes match `NDB1`. Used by readers as a fast file-type check
 * before any further parsing.
 */
export function hasNoydbBundleMagic(bytes: Uint8Array): boolean {
  if (bytes.length < NOYDB_BUNDLE_MAGIC.length) return false
  for (let i = 0; i < NOYDB_BUNDLE_MAGIC.length; i++) {
    if (bytes[i] !== NOYDB_BUNDLE_MAGIC[i]) return false
  }
  return true
}
