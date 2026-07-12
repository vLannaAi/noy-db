/**
 * The `'lookup'` `ViaBinding` — wires the lookup engine (present-time label
 * dressing across all three backing tiers) into the kernel's generic Via
 * port. Mirrors `shape/via-i18n/binding.ts`'s #553 static-link pattern; the
 * present-time label-dressing algorithm below is adapted from
 * `via-i18n/binding.ts:253-337` (the same wildcard/array/scalar handling,
 * the same `onMissing`/`substitute` policy engine), generalized to branch on
 * `backing` instead of a static-vs-dynamic descriptor-shape check. For the
 * `'static'` and `'reserved'` tiers this delegates to `cfg.lookupLabelResolver`
 * — the SAME vault-built closure the i18n binding's `dictLabelResolver` uses
 * (static table first, else the `vault.dictionary()` handle) — so a native
 * `dict()`/`lookup(static)` field resolves through the identical label data
 * as its `dictKey()`/`staticDict()` alias (the byte-equivalence lock).
 *
 * `lookup()`/`enumOf()`/`dict()` each call {@link linkLookupVia} first — the
 * same #553 pattern `money()`/`dictKey()` use.
 *
 * Query hooks (`buildClause`/`compareForOrder`) and membership
 * (`enforceWrite`) land in later tasks (#650 Tasks 3/6) — this binding
 * declares `covers`/`posture`/`reservedPrefixes`/`present`/`describeFragment`
 * only.
 */
import type { ViaBinding, ViaReadCtx } from '../../kernel/via.js'
import { installViaBinder } from '../../kernel/via.js'
import type { LookupDescriptor } from './descriptor.js'
import { resolvePolicy, type Layer } from '../via-i18n/policy.js'
import { LocaleNotSpecifiedError, UnknownLookupKeyError, ValidationError } from '../../kernel/errors.js'
import { getAtPath, setAtPathInPlace } from '../../kernel/paths.js'
import type { MaterializedBacking } from './registry.js'

/**
 * Config a collection's lookup declarations resolve to — the binding's
 * construction input. `lookupLabelResolver`/`getLookupBacking`/`membership`/
 * `snapshotFor` are vault-built closures (never a `Collection` handle,
 * keyring, or DEK/CEK — the zero-knowledge boundary); `membership` (Task 3)
 * and `snapshotFor` (Task 6) are undefined in this task.
 */
export interface LookupViaConfig {
  readonly lookupFields: Record<string, LookupDescriptor>
  readonly lookupLabelResolver?: (dimension: string, key: string, locale: string, fallback?: unknown) => Promise<string | undefined>
  /** `dimension -> ((key) => backing row | undefined)` — the matrix (collection) tier's present-time source. */
  readonly getLookupBacking?: (dimension: string) => ((key: string) => Promise<Record<string, unknown> | undefined>) | undefined
  /** Closed-vocabulary write-time membership test (#650 Task 3) — `(field, key) => known?`. */
  readonly membership?: (field: string, key: string) => boolean | Promise<boolean>
  /** Sync per-descriptor altKey index — `ingest`'s normalization source (#650 Task 3). */
  readonly getAltIndex?: (desc: LookupDescriptor) => MaterializedBacking | undefined
  readonly snapshotFor?: (dimension: string) => ReadonlyMap<string, Record<string, unknown>> | undefined
  readonly collectionName: string
}

/** Enum tier (`backing:'static'`, no `table`) has no label source at all — never dressed. */
function hasLabelSource(desc: LookupDescriptor): boolean {
  return !(desc.backing === 'static' && desc.table === undefined)
}

/**
 * Resolve one key's label. `'static'`/`'reserved'` both go through
 * `cfg.lookupLabelResolver` (mirrors `dictLabelResolver`'s own static-table-
 * first-else-reserved-handle branching — the SAME closure is reused, see
 * `kernel/vault.ts`). `'collection'` (matrix tier) reads the declared
 * `present.label` off the backing row via `cfg.getLookupBacking`; when
 * `present.by` is set, that field's value is a `{ locale -> label }` map
 * indexed by the effective locale.
 */
