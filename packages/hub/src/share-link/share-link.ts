/**
 * Portal share-link grammar + parse/build helper (#806).
 *
 * ONE canonical link grammar addresses `vault / period / collection /
 * record` across all three portal surfaces — the LIFF permalink path
 * (`https://liff.line.me/{liffId}/r/…`), the installed-PWA same-origin
 * path (`https://{portal-origin}/r/…`), and the vendor backend console.
 * The link SHAPE is identical everywhere; only the origin prefix
 * differs, and callers own the prefix.
 *
 * ## Grammar (frozen — see `__tests__/share-link-surface.golden.json`)
 *
 * ```
 * share-link = [ base ] "/r/" vault "/" collection "/" record
 *              [ "?" query ] [ "#" fragment ]
 * vault      = ULID                        ; 26 uppercase Crockford base32 chars
 * collection = segment                     ; opaque, non-empty after decode
 * record     = segment                     ; opaque, non-empty after decode
 * query      = pair *( "&" pair )          ; keys unique; ONLY these two keys
 * pair       = "period=" component         ; opaque period id
 *            / "v=" version                ; record version
 * version    = "0" / %x31-39 *DIGIT        ; base-10 integer, ≤ 2^53 − 1
 * fragment   = "g=" component              ; single-use grant token (opaque)
 * ```
 *
 * `segment` / `component` are strict-canonical `encodeURIComponent`
 * output: decoding then re-encoding MUST reproduce the raw text exactly
 * (uppercase-hex escapes, `+` is a literal plus never a space, `%2F`
 * inside a segment never creates an extra segment). Path segments
 * additionally may not decode to `.` or `..`. Links produced by
 * {@link buildShareLink} always satisfy this; hand-written links using
 * only unreserved characters (`inv-001`, ULIDs, …) do too.
 *
 * ## Transport rule for the grant token
 *
 * The optional single-use grant token travels ONLY in the URL fragment
 * (`#g={token}`) — never in the path or query — because fragments are
 * not sent to servers, so the token never reaches server logs, CDNs, or
 * LINE's infrastructure. Same rule `on-magic-link` follows. The token is
 * fully OPAQUE here: no validation beyond non-empty, no decoding of its
 * semantics — grant semantics live in `on-magic-link` (not imported).
 *
 * ## Fail closed
 *
 * {@link parseShareLink} throws a typed {@link ShareLinkParseError} for
 * ANYTHING that is not exactly the grammar above — unknown prefix,
 * missing/extra/empty/malformed segments, a non-ULID vault handle,
 * duplicate or unknown query keys, malformed fragments. There is never a
 * default-vault (or any other) fallback; the app maps the error to a 404.
 *
 * Zero dependencies on the hub floor: pure string/`URL` code, no crypto,
 * no store — LIFF shells, PWAs, and klum-db can import this subpath
 * without dragging anything else. (The one internal import is the pure,
 * leaf ULID shape check shared with the pod format.)
 */

import { isULID } from '../with-pod/ulid.js'

/** Machine-readable {@link ShareLinkParseError} discriminant. */
export type ShareLinkErrorCode =
  | 'MALFORMED_URL'
  | 'UNKNOWN_PREFIX'
  | 'MALFORMED_PATH'
  | 'MALFORMED_SEGMENT'
  | 'INVALID_VAULT_HANDLE'
  | 'MALFORMED_QUERY'
  | 'DUPLICATE_QUERY_KEY'
  | 'UNKNOWN_QUERY_KEY'
  | 'INVALID_VERSION'
  | 'MALFORMED_FRAGMENT'
  | 'INVALID_PARTS'

/**
 * Typed failure for the share-link grammar. Thrown by
 * {@link parseShareLink} for any input outside the grammar (fail closed —
 * map to an app-level 404, never a default-vault fallback), and by
 * {@link buildShareLink} with code `'INVALID_PARTS'` when the caller
 * hands it parts that could not round-trip.
 *
 * Standalone (`extends Error`, not `NoydbError`) so this subpath stays
 * import-light; the `code` field follows the same machine-readable
 * convention as the kernel error classes.
 */
export class ShareLinkParseError extends Error {
  /** Machine-readable error code. Stable across library versions. */
  readonly code: ShareLinkErrorCode

  constructor(code: ShareLinkErrorCode, message: string) {
    super(message)
    this.name = 'ShareLinkParseError'
    this.code = code
  }
}

/**
 * The logical address a share link carries. Input to
 * {@link buildShareLink}; {@link parseShareLink} returns the same shape
 * (as the readonly {@link ShareLink} alias) with optional fields OMITTED
 * (not `undefined`) when absent from the link.
 */
export interface ShareLinkParts {
  /** Vault handle — a 26-character uppercase Crockford-base32 ULID. */
  vaultHandle: string
  /** Collection name — opaque, non-empty. */
  collection: string
  /** Record id — opaque, non-empty. */
  recordId: string
  /** Optional period id (`?period=`) — opaque, non-empty. */
  period?: string
  /** Optional record version (`?v=`) — non-negative safe integer. */
  version?: number
  /**
   * Optional single-use grant token (`#g=`) — opaque, non-empty. Carried
   * ONLY in the URL fragment; semantics belong to `on-magic-link`.
   */
  grantToken?: string
}

