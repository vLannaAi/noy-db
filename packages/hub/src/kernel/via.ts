// kernel/via.ts — the ONLY kernel-resident via surface.
import { NoydbError } from './errors.js'

/** Awaitable type for potentially async results. */
type Awaitable<T> = T | Promise<T>

/** Declared security posture — a property the kernel enforces (enforcement activates in phases B/C). */
export interface ViaPosture {
  readonly encryptedAtRest: 'envelope' | 'sealed'
  readonly queryable: 'none' | 'det-exact' | 'ordered' | 'full'
  readonly exportable: boolean
  readonly forgettable: boolean
}

/** Opaque marker every feature descriptor extends; the kernel never sees concrete descriptor types. */
export interface ViaDescriptor { readonly _viaBrand: string }

/** Per-call write context (A: minimal; B/C extend). */
export interface ViaWriteCtx {
  readonly id: string
  /** Prior stored record (decoded), lazily resolved. Null when creating. */
  readonly prior: () => Promise<Record<string, unknown> | null>
  /** Typed event emission (e.g. i18n:script-violation). */
  readonly emit: (event: string, payload: unknown) => void
}

/** Per-call read context — mirrors LocaleReadOptions loosely; features narrow. */
export interface ViaReadCtx {
  readonly locale?: unknown
  readonly fallback?: unknown
  readonly layer: string
}

/**
 * A feature bound to one collection's declared config. Record-grain hooks —
 * every hook receives the whole record (matches the real engine signatures,
 * e.g. quantizeMoneyFields(record, moneyFields)). All hooks optional;
 * absent = passthrough. Query-participation hooks are SYNC (#553).
 */
export interface ViaBinding {
  readonly brand: string
  readonly posture: ViaPosture
  /** Declared dependencies (field paths / cross-record specs). MANDATORY for any future
   *  derive-bearing binding (phase C consumes; A only validates well-formedness: strings, non-empty). */
  readonly deps?: readonly string[]
  // NOTE: phases B/C add `encodeAtRest`/`decodeAtRest`/`erase`/`derive` hooks ADDITIVELY — do not stub them now.
  // ── write pipeline ──
  /** First pipeline stage (money canonicalizeIncomingMoney). SYNC. */
  ingest?(record: Record<string, unknown>): Record<string, unknown>
  /** Decode STORED form to canonical for internal boundaries (gates, derivations, patch bases). SYNC. */
  canonicalizeStored?(record: Record<string, unknown>): Record<string, unknown>
  /** Post-validation write encoding (money quantize; i18n translate→script→validate→densify). May be async. */
  encodeWrite?(record: Record<string, unknown>, ctx: ViaWriteCtx): Awaitable<Record<string, unknown>>
  // ── read pipeline ──
  /** Read-time presentation (money decode+virtuals; i18n locale/labels/strip). May be async. */
  present?(record: Record<string, unknown>, ctx: ViaReadCtx): Awaitable<Record<string, unknown>>
  // ── query participation (ALL SYNC — #553) ──
  /** Returns an opaque clause payload when this binding covers `field`, else undefined. */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  buildClause?(field: string, op: string, value: unknown): unknown | undefined
  /** Evaluate a payload produced by buildClause against a raw stored value. */
  evaluateClause?(actual: unknown, op: string, payload: unknown): boolean
  /** Decode a raw stored record for query/scan results and callback views ('raw' — no virtuals). */
  decodeResults?(record: unknown): unknown
  /** Exact ordering for a covered field; undefined when the field is not covered. */
  compareForOrder?(field: string, a: unknown, b: unknown): number | undefined
  /** Rewrite an aggregate spec (money exact reducers). */
  wrapReducers?(spec: unknown): unknown
  // ── introspection ──
  describeFragment?(): Record<string, unknown>
}

/** Binder: constructs a binding from a collection's declared config. Installed by the feature's declaration factory. */
export type ViaBinder = (config: unknown) => ViaBinding

const binders = new Map<string, ViaBinder>()

/** @internal — called (idempotently, first-wins) by a feature's declaration factory, e.g. money(). */
export function installViaBinder(brand: string, binder: ViaBinder): void {
  if (!binders.has(brand)) binders.set(brand, binder)
}

/** @internal — test-only visibility (mirrors isMoneyEngineInstalled). */
export function isViaInstalled(brand: string): boolean {
  return binders.has(brand)
}

/** @internal — resolve a binder; throws when the declaration factory never ran (hand-rolled descriptors). */
export function viaBinder(brand: string): ViaBinder {
  const b = binders.get(brand)
  if (!b) {
    throw new NoydbError(
      'VIA_NOT_LINKED',
      `via feature "${brand}" requires descriptors created via its declaration factory from @noy-db/hub`,
    )
  }
  return b
}