async function fetchLookupLabel(
  desc: LookupDescriptor,
  key: string,
  effLocale: string,
  fieldFallback: string | readonly string[] | undefined,
  cfg: LookupViaConfig,
): Promise<string | undefined> {
  if (desc.backing === 'collection') {
    const getRow = cfg.getLookupBacking?.(desc.dimension)
    const row = getRow ? await getRow(key) : undefined
    const labelField = desc.present?.label
    if (!row || labelField === undefined) return undefined
    const raw = row[labelField]
    if (desc.present?.by !== undefined) {
      return raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[effLocale] as string | undefined : undefined
    }
    return typeof raw === 'string' ? raw : undefined
  }
  return cfg.lookupLabelResolver?.(desc.dimension, key, effLocale, fieldFallback)
}

/** `present` — resolve `<field>Label` for every declared lookup field. Adapted from `via-i18n/binding.ts:253-337`. */
async function runLookupPresent(
  record: Record<string, unknown>,
  ctx: ViaReadCtx,
  cfg: LookupViaConfig,
): Promise<Record<string, unknown>> {
  const fields = Object.entries(cfg.lookupFields).filter(([, d]) => hasLabelSource(d))
  if (fields.length === 0) return record

  const locale = typeof ctx.locale === 'string' ? ctx.locale : undefined
  const fallback = ctx.fallback as string | readonly string[] | undefined
  const layer = ctx.layer as Layer

  // `{ locale: 'raw' }` wants the untouched record — mirrors
  // `via-i18n/binding.ts`'s `locale !== 'raw'` dict-label gate exactly (no
  // synthetic `<field>Label` derivative on a raw read).
  if (locale === 'raw') return record

  // Static-display hybrid hinge: a `backing:'static'` field with a declared
  // `displayLocale` resolves its `<field>Label` even under a locale-less
  // read (mirrors staticDict's `hasStaticDisplay` gate).
  const hasStaticDisplay = fields.some(([, d]) => d.backing === 'static' && d.displayLocale !== undefined)
  if (!locale && !hasStaticDisplay) return record

  let result = record
  const withLabels = { ...result }

  for (const [field, desc] of fields) {
    const policy = desc.onMissing ? resolvePolicy(desc.onMissing, layer) : 'null'
    const fieldFallback = policy === 'substitute' ? (fallback ?? desc.substitute) : fallback
    const effLocale = locale ?? (desc.backing === 'static' ? desc.displayLocale : undefined)

    const resolveKey = async (key: string): Promise<string | null> => {
      if (!effLocale) {
        if (policy === 'throw') {
          throw new LocaleNotSpecifiedError(field, `lookup "${field}": no locale active to resolve key "${key}".`)
        }
        return null
      }
      const label = await fetchLookupLabel(desc, key, effLocale, fieldFallback, cfg)
      if (label === undefined) {
        if (policy === 'throw') {
          throw new LocaleNotSpecifiedError(field, `lookup "${field}": no label for key "${key}" in locale "${effLocale}".`)
        }
        return null
      }
      return label
    }

    if (field.includes('[].')) {
      const parts = field.split('[].')
      const arrayKey = parts[0]!
      const leaf = parts[1]
      if (!leaf || leaf.includes('.')) continue
      const arr = (withLabels as Record<string, unknown>)[arrayKey]
      if (!Array.isArray(arr)) continue
      const labelKey = `${leaf}Label`
      ;(withLabels as Record<string, unknown>)[arrayKey] = await Promise.all(
        arr.map(async (el) => {
          if (!el || typeof el !== 'object' || Array.isArray(el)) return el
          const k = (el as Record<string, unknown>)[leaf]
          if (typeof k !== 'string') return el
          return { ...(el as Record<string, unknown>), [labelKey]: await resolveKey(k) }
        }),
      )
      continue
    }

    const val = result[field]
    if (Array.isArray(val)) {
      withLabels[`${field}Label`] = await Promise.all(
        val.map(async (k) => ({ key: k, label: typeof k === 'string' ? await resolveKey(k) : null })),
      )
    } else if (typeof val === 'string') {
      const label = await resolveKey(val)
      if (label !== null) withLabels[`${field}Label`] = label
    }
  }

  result = withLabels
  return result
}

function buildLookupDescribeFragment(cfg: LookupViaConfig): Record<string, unknown> {
  return { lookupFields: Object.keys(cfg.lookupFields) }
}

/**
 * `cfg.getAltIndex(desc)` (matrix tier) reads the backing collection's cache
 * via `querySourceForJoin()` (`buildLookupAltIndex`, registry.ts) — which
 * throws a `.join()`-branded message when that collection was opened
 * `{prefetch:false}` (lazy mode is unsupported for altKey normalization).
 * Normalization must never silently not happen (the banned silent-no-op
 * class, #650 Task 3 review, Important 2) — detect that specific failure
 * and surface a CLEAR, lookup-branded `ValidationError` at the point of
 * failure instead of letting the confusing join-branded one leak onto an
 * unrelated `put()`. Any OTHER error (e.g. `materializeBackingTable`'s own
 * altKey-collision `ValidationError`) propagates unchanged.
 */