/** A successfully parsed share link. See {@link ShareLinkParts}. */
export type ShareLink = Readonly<ShareLinkParts>

// Dummy base for parsing bare `/r/…` paths with the WHATWG URL parser.
// `.invalid` is reserved (RFC 2606) — it can never collide with a real
// origin, and the host is discarded anyway (only path/query/fragment
// matter to the grammar).
const DUMMY_BASE = 'https://share-link.invalid'

/**
 * Canonical encoding of a QUERY value. `encodeURIComponent`, plus `'`
 * → `%27`: the WHATWG URL parser percent-encodes the apostrophe inside
 * the query component of special (http/https) URLs — if we emitted a
 * raw `'`, any URL-object round-trip (browser address bar, `new URL`)
 * would rewrite the link into a form the strict parser then rejects.
 * Path and fragment components don't need this — every character the
 * URL parser escapes there is already escaped by `encodeURIComponent`.
 */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/'/g, '%27')
}

/**
 * Strict-canonical decode: `raw` must be exactly what the given
 * canonical `encode` produces for the decoded text — no `+`-for-space,
 * no lowercase hex escapes, no unencoded reserved characters,
 * non-empty. `redact` keeps the raw text out of the error message
 * (grant tokens).
 */
function decodeCanonical(
  raw: string,
  code: ShareLinkErrorCode,
  what: string,
  { redact = false, encode = encodeURIComponent }: {
    redact?: boolean
    encode?: (value: string) => string
  } = {},
): string {
  const shown = redact ? '(redacted)' : `"${raw}"`
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw new ShareLinkParseError(code, `${what}: malformed percent-encoding in ${shown}`)
  }
  if (decoded === '') {
    throw new ShareLinkParseError(code, `${what}: empty`)
  }
  if (encode(decoded) !== raw) {
    throw new ShareLinkParseError(
      code,
      `${what}: ${shown} is not canonical encodeURIComponent output`,
    )
  }
  return decoded
}

/** Path-segment decode — canonical, plus the dot-segment refusal. */
function decodePathSegment(raw: string, what: string): string {
  const decoded = decodeCanonical(raw, 'MALFORMED_SEGMENT', what)
  if (decoded === '.' || decoded === '..') {
    throw new ShareLinkParseError('MALFORMED_SEGMENT', `${what}: "${decoded}" is a dot segment`)
  }
  return decoded
}

/** `v=` value → non-negative safe integer. Canonical base-10 only. */
function parseVersion(raw: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new ShareLinkParseError(
      'INVALID_VERSION',
      `version "${raw}" is not a canonical base-10 integer`,
    )
  }
  const version = Number(raw)
  if (!Number.isSafeInteger(version)) {
    throw new ShareLinkParseError('INVALID_VERSION', `version "${raw}" exceeds 2^53 - 1`)
  }
  return version
}

/** Resolve string | URL input to a URL object, fail closed. */
function toUrl(input: string | URL): URL {
  if (input instanceof URL) {
    if (input.protocol !== 'http:' && input.protocol !== 'https:') {
      throw new ShareLinkParseError(
        'UNKNOWN_PREFIX',
        `unsupported protocol "${input.protocol}" — share links are http(s) URLs or bare /r/ paths`,
      )
    }
    return input
  }
  if (input.startsWith('/')) {
    try {
      return new URL(input, DUMMY_BASE)
    } catch {
      throw new ShareLinkParseError('MALFORMED_URL', 'unparseable share path')
    }
  }
  if (/^https?:\/\//i.test(input)) {
    try {
      return new URL(input)
    } catch {
      throw new ShareLinkParseError('MALFORMED_URL', 'unparseable share URL')
    }
  }
  throw new ShareLinkParseError(
    'UNKNOWN_PREFIX',
    'input is neither a "/"-rooted share path nor an http(s) URL',
  )
}

/**
 * Parse a share link — full URL, `URL` instance, or bare `/r/…` path.
 *
 * A LIFF permalink prefix is tolerated: when the path does not start
 * with `/r/` directly, the share path is taken from the FIRST `/r/`
 * segment boundary (`https://liff.line.me/{liffId}/r/…` → `/r/…`). No
 * fuzzy matching beyond that single rule.
 *
 * Fail closed: anything outside the grammar throws
 * {@link ShareLinkParseError}. Never a default-vault fallback.
 */
