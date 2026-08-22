/**
 * The `as-*` family port — the contract a format implements, and the types
 * hub owns on both sides of it.
 *
 * See `docs/adr/0004-as-format-port.md`. In short: `as-*` is export AND
 * import — data, schema, validation — and both halves were duplicated per
 * package. The import half was the worse of the two:
 *
 *     ImportPolicy      declared SIX times across as-* packages,
 *                       byte-identical, and absent from hub entirely
 *     As<X>ImportPlan   declared per package, byte-identical
 *     VaultDiff         hub-owned — so a plan was HALF hub-owned
 *                       and half copy-pasted
 *
 * Consolidating them here is non-breaking: each package re-exports these
 * instead of redeclaring them, so six independent definitions that nothing
 * compared become one that the compiler enforces.
 *
 * @module
 */

import type { ExportChunk, ExportFormat } from '../../kernel/types.js'
import type { VaultDiff } from '../../with-cargo/vault-diff.js'

/**
 * How an import reconciles with what the collection already holds.
 *
 * Hub-owned as of 0.7. Previously declared independently in `as-csv`,
 * `as-json`, `as-ndjson`, `as-xml`, `as-xlsx` and `as-zip` — six copies of one
 * line, with no mechanism that would have noticed them drifting apart.
 */
export type ImportPolicy = 'merge' | 'replace' | 'insert-only'

/**
 * A planned-but-not-applied import.
 *
 * Read the `plan` to show a diff, then `apply()` to commit it. The two-phase
 * shape is deliberate: an import that writes before the caller has seen what
 * it would change is not reviewable, and every `as-*` package had already
 * converged on this independently — which is the argument for hub owning it
 * rather than each of them re-deriving it.
 */
export interface ImportPlan {
  /** What would change. Safe to render; nothing has been written. */
  readonly plan: VaultDiff
  /** The reconciliation the plan was computed under. */
  readonly policy: ImportPolicy
  /** Commit the plan. */
  apply(): Promise<void>
}

/**
 * What a format produces from bytes: records, per collection.
 *
 * Deliberately NOT a `VaultDiff` — computing the diff needs the vault's
 * current contents, which a format does not have and must not need. The
 * format's job ends at "these are the records the input describes"; hub
 * turns that into a plan.
 */
export interface DecodedChunk {
  readonly collection: string
  readonly records: readonly unknown[]
}

/**
 * A serialization format for vault data — the `as-*` family port.
 *
 * **Pure by construction.** A format receives records and returns bytes, or
 * receives bytes and returns records. It never holds a `Vault`, which is what
 * makes the export gate unskippable rather than merely checked: there is no
 * vault in scope to read past `assertCanExport`.
 *
 * That property is the whole point of the inversion. The conformance kit it
 * replaces could only check implementors who ran it; a format that cannot
 * reach a vault is gated whether its author cooperated or not — including
 * third-party formats this family will never see.
 *
 * Records arrive **already redacted**: hub applies the projection before
 * `encode`, because five packages were each calling
 * `vault.collection(x).describe()` and `applyListProjection` to do it
 * themselves.
 *
 * @typeParam Out - `string` for text formats, `Uint8Array` for binary ones.
 */
export interface NoydbFormat<Out extends string | Uint8Array = string | Uint8Array> {
  /**
   * Stable identifier, e.g. `'csv'`.
   *
   * A format declares its own id rather than being named by hub's
   * `ExportFormat` union, which is closed — under the old shape a new format
   * needed a hub release just to be nameable.
   */
  readonly id: string
  /** File extension without the dot, e.g. `'csv'`. Used by `download`/`write`. */
  readonly extension: string
  /** MIME type, e.g. `'text/csv;charset=utf-8'`. Used by `download`. */
  readonly mimeType: string
  /**
   * The capability tier hub gates this format under. `'plaintext'` for a
   * readable projection; `'bundle'` for encrypted output.
   *
   * Not inferred from anything: `as-noydb` emits an encrypted pod and gates on
   * `'bundle'`, and a format that quietly gated on the wrong tier would be a
   * silent downgrade.
   */
  readonly tier: 'plaintext' | 'bundle'

  /** Records → bytes. Pure. */
  encode(chunks: readonly ExportChunk[]): Out | Promise<Out>

  /**
   * Bytes → records. Pure.
   *
   * Optional on an implementation, not on the contract: `as-sql` is
   * export-only today. A format that omits it makes `vault.import` throw with
   * its id named, rather than failing somewhere less legible.
   */
  decode?(input: Out): readonly DecodedChunk[] | Promise<readonly DecodedChunk[]>
}

export type { ExportChunk, ExportFormat, VaultDiff }
