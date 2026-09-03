/**
 * Calendar bucketing for group keys — `dateTrunc()` (#1350).
 *
 * ```ts
 * invoices.query()
 *   .groupBy(dateTrunc('issuedAt', 'month', { timeZone: 'Europe/Berlin' }))
 *   .aggregate({ total: sum('amount') })
 *   .run()
 * // → [ { issuedAt_month: '2026-09-01', total: 5250 }, … ]
 * ```
 *
 * ## The timezone is a REQUIRED parameter, never a host-local guess
 *
 * An accounting period is a local-calendar fact: "September" means the
 * September of some jurisdiction's calendar, and the same instant belongs to
 * different months depending on which. A host-local default would make the
 * same query produce different rollups on a laptop in Berlin and a CI runner
 * in UTC — silently, with no error and a plausible-looking number. So
 * `timeZone` has no default: omit it and the descriptor is refused at
 * construction, which is also where an unknown zone is caught.
 *
 * ## The bucket value is the local calendar date of the bucket START
 *
 * Every unit produces `'YYYY-MM-DD'`: `'2026-09-01'` for September 2026,
 * `'2026-07-01'` for Q3, `'2026-01-01'` for the year, `'2026-08-31'` for the
 * ISO week containing 3 September. One shape for all five units, lexically
 * sortable, and free of the week-numbering ambiguity that `'2026-W36'` would
 * drag in (ISO week-years disagree with calendar years at the boundary, and
 * ISO week numbers are undefined for a sunday-start week).
 *
 * ## Week start
 *
 * `weekStartsOn` defaults to `'monday'` (ISO-8601). `'sunday'` is the other
 * accepted value. It is only consulted for `unit: 'week'`, but it is part of
 * the descriptor's identity either way, so it folds into the queryHash.
 *
 * ## DST
 *
 * No arithmetic is ever done on a timestamp. The instant is resolved to a
 * local civil date through `Intl.DateTimeFormat` (the platform's own tz
 * database), and every truncation from there is pure civil-calendar
 * arithmetic. A 23-hour or 25-hour local day therefore needs no special case:
 * both ends of it format to the same local date.
 *
 * Portability: `Intl` is a language global, so this file stays inside hub's
 * no-Node-built-ins boundary and adds no dependency.
 */

/** Calendar units `dateTrunc()` can bucket into. */
export type DateTruncUnit = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** Accepted week-start conventions. Default is `'monday'` (ISO-8601). */
export type WeekStart = 'monday' | 'sunday'

const UNITS: readonly DateTruncUnit[] = ['day', 'week', 'month', 'quarter', 'year']
const WEEK_STARTS: readonly WeekStart[] = ['monday', 'sunday']

/**
 * A derived group key: "bucket `field` to the start of its `unit`, in
 * `timeZone`". Opaque to consumers — build it with {@link dateTrunc}.
 */
export interface DateTruncKey {
  readonly __dateTrunc: true
  /** Source field (a `readPath` path — dots address nested values). */
  readonly field: string
  readonly unit: DateTruncUnit
  /** IANA zone name. Always explicit; validated at construction. */
  readonly timeZone: string
  readonly weekStartsOn: WeekStart
  /** Output key the bucket is stamped under on each result row. */
  readonly as: string
}

/** Either a plain field name or a derived calendar key. */
export type GroupKey = string | DateTruncKey

export interface DateTruncOptions {
  /**
   * IANA timezone the calendar is read in — REQUIRED. See the module note:
   * there is no safe default, so there is no default.
   */
  timeZone: string
  /** Week-start convention for `unit: 'week'`. Default `'monday'`. */
  weekStartsOn?: WeekStart
  /**
   * Output key. Defaults to `<field>_<unit>` with dots flattened to
   * underscores, so a nested source path cannot produce an output key that
   * `readPath` would then re-interpret as a path.
   */
  as?: string
}

/**
 * Declare a calendar-bucketed group key. Composable with plain field names in
 * a multi-key `.groupBy(...)`.
 */
export function dateTrunc(
  field: string,
  unit: DateTruncUnit,
  options: DateTruncOptions,
): DateTruncKey {
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error('dateTrunc(): field must be a non-empty field name.')
  }
  if (!UNITS.includes(unit)) {
    throw new Error(
      `dateTrunc("${field}"): unknown unit "${String(unit)}". Expected one of ${UNITS.join(', ')}.`,
    )
  }
  const timeZone = options?.timeZone
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new Error(
      `dateTrunc("${field}", "${unit}"): timeZone is required. An accounting period is a ` +
        `local-calendar fact, so there is no safe host-local default — pass an IANA zone ` +
        `(e.g. { timeZone: 'Europe/Berlin' }), or { timeZone: 'UTC' } to bucket in UTC.`,
    )
  }
  try {
    formatterFor(timeZone)
  } catch {
    throw new Error(
      `dateTrunc("${field}", "${unit}"): unknown timeZone "${timeZone}". Expected an IANA zone name.`,
    )
  }
  const weekStartsOn = options.weekStartsOn ?? 'monday'
  if (!WEEK_STARTS.includes(weekStartsOn)) {
    throw new Error(
      `dateTrunc("${field}", "${unit}"): weekStartsOn must be ${WEEK_STARTS.join(' or ')}.`,
    )
  }
  return {
    __dateTrunc: true,
    field,
    unit,
    timeZone,
    weekStartsOn,
    as: options.as ?? `${field.replaceAll('.', '_')}_${unit}`,
  }
}

