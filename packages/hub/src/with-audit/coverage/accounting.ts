/**
 * Coverage accounting (#1363) — per `(principal, vault, collection)`.
 *
 * ⛔⛔ **TELEMETRY, NOT A CONTROL.** Against an insider holding the device and
 * local keys this prevents nothing; it makes bulk extraction visible early,
 * attributable and loud. Key custody (tiers, per-collection DEKs) is the
 * remediation. Nothing in this module refuses a read, and nothing in it may
 * ever grow the ability to (#1251 §3: a refusal is a threshold the reader can
 * binary-search; a signal is not).
 *
 * What is accounted, and why each one:
 *
 *  - **distinct ids ever decrypted** (HyperLogLog) — coverage is the protected
 *    quantity, not rate: patience lowers an extractor's rate and never their
 *    coverage. Monotonic, and the horizon is the life of the state, never a
 *    30-day window that resets faster than the attack completes.
 *  - **novelty per window** (Bloom, cleared per window) — the discriminator
 *    that is orthogonal to speed. A legitimate operator re-reads a working
 *    subset (high volume, low novelty); an extractor reads new records.
 *  - **served** — decrypts, all time and per window.
 *  - **burstiness** — this window's served count over the running mean of the
 *    previous windows'. 1 while there is no history to compare against.
 *
 * @module
 */

import { BloomFilter, HyperLogLog } from './sketch.js'
import type {
  CoverageEmitter,
  CoverageEvent,
  CoverageFieldMeta,
  CoverageObserver,
  CoverageStrategy,
} from '../../port/with/coverage-strategy.js'

/** Per-collection policy. Absent `corpusSize` ⇒ no coverage estimate, so no alert. */
export interface CoverageCollectionPolicy {
  /**
   * How many records the corpus holds. Coverage is `distinct / corpusSize`.
   * Deliberately DECLARED rather than counted: counting means a store read on
   * a sensor that must not touch the store, and a corpus size that moves with
   * every write makes an alert threshold un-reproducible.
   */
  readonly corpusSize?: number
  /** Coverage fractions to alert at. Default `[0.6, 0.9]`. Each fires at most once. */
  readonly alertAt?: readonly number[]
}

export interface WithCoverageOptions {
  /**
   * HyperLogLog precision — the register file is `2^precision` bytes per
   * `(principal, vault, collection)`. Default 14 (16 KiB), chosen by
   * measurement; the table is in `sketch.ts`.
   */
  readonly precision?: number
  /** Bloom width in bits, per key, per window. Default 16 384 (2 KiB). */
  readonly bloomBits?: number
  /** Bloom hash count. Default 7. */
  readonly bloomHashes?: number
  /** Novelty window length. Default one hour. NOT the coverage horizon — that never resets. */
  readonly windowMs?: number
  /** Per-collection corpus size and alert thresholds. */
  readonly collections?: Readonly<Record<string, CoverageCollectionPolicy>>
  /** Clock seam, for tests. */
  readonly now?: () => number
}

export interface CoverageStats {
  readonly principal: string
  readonly vault: string
  readonly collection: string
  /** HLL estimate of distinct ids ever decrypted. */
  readonly distinct: number
  readonly served: number
  readonly novelInWindow: number
  readonly servedInWindow: number
  readonly burstiness: number
  /** Absent when the collection declares no `corpusSize`. */
  readonly coverage?: number
  readonly window: string
}

/**
 * Serializable coverage state.
 *
 * ⛔ SKETCHES ONLY — the invariant this module exists to hold. A structure
 * that could name the records a principal has read would be a second copy of
 * the sensitive set: the sensor built to notice bulk extraction would become
 * the single best artefact to extract. Pinned by
 * `__tests__/coverage/no-record-ids.test.ts`.
 */
export interface CoverageSnapshot {
  readonly _noydb_coverage: 1
  readonly entries: ReadonlyArray<{
    readonly principal: string
    readonly vault: string
    readonly collection: string
    readonly hll: { readonly p: number; readonly r: string }
    readonly served: number
    readonly windowStart: number
  }>
}

const DEFAULT_ALERT_AT = [0.6, 0.9] as const
const HOUR_MS = 3_600_000

class Account {
  hll: HyperLogLog
  readonly bloom: BloomFilter
  served = 0
  servedInWindow = 0
  novelInWindow = 0
  windowStart: number
  /** Running mean of previous windows' served counts, for burstiness. */
  servedMean = 0
  windowsClosed = 0
  readonly fired = new Set<number>()

