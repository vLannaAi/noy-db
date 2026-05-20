import { OverlayIdMismatchError } from '../errors.js'
import type { Collection } from '../collection.js'
import type { OverlayedViewStrategy } from './types.js'

/**
 * Virtual-collection proxy returned by `vault.collection(overlayName)`
 * when `overlayName` is a registered `withOverlayedView` (#154).
 *
 * Implements the core `Collection<T>`-shaped read/write surface with
 * merge-on-read semantics:
 *   - `get(id)`: overlay row wins iff `overlay[shadowField] === shadowValue`
 *   - `list()` / `.query()`: union of ids, per-id merge applied
 *   - `put(record)` / `put(id, record)`: routes to overlay; id derived
 *     via the base MV's `rowKey` (validated on the two-arg form)
 *   - `delete(id)`: removes the overlay row only; base stays
 *
 * Reactive APIs (`live`, `subscribe`, `query().live()`) are out of
 * scope for #154 and surface as "not yet implemented" — wired in a
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
    if (overlayRow !== null && this.shadowPredicateApplies(overlayRow)) {
      return overlayRow
    }
    const baseRow = await this.baseCollection.get(id)
    if (baseRow !== null) return baseRow
    // No base row — but if an overlay row exists with the shadow
    // predicate true, we returned it above. If overlay exists but
    // predicate is false, return null (overlay exists but doesn't
    // qualify, and there's no base to fall back to) — per spec
    // operations table row "overlay exists, predicate false, no base".
    return null
  }

  /** List union of base + overlay ids, applying the merge per row. */
  async list(): Promise<T[]> {
    const baseRows = await this.baseCollection.list()
    const overlayRows = await this.overlayCollection.list()
    // Build id → merged row, base-first then overlay applies shadow rule.
    const merged = new Map<string, T>()
    const idOf = (row: T): string => {
      // Best-effort: use baseRowKey if available, else assume the row
      // has a `.id` field (common pattern). The spec requires every
      // base MV to declare `rowKey`, so the first branch is the
      // canonical path.
      if (this.baseRowKey) return this.baseRowKey(row as Record<string, unknown>)
      const idField = (row as Record<string, unknown>).id
      return typeof idField === 'string' ? idField : ''
    }
    for (const row of baseRows) {
      const id = idOf(row)
      if (id) merged.set(id, row)
    }
    for (const row of overlayRows) {
      const id = idOf(row)
      if (!id) continue
      if (this.shadowPredicateApplies(row)) {
        merged.set(id, row) // overlay shadow wins
      } else if (!merged.has(id)) {
        // Overlay-only + predicate false + no base → don't surface
        // (matches spec operations table)
        continue
      }
      // else: overlay exists but predicate is false and base is
      // present → keep the base row already in `merged`
    }
    return [...merged.values()]
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

  /** True when `overlay[shadowField] === shadowValue`. */
  private shadowPredicateApplies(row: T): boolean {
    return (row as Record<string, unknown>)[this.spec.shadowField] === this.spec.shadowValue
  }
}
