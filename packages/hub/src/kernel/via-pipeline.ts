import type { ViaBinding, ViaPosture, ViaWriteCtx, ViaReadCtx, ViaCryptoCtx, SealedSlotRef, ViaEraseCtx, ViaEraseReport } from './via.js'
import { ValidationError, FieldNotQueryableError } from './errors.js'

/** Opaque per-clause query payload carried on FieldClause (replaces the money-only slot). */
export interface ViaClause {
  readonly brand: string
  readonly payload: unknown
}

/**
 * The graph-computed taint overlay (#638 Task 3) — `postureFor`'s
 * assignment→enforcement bridge. `postures`/`sealFields` are the
 * enforcement-facing shapes `via-taint-binding.ts#buildTaintOverlay`
 * produces from `ViaGraph.taintedPostures`/`taintSealedFields`;
 * `provenance` (optional — introspection only, never consulted by
 * `postureFor`) is `ViaGraph.taintProvenance`'s output, surfaced by
 * `describe()`.
 */
export interface ViaTaintOverlay {
  readonly postures: ReadonlyMap<string, ViaPosture>
  readonly sealFields: ReadonlySet<string>
  readonly provenance?: ReadonlyMap<string, readonly string[]>
  /** #642 — the whole-record floor for a derivation/MV/overlay OUTPUT collection (the '*' target's
   *  folded, clamped effective posture). postureFor falls back to it for ANY field; redactForExport
   *  picks it up per-field; a sealed default drives taintBinding's sealAllFields mode. O(1) read. */
  readonly defaultPosture?: ViaPosture
}

export class ViaPipeline {
  /**
   * Present-phase-ONLY order (#665, corrected under #665 review) — a stable
   * THREE-WAY partition of `bindings` computed once here at construction:
   * every `'money'`-brand binding first (existing relative order), then
   * every `'computed'`-brand binding (existing relative order), then
   * everything else (existing relative order). `present()` folds over this
   * instead of `bindings` so a `mode: 'virtual'` computed field's value
   * exists before i18n/lookup's dressing `present()` hooks run on it
   * (today's `compileViaBindings` order is money→i18n→lookup→classified→
   * blob→computed, `collection-config.ts:643`, so dressing unconditionally
   * ran BEFORE the value it dresses existed). EVERY other phase (`ingest`/
   * `encodeWrite`/`encodeAtRest`/`enforceWrite`/etc.) keeps folding over
   * `bindings` unchanged — those write/query phases need money-first
   * (`_applyMoneyFields` PREPENDS money, `_applyClassifiedFields` APPENDS
   * classified to preserve it, `kernel/collection.ts:1275-1284,1364-1368`).
   *
   * Money is deliberately carved OUT of the generic "everything else" slice
   * and kept FIRST — the original two-way `[computed..., rest...]` partition
   * regressed money's composed-field behavior from a benign missing-dressing
   * gap into VALUE CORRUPTION: money's `present()` DECODES its input as a
   * STORED SCALED-INT (and derives `<field>Formatted` from it) — it is not a
   * pure dressing CONSUMER like i18n/lookup, which only ADD a `<field>Label`
   * key and never rewrite the field's own value. Running money AFTER
   * computed on a field composing `computed(virtual)` + `money(...)` on
   * ITSELF means money's decode sees the virtual field's raw MAJOR-unit
   * output (e.g. `21`) and misreads it as a scaled-int, producing a
   * corrupted value (`'0.21'`) instead of the pre-#665 result (the raw `21`
   * surviving untouched, with no `Formatted` key added — a benign
   * missing-dressing gap, not a wrong value). Money-first restores money's
   * exact pre-#665 present position — byte-identical money behavior; the
   * materialized composition pins from the #631 work and the money suites
   * all ran under money-first. i18n/lookup are genuine dressing consumers
   * (they only ADD, never rewrite), so they stay after computed, which is
   * the fix #665 intended. A `'taint'` binding (appended LAST by
   * `via-graph-wiring.ts#applyTaintOverlay`) stays last here too (it's
   * neither money nor computed, so it lands at the tail of the "everything
   * else" slice), preserving its "runs after computed, redacts tainted
   * virtual output" contract (`via-taint-binding.ts`'s `taintBinding` doc
   * comment).
   *
   * Money-dressing a virtual computed field's OWN output (the composed
   * `computed(virtual) + money` case) remains a KNOWN LIMITATION —
   * reordering alone cannot fix it; money would need to quantize/reinterpret
   * a major-unit value as a stored scaled-int, a value-shape decision left
   * for a filed follow-up, not resolved by this partition.
   */
  private readonly _presentOrder: readonly ViaBinding[]