  constructor(
    readonly principal: string,
    readonly vault: string,
    readonly collection: string,
    opts: { precision: number; bloomBits: number; bloomHashes: number; now: number },
  ) {
    this.hll = new HyperLogLog(opts.precision)
    this.bloom = new BloomFilter(opts.bloomBits, opts.bloomHashes)
    this.windowStart = opts.now
  }
}

export class CoverageRegistry implements CoverageStrategy {
  readonly #accounts = new Map<string, Account>()
  readonly #precision: number
  readonly #bloomBits: number
  readonly #bloomHashes: number
  readonly #windowMs: number
  readonly #collections: Readonly<Record<string, CoverageCollectionPolicy>>
  readonly #now: () => number
  readonly #warnedEager = new Set<string>()

  constructor(opts: WithCoverageOptions = {}) {
    this.#precision = opts.precision ?? 14
    this.#bloomBits = opts.bloomBits ?? 1 << 14
    this.#bloomHashes = opts.bloomHashes ?? 7
    this.#windowMs = opts.windowMs ?? HOUR_MS
    this.#collections = opts.collections ?? {}
    this.#now = opts.now ?? (() => Date.now())
    if (this.#windowMs <= 0) throw new RangeError(`windowMs must be > 0, got ${this.#windowMs}`)
  }

  observer(
    vault: string,
    collection: string,
    principal: string,
    fieldMeta: () => CoverageFieldMeta | undefined,
    emitter: CoverageEmitter,
    eager: boolean,
  ): CoverageObserver | undefined {
    // Whether this collection is accounted resolves on the FIRST decrypt, not
    // here: `fieldMeta` can be attached to a Collection after construction
    // (`_applyFieldMeta`, first-wins) and this runs from the constructor. So
    // an opted-in deployment pays one boolean test per decrypt on the
    // collections it does not account for; an un-opted-in one pays nothing at
    // all, because NO_COVERAGE returns no observer.
    let accounted: boolean | undefined
    return (id: string): void => {
      accounted ??= this.#resolveAccounted(collection, fieldMeta(), eager)
      if (!accounted) return
      this.#record(principal, vault, collection, id, emitter)
    }
  }

  /**
   * ⛔⛔ THE MEASUREMENT THAT DECIDES WHETHER THIS SENSOR SAYS ANYTHING TRUE.
   *
   * The design's unit is "the record decrypt". In hub that is only the same
   * thing as "the record was read" for a LAZY collection (`prefetch: false`),
   * where reads go per-id against the store. An EAGER collection — the default
   * — decrypts its entire corpus once, at hydration, into the working set:
   * measured on a 30-record collection, one `get()` after reopening the vault
   * took the sensor from 0 to `coverage: 1`. Every principal who so much as
   * opens the vault would trip every threshold.
   *
   * A sensor that reports total coverage for everyone is worse than no sensor:
   * it is exactly the "invites reliance" failure this feature is supposed to
   * be honest about. So an eager bulk-declared collection is NOT accounted,
   * and the refusal is LOUD — silence here would look identical to "nobody has
   * read anything", which is the most dangerous possible false negative.
   *
   * The codec cannot tell hydration from a read (it sees neither caller nor
   * intent), so this cannot be fixed inside the sensor. Declaring the
   * collection lazy is the fix, and the warning says so.
   */
  #resolveAccounted(collection: string, fieldMeta: CoverageFieldMeta | undefined, eager: boolean): boolean {
    const declared = this.#collections[collection] !== undefined || declaresBulk(fieldMeta)
    if (!declared) return false
    if (!eager) return true
    if (!this.#warnedEager.has(collection)) {
      this.#warnedEager.add(collection)
      console.warn(
        `[noy-db] withCoverage(): collection "${collection}" is bulk-declared but EAGER, so it is NOT ` +
        `accounted. An eager collection decrypts its whole corpus at hydration, which would read as ` +
        `100% coverage for every principal that opens the vault. Declare it \`prefetch: false\` ` +
        `(with a \`cache\` budget) to make its reads countable. Coverage is telemetry either way — ` +
        `the remediation for bulk exposure is key custody (tiers, per-collection DEKs).`,
      )
    }
    return false
  }

