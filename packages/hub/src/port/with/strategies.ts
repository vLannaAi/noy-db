/**
 * The strategy bag (#838) — one resolved, immutable record of every opt-in
 * service, built once in `createNoydb` and carried by reference down the
 * spine: `Noydb` → `Vault` → `Collection`.
 *
 * ## Why this exists
 *
 * Threading one service through the spine used to cost ~10 mechanical edits
 * with no logic in any of them: a field on `NoydbOptions`, a conditional
 * spread at the `new Vault(` site, a field declaration + constructor
 * parameter + constructor assignment on `Vault`, a forwarding spread into
 * the collection options, a field + `?? NO_*` default in
 * `collection-config.ts`, and a field + assignment on `Collection`. Nothing
 * checked that a new service reached every layer, which is exactly how #834
 * happened — one of three copies of the Vault option block had silently
 * dropped six strategies, and a vault reached that way threw
 * `*NotEnabledError` for services the caller had actually configured.
 *
 * Here the layers hold ONE field. Adding a service is a row in
 * {@link StrategyBag} plus a row in {@link STRATEGY_DEFAULTS} — both in this
 * file, and omitting either is a compile error rather than a bug that only
 * shows up through one construction path.
 *
 * ## Every key always resolves
 *
 * There is no `undefined` in the bag. An un-opted-in service resolves to its
 * `NO_*` stub, which is the tree-shake seam: the stubs are deliberately tiny
 * modules on the `/with` port that the spine may import statically, while the
 * real implementation arrives only when the consumer imports the service's
 * subpath. Holding a stub costs a few hundred bytes; it does not pull the
 * machinery in.
 *
 * Two services needed adjusting to fit that rule, both recorded here because
 * the reasons are not obvious:
 *
 *  - `archive` had no stub at all and was held as `ArchiveStrategy |
 *    undefined` behind a hand-rolled null gate. {@link NO_ARCHIVE} now stands
 *    in and throws on `.store` access — see `port/with/archive-strategy.ts`.
 *  - `lazy`'s floor is {@link IMPLICIT_LAZY}, not a no-op: an un-opted-in
 *    collection still gets a working LRU, it just warns. So its default row
 *    is a real strategy, which is why this table maps keys to defaults rather
 *    than assuming a `NO_*` naming convention.
 *
 * `coordinationStrategy` is deliberately NOT in the bag. It is a
 * `CoordinationProvider`, not a service strategy — it has no `with*()`
 * factory, no `NO_*` stub, and is resolved asynchronously from the store
 * (`createDefaultCoordinationProvider`) rather than passed through. The
 * completeness assertion at the bottom of this file excludes it by name so
 * that the exclusion is explicit and survives future edits.
 *
 * @internal
 */

import type { NoydbOptions } from '../../kernel/types.js'

import { NO_REDUCE, type ReduceStrategy } from '../../with-lookup/reduce/strategy.js'
import { NO_ATTESTATION, type AttestationStrategy } from '../../with-audit/attestation/strategy.js'
import { NO_BLOBS, type BlobsStrategy } from './blob-strategy.js'
import { NO_BROKER, type BrokerStrategy } from './broker-strategy.js'
import { NO_CARGO, type CargoStrategy } from '../../with-cargo/strategy.js'
import { NO_CLASSIFIED, type ClassifiedStrategy } from './classified-strategy.js'
import { NO_CONSENT, type ConsentStrategy } from '../../with-audit/consent/strategy.js'
import { NO_CRDT, type CrdtStrategy } from '../../with-commit/crdt/strategy.js'
import { NO_CUSTODY, type CustodyStrategy } from '../../with-party/custody/strategy.js'
import { NO_FORGET, type ForgetStrategy } from '../../with-audit/forget/strategy.js'
import { NO_HISTORY, type HistoryStrategy } from '../../with-commit/history/strategy.js'
import { NO_I18N, type I18nStrategy } from './i18n-strategy.js'
import { NO_INDEXING, type IndexingStrategy } from '../../with-lookup/indexing/strategy.js'
import { NO_PERIODS, type PeriodsStrategy } from '../../with-audit/periods/strategy.js'
import { NO_PORTABILITY, type PortabilityStrategy } from '../../with-audit/portability/strategy.js'
import { NO_SEALED_RECORD, type SealedRecordStrategy } from '../../with-audit/sealed-record/strategy.js'
import { NO_SEARCH, type SearchStrategy } from '../../with-lookup/search/strategy.js'
import { NO_SEQUENCE, type SequenceStrategy } from '../../with-commit/sequence/strategy.js'
import { NO_SESSION, type SessionStrategy } from '../../with-party/session/strategy.js'
import { NO_SHADOW, type ShadowStrategy } from '../../with-fork/shadow/strategy.js'
import { NO_SNAPSHOTS, type SnapshotsStrategy } from '../../with-fork/snapshots/strategy.js'
import { NO_SYNC, type SyncStrategy } from '../../with-sync/strategy.js'
import { NO_TEAM, type TeamStrategy } from './team-strategy.js'
import { NO_TIERS, type TiersStrategy } from '../../with-audit/tiers/strategy.js'
import { NO_TRANSACTIONS, type TransactionsStrategy } from '../../with-commit/tx/strategy.js'
import { IMPLICIT_LAZY, type LazyStrategy } from './lazy-strategy.js'
import { NO_ARCHIVE } from './archive-strategy.js'
import type { ArchiveStrategy } from '../../with-fork/archive/index.js'

