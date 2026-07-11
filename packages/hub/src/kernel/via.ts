// kernel/via.ts — the ONLY kernel-resident via surface.
import { NoydbError } from './errors.js'
import type { EncryptedEnvelope } from './types.js'

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
  /** Owning vault name (event payload identity — e.g. i18n:script-violation). */
  readonly vault: string
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

/** One sealed slot's ciphertext — matches the existing `iv:data` sealed map entries (seam map §2 step 2). */
export interface SealedSlotRef { readonly iv: string; readonly data: string }

/**
 * A scoped crypto capability handed to a `via` feature's `encodeAtRest`/
 * `decodeAtRest`/`erase` hooks — never the keyring, never the enclave.
 * `sealedSlots` is pre-bound to one `(collection, recordId)`; `reservedEnvelopes`
 * is a whole-envelope encrypt/decrypt door scoped to collection names under a
 * declared prefix (e.g. `_dict_`).
 */
export interface ViaCryptoCtx {
  readonly sealedSlots: {
    seal(field: string, plaintext: unknown): Promise<SealedSlotRef>
    unseal(field: string, ref: SealedSlotRef): Promise<unknown>
    delete(field: string): Promise<void>
  }
  reservedEnvelopes(prefix: string): {
    encrypt(collection: string, json: string, v: number): Promise<EncryptedEnvelope>
    decrypt(collection: string, env: EncryptedEnvelope): Promise<string>
  }
}

/** Per-call erase context — `forget()`'s per-ref participation door (phase C). */
export interface ViaEraseCtx { readonly id: string; readonly vault: string; readonly live: unknown /* EncryptedEnvelope */; readonly crypto: ViaCryptoCtx }
/** What an `erase` hook reports back to `forget()`'s summary ledger entry. */
export interface ViaEraseReport { readonly shredded: number; readonly residue: readonly unknown[] }

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
  /** Collection-name prefixes this binding's `reservedEnvelopes` capability may address (e.g. `_dict_`). */
  readonly reservedPrefixes?: readonly string[]
  /**
   * Does this binding own `field`? Backs `ViaPipeline.postureFor` (#629 Task
   * 8's posture consumer) — a passive coverage check, independent of
   * `buildClause`/`compareForOrder` (which some bindings, e.g. classified and
   * blob, never define). SYNC, no side effects.
   *
   * Contract (documentation only — not enforced at runtime, future work):
   * any binding declaring a non-default posture value — `queryable: 'none'`
   * (#629 Task 8) or `exportable: false` (#629 Task 9's `redactForExport`)
   * — MUST implement `covers()`. `postureFor`'s consumers only engage for
   * fields a binding actively claims via `covers()`; a binding that omits
   * it would silently fall through to the generic (unrefused/unredacted)
   * path instead.
   */
  covers?(field: string): boolean
  // NOTE: phase C adds a `derive` hook ADDITIVELY — do not stub it now.
  // ── write pipeline ──
  /** Refuse a write before crypto runs (classified step-3 slot: storage:'never' rejection + validators). Throws to refuse. */
  enforceWrite?(record: Record<string, unknown>, ctx: ViaWriteCtx): void | Promise<void>
  /** First pipeline stage (money canonicalizeIncomingMoney). SYNC. */
  ingest?(record: Record<string, unknown>): Record<string, unknown>
  /** Decode STORED form to canonical for internal boundaries (gates, derivations, patch bases). SYNC. */
  canonicalizeStored?(record: Record<string, unknown>): Record<string, unknown>
  /** Post-validation write encoding (money quantize; i18n translate→script→validate→densify). May be async. */
  encodeWrite?(record: Record<string, unknown>, ctx: ViaWriteCtx): Awaitable<Record<string, unknown>>
  /** Final write-pipeline stage: seal/encrypt declared fields via `crypto` before the envelope body is built (classified step-2 slot). */
  encodeAtRest?(record: Record<string, unknown>, crypto: ViaCryptoCtx): Promise<{ record: Record<string, unknown>; sealed?: Record<string, SealedSlotRef> }>
  // ── read pipeline ──
  /** First read-pipeline stage: unseal/decrypt declared fields via `crypto` before `present` runs (classified sealed-handle slot). */
  decodeAtRest?(record: Record<string, unknown>, sealed: Record<string, SealedSlotRef>, crypto: ViaCryptoCtx, opts: { asHandles: boolean }): Promise<Record<string, unknown>>
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
  // ── forget participation ──
  /** `forget()`'s per-ref erasure door — shred/report this binding's residue for one record (classified/blob forget participation). */
  erase?(ctx: ViaEraseCtx): Promise<ViaEraseReport>
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

/** @internal — registry presence check. Used by tests (mirrors isMoneyEngineInstalled) and by vault's i18n validator delegators as a no-i18n-ever-declared fast path. */
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