  private constructor(readonly bindings: readonly ViaBinding[], readonly taint?: ViaTaintOverlay) {
    this._presentOrder = [
      ...bindings.filter((b) => b.brand === 'money'),
      ...bindings.filter((b) => b.brand === 'computed'),
      ...bindings.filter((b) => b.brand !== 'money' && b.brand !== 'computed'),
    ]
  }

  /** undefined when there is nothing to enforce — the zero-via fast path is
   *  `this.via === undefined` (#553: keeps an all-plain collection sync). A
   *  `'*'`-defaulted output collection (#642) counts as "something to enforce"
   *  even with zero field-specific postures and zero bindings. */
  static build(bindings: readonly ViaBinding[], taint?: ViaTaintOverlay): ViaPipeline | undefined {
    if (bindings.length === 0 && (!taint || (taint.postures.size === 0 && taint.defaultPosture === undefined))) return undefined
    return new ViaPipeline(bindings, taint)
  }

  /** Refuse a write before crypto runs: awaits each binding's `enforceWrite` in order — first throw wins. */
  async enforceWrite(record: Record<string, unknown>, ctx: ViaWriteCtx): Promise<void> {
    for (const b of this.bindings) if (b.enforceWrite) await b.enforceWrite(record, ctx)
  }

  ingest(record: Record<string, unknown>): Record<string, unknown> {
    let r = record
    for (const b of this.bindings) if (b.ingest) r = b.ingest(r)
    return r
  }

  canonicalizeStored(record: Record<string, unknown>): Record<string, unknown> {
    let r = record
    for (const b of this.bindings) if (b.canonicalizeStored) r = b.canonicalizeStored(r)
    return r
  }

  async encodeWrite(record: Record<string, unknown>, ctx: ViaWriteCtx): Promise<Record<string, unknown>> {
    let r = record
    for (const b of this.bindings) if (b.encodeWrite) r = await b.encodeWrite(r, ctx)
    return r
  }

  /**
   * Final write-pipeline stage: folds each binding's `encodeAtRest` in
   * order, threading the record and accumulating the sealed-slot map. A
   * field belongs to exactly one via feature — two bindings sealing the
   * same field is a brand-keyed collision and throws.
   */
  async encodeAtRest(
    record: Record<string, unknown>,
    crypto: ViaCryptoCtx,
  ): Promise<{ record: Record<string, unknown>; sealed?: Record<string, SealedSlotRef> }> {
    let r = record
    let sealed: Record<string, SealedSlotRef> | undefined
    const sealedBy = new Map<string, string>()
    for (const b of this.bindings) {
      if (!b.encodeAtRest) continue
      const result = await b.encodeAtRest(r, crypto)
      r = result.record
      if (!result.sealed) continue
      for (const [field, ref] of Object.entries(result.sealed)) {
        const priorBrand = sealedBy.get(field)
        if (priorBrand !== undefined) {
          throw new ValidationError(
            `via encodeAtRest: field "${field}" sealed by binding "${priorBrand}" is also sealed by binding "${b.brand}"`,
          )
        }
        sealedBy.set(field, b.brand)
        sealed ??= {}
        sealed[field] = ref
      }
    }
    return sealed ? { record: r, sealed } : { record: r }
  }