/**
 * Every opt-in service, resolved. One field per service, never `undefined`.
 *
 * Keys drop the `Strategy` suffix the `createNoydb` option carries, so
 * `searchStrategy: withSearch()` reads back as `strategies.search`. The
 * completeness assertion below pins that correspondence.
 */
export interface StrategyBag {
  readonly reduce: ReduceStrategy
  readonly archive: ArchiveStrategy
  readonly attestation: AttestationStrategy
  readonly blobs: BlobsStrategy
  readonly broker: BrokerStrategy
  readonly cargo: CargoStrategy
  readonly classified: ClassifiedStrategy
  readonly consent: ConsentStrategy
  readonly crdt: CrdtStrategy
  readonly custody: CustodyStrategy
  readonly forget: ForgetStrategy
  readonly history: HistoryStrategy
  readonly i18n: I18nStrategy
  readonly indexing: IndexingStrategy
  readonly lazy: LazyStrategy
  readonly periods: PeriodsStrategy
  readonly portability: PortabilityStrategy
  readonly sealedRecord: SealedRecordStrategy
  readonly search: SearchStrategy
  readonly sequence: SequenceStrategy
  readonly session: SessionStrategy
  readonly shadow: ShadowStrategy
  readonly snapshots: SnapshotsStrategy
  readonly sync: SyncStrategy
  readonly team: TeamStrategy
  readonly tiers: TiersStrategy
  readonly transactions: TransactionsStrategy
}

/** The name of every service in the bag. */
export type StrategyKey = keyof StrategyBag

/**
 * The un-opted-in floor: what each service resolves to when the caller passed
 * no `with*()` factory. Annotating this `StrategyBag` is what makes a missing
 * row a compile error.
 */
export const STRATEGY_DEFAULTS: StrategyBag = {
  reduce: NO_REDUCE,
  archive: NO_ARCHIVE,
  attestation: NO_ATTESTATION,
  blobs: NO_BLOBS,
  broker: NO_BROKER,
  cargo: NO_CARGO,
  classified: NO_CLASSIFIED,
  consent: NO_CONSENT,
  crdt: NO_CRDT,
  custody: NO_CUSTODY,
  forget: NO_FORGET,
  history: NO_HISTORY,
  i18n: NO_I18N,
  indexing: NO_INDEXING,
  lazy: IMPLICIT_LAZY,
  periods: NO_PERIODS,
  portability: NO_PORTABILITY,
  sealedRecord: NO_SEALED_RECORD,
  search: NO_SEARCH,
  sequence: NO_SEQUENCE,
  session: NO_SESSION,
  shadow: NO_SHADOW,
  snapshots: NO_SNAPSHOTS,
  sync: NO_SYNC,
  team: NO_TEAM,
  tiers: NO_TIERS,
  transactions: NO_TRANSACTIONS,
}

/** Every key of the bag, as a runtime array. Derived, so it cannot drift. */
const STRATEGY_KEYS = Object.keys(STRATEGY_DEFAULTS) as StrategyKey[]

/**
 * Build the bag from user options. Called ONCE, in `createNoydb` — every
 * layer below shares the resulting reference.
 *
 * The two casts are the price of mapping `blob` ↔ `blobsStrategy` in a loop
 * instead of writing 27 hand-copied lines; the correspondence they assume is
 * proven at compile time by the assertion below, so a typo cannot survive a
 * build.
 */
export function resolveStrategies(options: NoydbOptions): StrategyBag {
  const provided = options as unknown as Record<string, unknown>
  const resolved = { ...STRATEGY_DEFAULTS } as unknown as Record<string, unknown>

  for (const key of STRATEGY_KEYS) {
    const value = provided[`${key}Strategy`]
    if (value !== undefined) resolved[key] = value
  }

  return resolved as unknown as StrategyBag
}

// ─── Completeness: the bag and the public options must name the same set ──
//
// If a service is added to `NoydbOptions` without a bag row (or a bag row is
// added without the option), one of these aliases resolves to the offending
// key instead of `never` and fails to compile, naming it in the error.

/** A type that only accepts `never` — see the two assertions below. */
type AssertNever<T extends never> = T

/** Every `*Strategy` key the public `createNoydb` options declare. */
type OptionStrategyKeys = Extract<keyof NoydbOptions, `${string}Strategy`>

/** What those keys would be if derived from the bag. */
type BagOptionKeys = `${StrategyKey}Strategy`

/**
 * Options that are `*Strategy`-shaped but deliberately not services. See the
 * file header for why `coordinationStrategy` is excluded.
 */
type NonServiceStrategyOptions = 'coordinationStrategy'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _EveryOptionHasABagRow = AssertNever<
  Exclude<OptionStrategyKeys, BagOptionKeys | NonServiceStrategyOptions>
>

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _EveryBagRowHasAnOption = AssertNever<Exclude<BagOptionKeys, OptionStrategyKeys>>
