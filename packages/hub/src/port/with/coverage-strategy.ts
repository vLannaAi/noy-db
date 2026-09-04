/**
 * Read-coverage sensor contract (#1363, from the #1251 design).
 *
 * ⛔⛔ **THIS IS TELEMETRY. IT IS NOT A CONTROL.** Against an insider holding
 * the device and local keys, it prevents nothing — they hold the DEK, so the
 * plaintext is derivable whatever hub decides. What it does is make bulk
 * extraction **visible early, attributable and loud**. The real remediation is
 * key custody — tiers and per-collection DEKs — and any deployment that reads
 * this as a control has been made *less* safe by it, because it stops building
 * the key boundary that would actually bind.
 *
 * Lives on the `/with` port (the one seam the kernel spine may import
 * statically) so `Collection`/`RecordCodec` can hold the {@link NO_COVERAGE}
 * floor default without a spine→service static import.
 *
 * ⛔ There is deliberately NO refusal path here, and none may be added. The
 * design ruled (#1251 §3) that set-completion ALERTING beats threshold
 * blocking: a refusal at a boundary is a threshold the reader can
 * binary-search, and a signal is not. Adding "just an option" to refuse
 * reintroduces exactly the objection the shape was chosen to dissolve.
 *
 * @internal
 */

/**
 * The one event every sensor in the #1251 design emits, whatever its
 * enforcement point — so a controller subscribes once. Emitted on the Noydb
 * event bus as `'coverage:threshold'`.
 */
export interface CoverageEvent {
  /** Authenticated identity the reads are attributed to (`keyring.userId`). */
  readonly principal: string
  readonly vault: string
  readonly collection: string
  /** Records novel to this window (Bloom-estimated; under-reports, never over). */
  readonly novel: number
  /** Decrypts served to this principal for this collection, all time. */
  readonly served: number
  /** Distinct-ever-decrypted as a fraction of the declared corpus, 0..1 (HLL-estimated). */
  readonly coverage: number
  /** ISO-8601 start of the window the crossing was observed in. */
  readonly window: string
  /** Which sensor produced it. `'hub/coverage'` for this one. */
  readonly source: string
}

/**
 * The decrypt observer: called once per record decrypt, with the record id.
 *
 * ⛔ The id is passed so the sketch can be UPDATED with it, and must never be
 * retained. See `with-audit/coverage/sketch.ts`.
 */
export type CoverageObserver = (id: string) => void

/** The minimal emitter slice the sensor needs. Structural, to avoid an import. */
export interface CoverageEmitter {
  emit(event: 'coverage:threshold', data: CoverageEvent): void
}

/** Field descriptors, read only for the `bulk` axis. Structural by design. */
export type CoverageFieldMeta = Readonly<Record<string, { readonly bulk?: 'sensitive' }>>

export interface CoverageStrategy {
  /**
   * Resolve the decrypt observer for one collection, or `undefined` when
   * nothing should be accounted — which is the un-opted-in case, and also the
   * opted-in case for a collection declaring no `bulk: 'sensitive'` field.
   *
   * `fieldMeta` is a THUNK because `fieldMeta` can be attached to a Collection
   * after construction (`_applyFieldMeta`, first-wins), and this is called
   * from the constructor.
   *
   * ⛔ `eager` is load-bearing, not informational — see the eager-hydration
   * note in `with-audit/coverage/accounting.ts`. An eager collection decrypts
   * its WHOLE corpus at hydration, so a decrypt-point sensor reads 100%
   * coverage for anyone who opens the vault.
   */
  observer(
    vault: string,
    collection: string,
    principal: string,
    fieldMeta: () => CoverageFieldMeta | undefined,
    emitter: CoverageEmitter,
    eager: boolean,
  ): CoverageObserver | undefined
}

/**
 * The un-opted-in floor: no observer, therefore no accounting, no allocation
 * per read, and no coverage code in the bundle. `Collection` calls
 * `observer()` once at construction and stores `undefined`; `RecordCodec`'s
 * hot path is a single `!== undefined` test.
 */
export const NO_COVERAGE: CoverageStrategy = { observer: () => undefined }