  /** First read-pipeline stage: folds each binding's `decodeAtRest` in order. */
  async decodeAtRest(
    record: Record<string, unknown>,
    sealed: Record<string, SealedSlotRef>,
    crypto: ViaCryptoCtx,
    opts: { asHandles: boolean },
  ): Promise<Record<string, unknown>> {
    let r = record
    for (const b of this.bindings) if (b.decodeAtRest) r = await b.decodeAtRest(r, sealed, crypto, opts)
    return r
  }

  async present(record: Record<string, unknown>, ctx: ViaReadCtx): Promise<Record<string, unknown>> {
    let r = record
    for (const b of this._presentOrder) if (b.present) r = await b.present(r, ctx)
    return r
  }

  buildClause(field: string, op: string, value: unknown): ViaClause | undefined {
    for (const b of this.bindings) {
      const payload = b.buildClause?.(field, op, value)
      if (payload !== undefined) return { brand: b.brand, payload }
    }
    return undefined
  }

  evaluateClause(clause: ViaClause, actual: unknown, op: string): boolean {
    const b = this.bindings.find((x) => x.brand === clause.brand)
    // buildClause and evaluateClause are produced/consumed by the same binding by construction.
    return b?.evaluateClause ? b.evaluateClause(actual, op, clause.payload) : false
  }

  decodeResults(record: unknown): unknown {
    let r = record
    for (const b of this.bindings) if (b.decodeResults) r = b.decodeResults(r)
    return r
  }

  /** undefined = no binding covers the field → caller falls back to generic compare. */
  compareForOrder(field: string, a: unknown, b: unknown): number | undefined {
    for (const bind of this.bindings) {
      const c = bind.compareForOrder?.(field, a, b)
      if (c !== undefined) return c
    }
    return undefined
  }

  /** undefined = no binding resolves an order-sort label for `key` at `field`/`locale` (#650 Task 7 —
   *  the `orderBy(..., {by:'label'})` per-call-locale channel `compareForOrder` above can't serve). */
  resolveOrderLabel(field: string, key: string, locale: string | undefined): string | undefined {
    for (const bind of this.bindings) {
      const label = bind.resolveOrderLabel?.(field, key, locale)
      if (label !== undefined) return label
    }
    return undefined
  }

  /**
   * Which posture governs `field`, if any binding covers it — `undefined`
   * means no binding declares `field` (the generic, non-via query path
   * applies). #629 Task 8's posture consumer: `.where()`/`.orderBy()`
   * consult this before building/evaluating a clause, refusing fields whose
   * posture is `queryable: 'none'` (e.g. blob); every other posture
   * ('det-exact'/'ordered'/'full') is left to the existing per-binding
   * buildClause/evaluateClause/compareForOrder machinery, unchanged.
   *
   * #638 Task 3: the graph-computed taint overlay is consulted FIRST — a
   * derived field's assigned (most-restrictive-of-sources) posture wins over
   * whatever a binding would otherwise report for that field name (no
   * binding covers a computed/derived field today, so this never actually
   * shadows one — see `via-taint-binding.ts`'s `taintBinding.covers`, which
   * only claims the sealed subset for `encodeAtRest`/`decodeAtRest`, not for
   * this lookup).
   */
  postureFor(field: string): ViaPosture | undefined {
    const t = this.taint?.postures.get(field)
    if (t) return t
    for (const b of this.bindings) {
      if (b.covers?.(field)) return b.posture
    }
    // #642 — a '*'-defaulted output collection's whole-record floor: O(1) read,
    // no fold (the fold ran once at applyTaintOverlay/reapply time).
    return this.taint?.defaultPosture
  }

