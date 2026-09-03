/**
 * Keyset cursors for `Query.page()` / `Query.after()` (#1346).
 *
 * A cursor names a POSITION — the `(sortKey, id)` of the last row a page
 * served — not an offset. That is the whole point: a record inserted or
 * deleted before the position cannot shift the next window, where
 * `offset(n)` would re-serve or skip a row.
 *
 * The encoding is deliberately OPAQUE: consumers must treat the string as a
 * token and pass it back verbatim, so the shape stays free to change. It is
 * an encoding, NOT a signature — a cursor carries no secret and travels only
 * as far as the caller sends it. The `shape` token is an integrity check
 * against consumer mistakes (a cursor replayed against another sort order or
 * another collection), not against an adversary.
 *
 * Portability: hub/src must run in a browser/Worker/Deno/Bun, so the base64
 * step uses `btoa`/`atob` over a `TextEncoder` byte string — never `Buffer`.
 */

import type { OrderBy } from './builder.js'

/** Bumped if the encoded payload's shape ever changes; old cursors then refuse. */
const CURSOR_VERSION = 1

/** The decoded keyset a cursor names. */
export interface KeysetCursor {
  /** The sort spec + source identity this cursor was minted for. */
  readonly shape: string
  /** The row's sort-key values, one per `orderBy` entry. */
  readonly values: readonly unknown[]
  /** The row's record id — the tiebreak that makes the keyset a total order. */
  readonly id: string
}

/**
 * The token a cursor is bound to. Two queries may resume each other's cursors
 * only when this matches: same source, same ordered sort spec.
 */
export function keysetShape(identity: string | undefined, orderBy: readonly OrderBy[]): string {
  const spec = orderBy.map(o => `${o.field}:${o.direction}:${o.by ?? 'value'}`).join(',')
  return `${identity ?? '(anonymous source)'}::${spec}`
}

/**
 * Tag the value types the order comparator distinguishes. Everything else it
 * treats as equal anyway (see `compareValues`), so encoding it as `null`
 * loses nothing the comparison would have used — the id tiebreak carries the
 * page forward.
 */
function encodeValue(v: unknown): unknown {
  if (v instanceof Date) return { $d: v.toISOString() }
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  return null
}

function decodeValue(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && '$d' in (v as Record<string, unknown>)) {
    return new Date((v as { $d: string }).$d)
  }
  return v
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function fromBase64(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function encodeCursor(cursor: KeysetCursor): string {
  return toBase64(
    JSON.stringify({
      v: CURSOR_VERSION,
      k: cursor.shape,
      s: cursor.values.map(encodeValue),
      i: cursor.id,
    }),
  )
}

/**
 * Decode a cursor and REFUSE it unless it was minted for `expectedShape`.
 * Silently returning a nonsense window for a mismatched cursor is the
 * failure mode this exists to prevent.
 */
export function decodeCursor(raw: string, expectedShape: string): KeysetCursor {
  let payload: { v?: unknown; k?: unknown; s?: unknown; i?: unknown }
  try {
    payload = JSON.parse(fromBase64(raw)) as typeof payload
  } catch {
    throw new Error(
      `Query.after(): the value passed is not a valid keyset cursor. ` +
        `Pass back the \`nextCursor\` from a previous .page() call, verbatim.`,
    )
  }
  if (
    payload === null ||
    typeof payload !== 'object' ||
    payload.v !== CURSOR_VERSION ||
    typeof payload.k !== 'string' ||
    !Array.isArray(payload.s) ||
    typeof payload.i !== 'string'
  ) {
    throw new Error(
      `Query.after(): the value passed is not a valid keyset cursor ` +
        `(or was minted by an incompatible version). Pass back the ` +
        `\`nextCursor\` from a previous .page() call, verbatim.`,
    )
  }
  if (payload.k !== expectedShape) {
    throw new Error(
      `Query.after(): this cursor was minted for a different query shape. ` +
        `Cursor: "${payload.k}"; this query: "${expectedShape}". A keyset ` +
        `cursor is only valid for the same collection and the same ` +
        `orderBy(...) spec that produced it.`,
    )
  }
  return { shape: payload.k, values: payload.s.map(decodeValue), id: payload.i }
}