/** Runtime discriminator — a `DateTruncKey` vs a plain field name. */
export function isDateTruncKey(value: unknown): value is DateTruncKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __dateTrunc?: unknown }).__dateTrunc === true
  )
}

/** Output key a group key stamps on the result row. */
export function groupKeyName(key: GroupKey): string {
  return isDateTruncKey(key) ? key.as : key
}

/**
 * Source field a group key READS. Differs from {@link groupKeyName} only for a
 * derived key — guards that ask "is this field stored?" want this one.
 */
export function groupKeySourceField(key: GroupKey): string {
  return isDateTruncKey(key) ? key.field : key
}

/**
 * Canonical, stable description of a group key for hashing. Every parameter
 * that changes which bucket a row lands in appears here, so declaring,
 * removing, or re-parameterising a derived key bumps an MV's `queryHash`.
 * Pipe-separated so a description can never be confused with the
 * comma-separated field list it sits inside.
 */
export function describeGroupKey(key: GroupKey): string {
  if (!isDateTruncKey(key)) return key
  return `dateTrunc(${key.field}|${key.unit}|${key.timeZone}|${key.weekStartsOn}|${key.as})`
}

/**
 * Truncate one value to its bucket. `null` / `undefined` pass through
 * unchanged so the existing null-vs-undefined bucket semantics of
 * `groupAndReduce` still apply. Anything else that is not a timestamp is
 * REFUSED rather than bucketed under a wrong-but-plausible key.
 */
export function truncateDate(value: unknown, key: DateTruncKey): string | null | undefined {
  if (value === null || value === undefined) return value
  const ms = toEpochMs(value)
  if (ms === undefined) {
    throw new Error(
      `dateTrunc("${key.field}", "${key.unit}"): value ${JSON.stringify(value) ?? typeof value} ` +
        `is not a timestamp. Expected a Date, epoch milliseconds, or a parseable date string.`,
    )
  }
  const { y, m, d } = localCivilDate(ms, key.timeZone)
  switch (key.unit) {
    case 'day':
      return ymd(y, m, d)
    case 'month':
      return ymd(y, m, 1)
    case 'quarter':
      return ymd(y, m - ((m - 1) % 3), 1)
    case 'year':
      return ymd(y, 1, 1)
    case 'week': {
      const days = daysFromCivil(y, m, d)
      // 1970-01-01 (day 0) was a Thursday; +4 shifts to a sunday-indexed week.
      const sundayIndex = (((days % 7) + 7) % 7 + 4) % 7
      const back = key.weekStartsOn === 'monday' ? (sundayIndex + 6) % 7 : sundayIndex
      const start = civilFromDays(days - back)
      return ymd(start.y, start.m, start.d)
    }
  }
}

/**
 * Stamp each derived key's bucket onto a shallow copy of every row, so the
 * downstream grouping pipeline sees an ordinary stored field. Input rows are
 * never mutated.
 */
export function projectDateTruncKeys<R>(
  rows: readonly R[],
  keys: readonly DateTruncKey[],
): R[] {
  return rows.map((row) => {
    const next = { ...(row as Record<string, unknown>) }
    for (const key of keys) {
      next[key.as] = truncateDate(readFieldPath(next, key.field), key)
    }
    return next as R
  })
}

// ─── internals ──────────────────────────────────────────────────────────────

/**
 * Local `readPath`. Duplicating six lines from `predicate.ts` keeps this
 * module importable from the MV executor without dragging the query
 * predicate evaluator in behind it.
 */
function readFieldPath(row: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return row[path]
  let cur: unknown = row
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function toEpochMs(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** The civil (wall-clock) calendar date an instant falls on, in `timeZone`. */
function localCivilDate(ms: number, timeZone: string): { y: number; m: number; d: number } {
  let y = 0
  let m = 0
  let d = 0
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type === 'year') y = Number(part.value)
    else if (part.type === 'month') m = Number(part.value)
    else if (part.type === 'day') d = Number(part.value)
  }
  return { y, m, d }
}

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Days since 1970-01-01 for a civil date (Hinnant's algorithm; `m` is 1-12). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** Inverse of {@link daysFromCivil}. */
function civilFromDays(z: number): { y: number; m: number; d: number } {
  const shifted = z + 719468
  const era = Math.floor(shifted / 146097)
  const doe = shifted - era * 146097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  )
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return { y: m <= 2 ? y + 1 : y, m, d }
}