  /**
   * Refuse any field-based reducer over a `queryable: 'none'` field (blob) —
   * metadata-only: walks each reducer's `.field` and checks posture, no
   * rewriting. Reducers with no `.field` (e.g. `count()`) are skipped.
   *
   * Shared by `wrapReducers` below (which ALSO applies each binding's
   * rewrite, e.g. money's exact-BigInt reducer swap) and by
   * `ScanBuilder.aggregate()` (#629 Task 8 review fix wave 1), which must
   * call THIS, not `wrapReducers` — wiring full `wrapReducers` into
   * `ScanBuilder.aggregate()` would newly activate money/i18n reducer
   * wrapping on a path that has never run it, a parity-breaking behavior
   * change for existing brands.
   */
  refuseUnqueryableReducers<S>(spec: S): void {
    for (const reducer of Object.values(spec as unknown as Record<string, { readonly field?: string }>)) {
      const field = reducer?.field
      if (field !== undefined && this.postureFor(field)?.queryable === 'none') {
        throw new FieldNotQueryableError(field)
      }
    }
  }

  /**
   * Rewrite an aggregate spec (money exact reducers), then refuse any
   * field-based reducer over a `queryable: 'none'` field (blob) — the same
   * posture gate `.where()`/`.orderBy()` apply, extended to `.aggregate()`
   * (both the bare-spec and builder forms funnel through here).
   */
  wrapReducers<S>(spec: S): S {
    this.refuseUnqueryableReducers(spec)
    let s: unknown = spec
    for (const b of this.bindings) if (b.wrapReducers) s = b.wrapReducers(s)
    return s as S
  }

  /**
   * Deliberate export-layer redaction (#629 Task 9's posture consumer):
   * for every OWN field the decoded record carries, if the covering
   * binding's posture declares `exportable: false` (classified today;
   * money/i18n/blob are all `true`), replace the value with
   * {@link EXPORT_REDACTION_MARKER} — the same `'[sealed]'` string
   * `SealedHandle.toJSON()` (`kernel/types.ts`) already emits, so this is
   * byte-parity with today's accidental redaction, now independent of the
   * field's runtime shape. `SealedHandle.toJSON()` stays untouched as
   * defense-in-depth: a record read via `collection.get()` and
   * JSON.stringify'd outside `exportStream()` still gets the accident's
   * redaction on its own. Never mutates the input; returns a new object
   * only when a field was actually redacted.
   */
  redactForExport(record: Record<string, unknown>): Record<string, unknown> {
    let out: Record<string, unknown> | undefined
    for (const field of Object.keys(record)) {
      if (this.postureFor(field)?.exportable === false) {
        out ??= { ...record }
        out[field] = EXPORT_REDACTION_MARKER
      }
    }
    return out ?? record
  }

  /**
   * Shared fold over a subset of `this.bindings`: runs each binding's
   * `erase`, concatenating shredded/retainedShared counts and residue.
   * Consults `posture.forgettable` (#629 Task 10) — a binding declaring
   * `forgettable: false` is skipped even if it defines `erase` (none does
   * today; a future non-forgettable binding is supported without a brand check).
   */
  private async foldErase(ctx: ViaEraseCtx, bindings: readonly ViaBinding[]): Promise<ViaEraseReport> {
    let shredded = 0
    let retainedShared = 0
    const residue: unknown[] = []
    for (const b of bindings) {
      if (!b.erase || b.posture.forgettable === false) continue
      const report = await b.erase(ctx)
      shredded += report.shredded
      retainedShared += report.retainedShared ?? 0
      residue.push(...report.residue)
    }
    return retainedShared > 0 ? { shredded, residue, retainedShared } : { shredded, residue }
  }

  /** `forget()`'s per-ref erasure door: folds every binding's `erase`. */
  async erase(ctx: ViaEraseCtx): Promise<ViaEraseReport> {
    return this.foldErase(ctx, this.bindings)
  }