export function parseShareLink(input: string | URL): ShareLink {
  const url = toUrl(input)

  let pathname = url.pathname
  if (!pathname.startsWith('/r/')) {
    // LIFF permalink tolerance — only after the direct parse failed. An
    // indexOf hit is always a whole `r` segment (the match is slash-
    // delimited on both sides), so this cannot fire mid-segment.
    const idx = pathname.indexOf('/r/')
    if (idx === -1) {
      throw new ShareLinkParseError(
        'UNKNOWN_PREFIX',
        `path "${pathname}" has no /r/ share prefix`,
      )
    }
    pathname = pathname.slice(idx)
  }

  // "/r/{vault}/{collection}/{record}" splits into exactly 5 parts:
  // ['', 'r', vault, collection, record].
  const rawSegments = pathname.split('/')
  if (rawSegments.length !== 5) {
    throw new ShareLinkParseError(
      'MALFORMED_PATH',
      `expected /r/{vaultHandle}/{collection}/{recordId} — got ${rawSegments.length - 2} segment(s) after /r/`,
    )
  }

  const vaultHandle = decodePathSegment(rawSegments[2]!, 'vault handle')
  if (!isULID(vaultHandle)) {
    throw new ShareLinkParseError(
      'INVALID_VAULT_HANDLE',
      `vault handle "${vaultHandle}" is not a ULID`,
    )
  }
  const collection = decodePathSegment(rawSegments[3]!, 'collection')
  const recordId = decodePathSegment(rawSegments[4]!, 'record id')

  // Query — manual parse of url.search (NOT URLSearchParams, whose
  // form-urlencoded rules decode "+" as a space and hide duplicates).
  let period: string | undefined
  let version: number | undefined
  if (url.search !== '') {
    const seen = new Set<string>()
    for (const pair of url.search.slice(1).split('&')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) {
        throw new ShareLinkParseError('MALFORMED_QUERY', `query pair "${pair}" is not key=value`)
      }
      const key = pair.slice(0, eq)
      const rawValue = pair.slice(eq + 1)
      if (key !== 'period' && key !== 'v') {
        throw new ShareLinkParseError('UNKNOWN_QUERY_KEY', `unknown query key "${key}"`)
      }
      if (seen.has(key)) {
        throw new ShareLinkParseError('DUPLICATE_QUERY_KEY', `duplicate query key "${key}"`)
      }
      seen.add(key)
      if (key === 'period') {
        period = decodeCanonical(rawValue, 'MALFORMED_QUERY', 'period', {
          encode: encodeQueryValue,
        })
      } else {
        version = parseVersion(rawValue)
      }
    }
  }

  // Fragment — the ONLY place a grant token may appear.
  let grantToken: string | undefined
  if (url.hash !== '' && url.hash !== '#') {
    const fragment = url.hash.slice(1)
    if (!fragment.startsWith('g=')) {
      throw new ShareLinkParseError(
        'MALFORMED_FRAGMENT',
        'fragment is not a g={token} grant carrier',
      )
    }
    grantToken = decodeCanonical(fragment.slice(2), 'MALFORMED_FRAGMENT', 'grant token', {
      redact: true,
    })
  }

  return {
    vaultHandle,
    collection,
    recordId,
    ...(period !== undefined ? { period } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(grantToken !== undefined ? { grantToken } : {}),
  }
}

/** Build-side part validation. Returns the (narrowed) string value. */
function requirePart(value: unknown, what: string, dotSegmentRefused = false): string {
  if (typeof value !== 'string' || value === '') {
    throw new ShareLinkParseError('INVALID_PARTS', `${what} must be a non-empty string`)
  }
  if (dotSegmentRefused && (value === '.' || value === '..')) {
    throw new ShareLinkParseError('INVALID_PARTS', `${what}: "${value}" is a dot segment`)
  }
  return value
}

/**
 * Build a RELATIVE share link (`/r/…`) from typed parts. Callers prefix
 * their surface origin — the LIFF permalink base, the PWA origin, or the
 * vendor console — either themselves or via `base`, which is prepended
 * VERBATIM (no validation, no joining logic; pass it without a trailing
 * slash, e.g. `https://liff.line.me/{liffId}`).
 *
 * The grant token, when present, is emitted ONLY as the `#g=` fragment.
 * Invalid parts throw {@link ShareLinkParseError} with code
 * `'INVALID_PARTS'` — every built link is guaranteed to round-trip
 * through {@link parseShareLink}.
 */
export function buildShareLink(parts: ShareLinkParts, base?: string): string {
  const { vaultHandle, collection, recordId, period, version, grantToken } = parts

  if (typeof vaultHandle !== 'string' || !isULID(vaultHandle)) {
    throw new ShareLinkParseError('INVALID_PARTS', 'vaultHandle is not a ULID')
  }
  const path = `/r/${vaultHandle}/${encodeURIComponent(
    requirePart(collection, 'collection', true),
  )}/${encodeURIComponent(requirePart(recordId, 'recordId', true))}`

  const query: string[] = []
  if (period !== undefined) {
    query.push(`period=${encodeQueryValue(requirePart(period, 'period'))}`)
  }
  if (version !== undefined) {
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
      throw new ShareLinkParseError('INVALID_PARTS', 'version must be a non-negative safe integer')
    }
    query.push(`v=${version}`)
  }

  const fragment =
    grantToken !== undefined
      ? `#g=${encodeURIComponent(requirePart(grantToken, 'grantToken'))}`
      : ''

  return (base ?? '') + path + (query.length > 0 ? `?${query.join('&')}` : '') + fragment
}
