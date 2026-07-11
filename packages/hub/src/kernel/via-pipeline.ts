import type { ViaBinding, ViaPosture, ViaWriteCtx, ViaReadCtx, ViaCryptoCtx, SealedSlotRef, ViaEraseCtx, ViaEraseReport } from './via.js'
import { ValidationError, FieldNotQueryableError } from './errors.js'

/** Opaque per-clause query payload carried on FieldClause (replaces the money-only slot). */
export interface ViaClause {
  readonly brand: string
  readonly payload: unknown
}

export class ViaPipeline {
  private constructor(readonly bindings: readonly ViaBinding[]) {}

  /** undefined for an empty list — the zero-via fast path is `this.via === undefined`. */
  static build(bindings: readonly ViaBinding[]): ViaPipeline | undefined {
    return bindings.length === 0 ? undefined : new ViaPipeline(bindings)
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
    for (const b of this.bindings) if (b.present) r = await b.present(r, ctx)
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

  /**
   * Which posture governs `field`, if any binding covers it — `undefined`
   * means no binding declares `field` (the generic, non-via query path
   * applies). #629 Task 8's posture consumer: `.where()`/`.orderBy()`
   * consult this before building/evaluating a clause, refusing fields whose
   * posture is `queryable: 'none'` (e.g. blob); every other posture
   * ('det-exact'/'ordered'/'full') is left to the existing per-binding
   * buildClause/evaluateClause/compareForOrder machinery, unchanged.
   */
  postureFor(field: string): ViaPosture | undefined {
    for (const b of this.bindings) {
      if (b.covers?.(field)) return b.posture
    }
    return undefined
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

  /** `forget()`'s per-ref erasure door: runs every binding's `erase`, concatenating shredded counts and residue. */
  async erase(ctx: ViaEraseCtx): Promise<ViaEraseReport> {
    let shredded = 0
    const residue: unknown[] = []
    for (const b of this.bindings) {
      if (!b.erase) continue
      const report = await b.erase(ctx)
      shredded += report.shredded
      residue.push(...report.residue)
    }
    return { shredded, residue }
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
}