  /**
   * `forget()`'s SEALED-posture-only erase fold (#629 Task 10, `Collection._onViaErase`'s
   * one caller) — classified today; metadata-filtered on
   * `posture.encryptedAtRest`, not brand-checked. `undefined` when no
   * sealed-posture binding is compiled in — `vault.ts` then falls back to
   * its own bare-`sensitive` classification, which no via binding covers.
   */
  async eraseSealed(ctx: ViaEraseCtx): Promise<ViaEraseReport | undefined> {
    const sealed = this.bindings.filter((b) => b.posture.encryptedAtRest === 'sealed')
    return sealed.length === 0 ? undefined : this.foldErase(ctx, sealed)
  }

  /** True iff any binding implements decodeResults (query fast-path gating). */
  get hasResultDecode(): boolean {
    return this.bindings.some((b) => b.decodeResults !== undefined)
  }

  /**
   * True iff any binding declares an at-rest hook (`encodeAtRest`/
   * `decodeAtRest`) — the codec boundary's async-stack gate (#629 Task 3
   * consults this to choose between the hook path and today's inline
   * sealed-slot path; a stack with only sync hooks, e.g. money-only, stays
   * `false`).
   */
  get hasAtRestHooks(): boolean {
    return this.bindings.some((b) => b.encodeAtRest !== undefined || b.decodeAtRest !== undefined)
  }

  /**
   * Fold every binding's `describeFragment()` into one `brand -> fragment`
   * map (#650 Task 7 — the first-ever consumer; `describeFragment` was
   * declared at `via.ts:136` since #623 with zero callers until this task).
   * `undefined` when no compiled binding implements it. Consumed by
   * `Collection.describe()`/`describeAsync()`, threaded to `buildDescription`
   * as `BuildDescriptionInput.viaFragments`.
   */
  describeFragments(): Record<string, Record<string, unknown>> | undefined {
    let out: Record<string, Record<string, unknown>> | undefined
    for (const b of this.bindings) {
      const f = b.describeFragment?.()
      if (f !== undefined) { out ??= {}; out[b.brand] = f }
    }
    return out
  }
}

/**
 * The marker `redactForExport` writes for a non-exportable field —
 * intentionally the same literal `SealedHandle.toJSON()` (`kernel/types.ts`)
 * returns, so the two independent redaction layers (deliberate + accident)
 * produce byte-identical export output. Duplicated, not imported, because
 * `SealedHandle.toJSON()` is untouched by #629 Task 9 (belt-and-braces —
 * `via/export-posture-b.test.ts` asserts both layers agree on this string).
 */
export const EXPORT_REDACTION_MARKER = '[sealed]'

/**
 * Structural shape `exportRedact` needs from a collection: just the typed
 * `_via` accessor `Collection` exposes (`kernel/collection.ts`, #634). A
 * named interface rather than the real `Collection` type, because
 * `collection.ts` imports `ViaPipeline` from this module — importing
 * `Collection` back here would be circular.
 */
interface HasViaPipeline {
  readonly _via: ViaPipeline | undefined
}

/**
 * Widened sibling of {@link HasViaPipeline}: `via-graph-wiring.ts`'s
 * `applyTaintOverlay` (#666) needs to REASSIGN the live pipeline, not just
 * read it — `_setVia` is `Collection`'s typed writer seam (`kernel/
 * collection.ts`, beside `_via`), replacing the earlier untyped `coll as {
 * via; codec: { setVia } }` cast. Exported (unlike `HasViaPipeline`) because
 * its one consumer lives in a different module.
 */
export interface HasWritableViaPipeline extends HasViaPipeline {
  _setVia(pipeline: ViaPipeline | undefined): void
}

/**
 * `vault.ts`'s `exportStream()` reach-in (#629 Task 9): apply the owning
 * collection's export redaction to one decoded record. Typed via {@link
 * HasViaPipeline} against `Collection`'s `_via` accessor (#634) — replaces
 * the earlier untyped any-cast reach-in.
 */
export function exportRedact(coll: HasViaPipeline, record: unknown): unknown {
  if (record === null || typeof record !== 'object') return record
  const via = coll._via
  return via ? via.redactForExport(record as Record<string, unknown>) : record
}