  #account(principal: string, vault: string, collection: string, now: number): Account {
    const k = JSON.stringify([principal, vault, collection])
    let acc = this.#accounts.get(k)
    if (acc === undefined) {
      acc = new Account(principal, vault, collection, {
        precision: this.#precision,
        bloomBits: this.#bloomBits,
        bloomHashes: this.#bloomHashes,
        now,
      })
      this.#accounts.set(k, acc)
    }
    return acc
  }

  #record(principal: string, vault: string, collection: string, id: string, emitter: CoverageEmitter): void {
    const now = this.#now()
    const acc = this.#account(principal, vault, collection, now)

    if (now - acc.windowStart >= this.#windowMs) {
      // Close the window: fold its served count into the running mean, clear
      // the novelty filter. ⛔ The HLL is NOT cleared — the coverage horizon
      // must exceed tenure, and a horizon that resets is the low-and-slow hole
      // the whole reframe (#1251 §3) exists to close.
      acc.servedMean = acc.windowsClosed === 0
        ? acc.servedInWindow
        : (acc.servedMean * acc.windowsClosed + acc.servedInWindow) / (acc.windowsClosed + 1)
      acc.windowsClosed++
      acc.bloom.clear()
      acc.servedInWindow = 0
      acc.novelInWindow = 0
      acc.windowStart = now
    }

    // Unconditionally, before the novelty test: a Bloom false positive must not
    // leak into the distinct count, which is what an alert is computed from.
    acc.hll.add(id)
    if (acc.bloom.addIfAbsent(id)) acc.novelInWindow++
    acc.served++
    acc.servedInWindow++

    const policy = this.#collections[collection]
    const corpusSize = policy?.corpusSize
    if (corpusSize === undefined || corpusSize <= 0) return
    const coverage = Math.min(1, acc.hll.count() / corpusSize)
    for (const t of policy?.alertAt ?? DEFAULT_ALERT_AT) {
      if (coverage < t || acc.fired.has(t)) continue
      acc.fired.add(t)
      const event: CoverageEvent = {
        principal,
        vault,
        collection,
        novel: acc.novelInWindow,
        served: acc.served,
        coverage,
        window: new Date(acc.windowStart).toISOString(),
        source: 'hub/coverage',
      }
      emitter.emit('coverage:threshold', event)
    }
  }

  /** Current accounting, for an operator surface. Estimates, never exact. */
  stats(): readonly CoverageStats[] {
    const out: CoverageStats[] = []
    for (const acc of this.#accounts.values()) {
      const corpusSize = this.#collections[acc.collection]?.corpusSize
      const distinct = acc.hll.count()
      out.push({
        principal: acc.principal,
        vault: acc.vault,
        collection: acc.collection,
        distinct,
        served: acc.served,
        novelInWindow: acc.novelInWindow,
        servedInWindow: acc.servedInWindow,
        burstiness: acc.servedMean > 0 ? acc.servedInWindow / acc.servedMean : 1,
        ...(corpusSize !== undefined && corpusSize > 0
          ? { coverage: Math.min(1, distinct / corpusSize) }
          : {}),
        window: new Date(acc.windowStart).toISOString(),
      })
    }
    return out
  }

  /**
   * Serializable state, for a deployment that wants coverage to survive a
   * restart — the horizon must exceed tenure, and a process does not.
   * ⛔ Sketches only. Never a record id: see {@link CoverageSnapshot}.
   */
  snapshot(): CoverageSnapshot {
    const entries: Array<CoverageSnapshot['entries'][number]> = []
    for (const acc of this.#accounts.values()) {
      entries.push({
        principal: acc.principal,
        vault: acc.vault,
        collection: acc.collection,
        hll: acc.hll.toJSON(),
        served: acc.served,
        windowStart: acc.windowStart,
      })
    }
    return { _noydb_coverage: 1, entries }
  }

  /**
   * Restore a snapshot. The novelty filter is deliberately NOT restored:
   * novelty is a within-window notion and the window did not survive.
   * Distinct-ever did, which is the quantity that must not reset.
   */
  restore(snapshot: CoverageSnapshot): void {
    for (const e of snapshot.entries) {
      const acc = this.#account(e.principal, e.vault, e.collection, e.windowStart)
      acc.hll = HyperLogLog.fromJSON(e.hll)
      acc.served = e.served
      acc.windowStart = e.windowStart
    }
  }
}

function declaresBulk(fieldMeta: CoverageFieldMeta | undefined): boolean {
  if (fieldMeta === undefined) return false
  for (const meta of Object.values(fieldMeta)) if (meta?.bulk === 'sensitive') return true
  return false
}