function getAltIndexOrThrow(field: string, desc: LookupDescriptor, cfg: LookupViaConfig): MaterializedBacking | undefined {
  try {
    return cfg.getAltIndex?.(desc)
  } catch (err) {
    if (err instanceof Error && err.message.includes('lazy-mode')) {
      throw new ValidationError(
        `lookup: altKeys on "${field}" require the backing collection "${desc.dimension}" to be ` +
          `prefetch-enabled (lazy mode unsupported); open it without {prefetch:false} or drop altKeys.`,
      )
    }
    throw err
  }
}

/**
 * `ingest` — altKey candidate values normalize to the canonical key (#650
 * Task 3, spec §3). Pure, sync, idempotent (a canonical key maps to
 * itself); no store read — consults the pre-materialized
 * `cfg.getAltIndex(desc)`. The money `canonicalizeIncomingMoney` precedent
 * (`via.ts:108`).
 */
function runLookupIngest(record: Record<string, unknown>, cfg: LookupViaConfig): Record<string, unknown> {
  const withAltKeys = Object.entries(cfg.lookupFields).filter(([, d]) => (d.altKeys?.length ?? 0) > 0)
  if (withAltKeys.length === 0) return record

  let result = record
  for (const [field, desc] of withAltKeys) {
    const backing = getAltIndexOrThrow(field, desc, cfg)
    if (!backing || backing.altIndex.size === 0) continue
    const values = getAtPath(record, field)
    // Multi-value fields ([].-wildcard/array-typed paths — `getAtPath`
    // returns >1 entries) bail out of normalization here (follow-up
    // flagged, #650 Task 3 review; no behavior change this wave).
    // `runLookupEnforceWrite` below has no such bail, so a closed-vocabulary
    // array field can see an un-normalized altKey value refused even though
    // the candidate is a legitimate, just-not-yet-canonicalized altKey.
    if (values.length !== 1) continue
    const value = values[0]
    if (typeof value !== 'string') continue
    const canonical = backing.altIndex.get(value)
    if (canonical === undefined || canonical === value) continue
    if (result === record) result = { ...record }
    setAtPathInPlace(result, field, canonical)
  }
  return result
}

/**
 * `enforceWrite` — closed-vocabulary write refusal (#650 Task 3, spec §3).
 * Runs only for `vocabulary:'closed'` fields; `'open'` (the dictKey/dict
 * default) skips the check entirely, so #649's fix is additive — existing
 * dictKey/staticDict collections are unaffected. `ctx` carries no
 * cross-collection door (`id`/`vault`/`prior`/`emit` only, unchanged) —
 * membership is a vault-built closure on `cfg`, per spec.
 */
async function runLookupEnforceWrite(record: Record<string, unknown>, cfg: LookupViaConfig): Promise<void> {
  for (const [field, desc] of Object.entries(cfg.lookupFields)) {
    if (desc.vocabulary !== 'closed') continue
    // Unlike `runLookupIngest` (which bails on multi-value fields), this
    // checks every value `getAtPath` returns — including array elements
    // ingest never got a chance to normalize. See the asymmetry note at
    // `runLookupIngest`'s bail-out (#650 Task 3 review; no behavior change
    // this wave).
    for (const value of getAtPath(record, field)) {
      if (typeof value !== 'string') continue
      const known = cfg.membership ? await cfg.membership(field, value) : true
      if (!known) throw new UnknownLookupKeyError(desc.dimension, field, value)
    }
  }
}

export function lookupBinding(cfg: LookupViaConfig): ViaBinding {
  return {
    brand: 'lookup',
    posture: { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: false },
    reservedPrefixes: ['_dict_', '_lookup_'],
    covers: (field) => field in cfg.lookupFields,
    ingest: (record) => runLookupIngest(record, cfg),
    enforceWrite: (record) => runLookupEnforceWrite(record, cfg),
    present: async (record, ctx) => runLookupPresent(record, ctx, cfg),
    describeFragment: () => buildLookupDescribeFragment(cfg),
  }
}

export function linkLookupVia(): void {
  installViaBinder('lookup', (c) => lookupBinding(c as LookupViaConfig))
}
