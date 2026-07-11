import type { ViaBinding, ViaWriteCtx, ViaReadCtx, ViaCryptoCtx, SealedSlotRef, ViaEraseCtx, ViaEraseReport } from './via.js'
import { ValidationError } from './errors.js'

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

  wrapReducers<S>(spec: S): S {
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
