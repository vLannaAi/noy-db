import type { ViaBinding, ViaWriteCtx, ViaReadCtx } from './via.js'

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

  /** True iff any binding implements decodeResults (query fast-path gating). */
  get hasResultDecode(): boolean {
    return this.bindings.some((b) => b.decodeResults !== undefined)
  }
}
