/**
 * Civil-date recognition for `dateTrunc()` (#1410).
 *
 * ## Why this module exists
 *
 * `dateTrunc()` buckets a value by resolving it to an instant and reading the
 * civil calendar date that instant falls on in the declared `timeZone`. That is
 * exactly right for a *timestamp*. It is a **category error** for a value that
 * names no instant.
 *
 * `'2026-01-01'` — the shape `z.string().date()` produces — is a calendar date.
 * ECMA-262 nonetheless resolves the ISO date-only form to **UTC midnight**, and
 * converting that instant into any zone west of UTC moves it back a day. So
 * `dateTrunc(..., 'month', { timeZone: 'America/New_York' })` silently bucketed
 * `'2026-01-01'` into `2025-12` — a wrong year, no error, no warning. Correct at
 * `+07` and UTC purely by accident of sign, which is what made it latent.
 *
 * ## The rule
 *
 * **A string carrying no timezone designator denotes CIVIL time and is used as
 * written. Everything else is an instant and is converted through the zone.**
 *
 * That covers three shapes, all of which are zoneless:
 *
 * | input | denotes | why |
 * |---|---|---|
 * | `'2026-01-01'`, `'2026-01'`, `'2026'` | civil | ISO calendar forms; no time, no zone |
 * | `'2026-01-01T08:30'`, `'2026-01-01 08:30:00.5'` | civil | offsetless date-time |
 * | `'2026-01-01T00:00:00Z'`, `'…+07:00'`, `Date`, epoch ms | instant | carries, or *is*, a fixed point in time |
 *
 * The offsetless date-time is the subtle one and it is included **deliberately**.
 * ECMA-262 parses it as *host-local*, which is the same defect one layer down:
 * the bucket would depend on the machine the query ran on, and this module's
 * whole premise (see `date-trunc.ts`) is that a host-local guess is never
 * acceptable. Reading it as civil makes the result host-independent. The
 * time-of-day is then simply discarded — every `dateTrunc` unit is a day or
 * coarser, so no unit can observe it.
 *
 * ⚠️ **Loose, non-ISO strings are NOT recognised here** — `'01/01/2026'`,
 * RFC-2822, and anything else `Date.parse` accepts by implementation extension
 * stay on the instant path. Their parsing is implementation-defined, so there
 * is no shape this module could claim to recognise correctly; a consumer who
 * wants civil treatment should pass an ISO calendar date.
 *
 * ⚠️ **An out-of-range field is REFUSED, not rolled over.** V8's `Date.parse`
 * accepts `'2026-02-30'` and yields 2 March; bucketing a typo under a
 * wrong-but-plausible key is the failure mode this whole module exists to
 * prevent, so a recognised-shape-but-impossible date throws instead.
 */

/** A calendar date with no instant and no zone. `m` is 1-12. */
export interface CivilDate {
  readonly y: number
  readonly m: number
  readonly d: number
}

/**
 * `YYYY[-M[-D[(T| )HH:MM[:SS[.fff]]]]]` and nothing else — in particular no
 * trailing `Z` and no `±HH:MM`, which are precisely the designators that turn
 * the string into an instant.
 */
const CIVIL =
  /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)?)?$/

/** Days in `m` of `y`, proleptic Gregorian. */
function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
}

/**
 * What a value denotes:
 *   - a {@link CivilDate} — a zoneless calendar shape, use it as written;
 *   - `'invalid'` — a recognised calendar shape naming no real day (see the
 *     out-of-range note above); the caller refuses it with its own context;
 *   - `undefined` — an instant, or an unrecognised shape: convert through the
 *     declared zone exactly as before.
 */
export function civilDateOf(value: unknown): CivilDate | 'invalid' | undefined {
  if (typeof value !== 'string') return undefined
  const match = CIVIL.exec(value)
  if (match === null) return undefined
  const y = Number(match[1])
  const m = match[2] === undefined ? 1 : Number(match[2])
  const d = match[3] === undefined ? 1 : Number(match[3])
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return 'invalid'
  return { y, m, d }
}
