import { OverlayIdMismatchError } from '../../errors.js'
import type { Collection } from '../../collection.js'
import type { OverlayedViewStrategy } from './types.js'

/**
 * Virtual-collection proxy returned by `vault.collection(overlayName)`
 * when `overlayName` is a registered `withOverlayedView`.
 *
 * Implements the core `Collection<T>`-shaped read/write surface with
 * merge-on-read semantics:
 *   - `get(id)`: overlay row wins iff `overlay[shadowField] === shadowValue`;
 *     when `spec.mergeMode` is set, an intermediate status may instead pull
 *     a declared subset of fields from the overlay over the base (#348)
 *   - `list()` / `.query()`: union of ids, per-id merge applied
 *   - `put(record)` / `put(id, record)`: routes to overlay; id derived
 *     via the base MV's `rowKey` (validated on the two-arg form)
 *   - `delete(id)`: removes the overlay row only; base stays
 *
 * Reactive APIs (`live`, `subscribe`, `query().live()`) are out of
 * scope for this release and surface as "not yet implemented" — wired in a
 * future sub-issue.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class OverlayedCollection<T extends Record<string, unknown> = any> {
  constructor(
    private readonly spec: OverlayedViewStrategy,
    private readonly baseCollection: Collection<T>,
    private readonly overlayCollection: Collection<T>,
    private readonly baseRowKey: ((row: Record<string, unknown>) => string) | undefined,
  ) {}

  /**
   * Convenience accessors for advanced callers that need to bypass the
   * virtual layer (bulk imports, direct overlay queries). Mirrors the
   * spec's "direct writes to the underlying overlay collection skip
   * the validation" escape hatch.
   */
  readonly overlay = {
    rowKey: (row: Record<string, unknown>): string => {
      if (!this.baseRowKey) {
        throw new Error(
          `Overlay "${this.spec.name}": base "${this.spec.base}" is not an MV — ` +
            `cannot auto-derive id from the row. Use \`put(id, record)\` instead.`,
        )
      }
      return this.baseRowKey(row)
    },
  }

  /** Get the merged row by id. */
  async get(id: string): Promise<T | null> {
    const overlayRow = await this.overlayCollection.get(id)
    const baseRow = await this.baseCollection.get(id)
    return this.mergeRows(overlayRow, baseRow)
  }

  /** List union of base + overlay ids, applying the merge per row. */
  async list(): Promise<T[]> {
    const baseRows = await this.baseCollection.list()
    const overlayRows = await this.overlayCollection.list()
    const idOf = (row: T): string => {
      // Best-effort: use baseRowKey if available, else assume the row
      // has a `.id` field (common pattern). The spec requires every
      // base MV to declare `rowKey`, so the first branch is the
      // canonical path.
      if (this.baseRowKey) return this.baseRowKey(row as Record<string, unknown>)
      const idField = (row as Record<string, unknown>).id
      return typeof idField === 'string' ? idField : ''
    }
    // Key base + overlay rows by id, then union the id sets and run the
    // same per-id merge `get()` uses. Nulls (overlay-only rows that
    // don't qualify and have no base) are filtered out.
    const baseById = new Map<string, T>()
    const overlayById = new Map<string, T>()
    for (const row of baseRows) {
      const id = idOf(row)
      if (id) baseById.set(id, row)
    }
    for (const row of overlayRows) {
      const id = idOf(row)
      if (id) overlayById.set(id, row)
    }
    const out: T[] = []
    for (const id of new Set([...baseById.keys(), ...overlayById.keys()])) {
      const merged = this.mergeRows(overlayById.get(id) ?? null, baseById.get(id) ?? null)
      if (merged !== null) out.push(merged)
    }
    return out
  }

  /**
   * Write to the overlay. Two forms:
   * - `put(record)`: id is derived via the base MV's `rowKey(record)`.
   *   Throws if the base isn't an MV.
   * - `put(id, record)`: validates `id === rowKey(record)`; throws
   *   `OverlayIdMismatchError` on mismatch.
   */
  async put(idOrRecord: string | T, maybeRecord?: T): Promise<void> {
    let id: string
    let record: T
    if (maybeRecord === undefined) {
      // Single-arg form: put(record). Derive id via base rowKey.
      record = idOrRecord as T
      if (!this.baseRowKey) {
        throw new Error(
          `Overlay "${this.spec.name}".put(record): base "${this.spec.base}" is not an MV. ` +
            `Use put(id, record) explicitly.`,
        )
      }
      id = this.baseRowKey(record as Record<string, unknown>)
    } else {
      // Two-arg form: put(id, record). Validate against rowKey.
      id = idOrRecord as string
      record = maybeRecord
      if (this.baseRowKey) {
        const expected = this.baseRowKey(record as Record<string, unknown>)
        if (id !== expected) {
          throw new OverlayIdMismatchError(id, expected)
        }
      }
    }
    await this.overlayCollection.put(id, record)
  }

  /**
   * Remove the overlay row only. Idempotent (no-op on absent).
   * The base row is untouched — if a base row exists for `id`,
   * subsequent reads return it.
   */
  async delete(id: string): Promise<void> {
    await this.overlayCollection.delete(id)
  }

  /**
   * Merge a single id's overlay + base rows into the visible row.
   *
   * Priority (first match wins):
   *  1. Binary shadow win — overlay present AND
   *     `overlay[shadowField] === shadowValue` → return the overlay row
   *     entirely. This stays FIRST so the original binary behaviour is
   *     unchanged whether or not `mergeMode` is configured.
   *  2. Field-level merge — overlay present, `mergeMode` configured,
   *     and a rule whose `whenStatus` equals `overlay[shadowField]`.
   *     The matched rule pulls its `overlayFields` (those present on
   *     the overlay row) on top of the base row. With no base row, the
   *     overlay row is returned as-is.
   *  3. Fallback — return the base row (possibly `null`). An
   *     overlay-only row that qualifies under neither (1) nor (2) and
   *     has no base is therefore NOT surfaced.
   */
  private mergeRows(overlayRow: T | null, baseRow: T | null): T | null {
    const shadowField = this.spec.shadowField
    if (
      overlayRow !== null &&
      (overlayRow as Record<string, unknown>)[shadowField] === this.spec.shadowValue
    ) {
      return overlayRow
    }
    if (overlayRow !== null && this.spec.mergeMode) {
      const status = (overlayRow as Record<string, unknown>)[shadowField]
      const rule = this.spec.mergeMode.rules.find((r) => r.whenStatus === status)
      if (rule) {
        if (baseRow === null) return overlayRow
        const overlaySrc = overlayRow as Record<string, unknown>
        const picked: Record<string, unknown> = {}
        for (const field of rule.overlayFields) {
          if (field in overlaySrc) picked[field] = overlaySrc[field]
        }
        return { ...(baseRow as Record<string, unknown>), ...picked } as T
      }
    }
    return baseRow
  }

  // ─── Throw-stubs for the unimplemented Collection<T> surface ───────
  //
  // `Vault.collection(name)` widens the return type to `Collection<T>`
  // for the overlay intercept, but `OverlayedCollection` doesn't
  // implement the full surface. These stubs catch the common
  // reactive / chainable APIs with a clear "not yet implemented"
  // error pointing at the relevant issue — so consumers don't hit a
  // cryptic `undefined is not a function` runtime crash.
  //
  // Throw-stubs so consumers get actionable errors rather than cryptic crashes.

  /** @throws — chainable Query<T> over a virtual collection is deferred. */
  query(): never {
    throw new Error(
      `OverlayedCollection "${this.spec.name}".query() is not yet implemented for overlay views (#154). ` +
        `Use \`list()\` + filter for now, or read from the underlying \`${this.spec.base}\` / \`${this.spec.overlay}\` collections directly. ` +
        `Reactive APIs land in a future MV sub-issue.`,
    )
  }

  /** @throws — change-stream subscription over a virtual collection is deferred. */
  subscribe(): never {
    throw new Error(
      `OverlayedCollection "${this.spec.name}".subscribe() is not yet implemented for overlay views (#154). ` +
        `Subscribe to the underlying \`${this.spec.base}\` / \`${this.spec.overlay}\` collections individually for now. ` +
        `Merged change-stream lands in a future MV sub-issue.`,
    )
  }

  /** @throws — live query over a virtual collection is deferred. */
  live(): never {
    throw new Error(
      `OverlayedCollection "${this.spec.name}".live() is not yet implemented for overlay views (#154). ` +
        `Reactive APIs land in a future MV sub-issue.`,
    )
  }

  /** @throws — async iteration over a virtual collection is deferred. */
  scan(): never {
    throw new Error(
      `OverlayedCollection "${this.spec.name}".scan() is not yet implemented for overlay views (#154). ` +
        `Use \`list()\` for now (no row-count ceiling at niwat scale), or scan the underlying collections directly.`,
    )
  }

  /** @throws — lazy-mode query is not applicable to virtual collections. */
  lazyQuery(): never {
    throw new Error(
      `OverlayedCollection "${this.spec.name}".lazyQuery() is not supported. ` +
        `Virtual collections always materialize through base + overlay reads — lazy-mode indexed lookups don't apply.`,
    )
  }

  /** @throws — bulk-atomic put is deferred to a future MV sub-issue. */
  putManyAtomic(): never {
    throw new Error(
      `OverlayedCollection "${this.spec.name}".putManyAtomic() is not yet implemented for overlay views (#154). ` +
        `Use sequential \`.put(record)\` calls for now, or write to \`${this.spec.overlay}\` directly.`,
    )
  }

  /** @throws — bulk delete is deferred to a future MV sub-issue. */
  deleteMany(): never {
    throw new Error(
      `OverlayedCollection "${this.spec.name}".deleteMany() is not yet implemented for overlay views (#154). ` +
        `Use sequential \`.delete(id)\` calls for now, or operate on \`${this.spec.overlay}\` directly.`,
    )
  }

  /** @throws — `.first()` over a virtual collection is deferred. */
  first(): never {
    throw new Error(
      `OverlayedCollection "${this.spec.name}".first() is not yet implemented for overlay views (#154). ` +
        `Use \`(await list())[0]\` for now.`,
    )
  }

  /** @throws — `.count()` over a virtual collection is deferred. */
  count(): never {
    throw new Error(
      `OverlayedCollection "${this.spec.name}".count() is not yet implemented for overlay views (#154). ` +
        `Use \`(await list()).length\` for now.`,
    )
  }
}
