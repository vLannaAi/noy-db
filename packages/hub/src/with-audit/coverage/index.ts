/**
 * `@noy-db/hub/coverage` — read-coverage sensor (#1363, from the #1251 design).
 *
 * ⛔⛔ **Against an insider holding the device and local keys, this prevents
 * nothing. It makes bulk extraction visible early, attributable and loud. It
 * is telemetry.** The real remediation is key custody (tiers, per-collection
 * DEKs); a coverage alert is a complement to a key boundary and a poor
 * substitute for one.
 *
 * The reframe it implements: the protected quantity for "safe individually,
 * sensitive in bulk" data is **coverage** — the fraction of a corpus a
 * principal has *ever* decrypted — not rate. Rate limiting fails structurally
 * against low-and-slow; patience lowers an extractor's rate and never their
 * coverage. So this service accounts distinct-ever (HyperLogLog), novelty per
 * window (Bloom), served count and burstiness per
 * `(principal, vault, collection)`, and emits `'coverage:threshold'` when
 * declared coverage thresholds are crossed.
 *
 * ⛔ It never refuses a read, and no option to do so may be added: a refusal
 * at a boundary is a threshold the reader can binary-search.
 * ⛔ It never persists a record id. Sketches are the only state.
 * ⚠️ It accounts only LAZY collections (`prefetch: false`). An eager
 * collection decrypts its whole corpus at hydration, which a decrypt-point
 * sensor cannot tell from a read — see `accounting.ts#resolveAccounted`.
 *
 * ## Honeytoken recipe (prose — the cheapest high-signal sensor in the design)
 *
 * Coverage alerting tells you how much of a corpus a principal has seen.
 * A honeytoken tells you, on the FIRST read, that someone is enumerating —
 * and it is immune to rate shaping, because there is no legitimate rate at
 * which a record nobody should open gets opened.
 *
 * 1. Seed a handful of records in the bulk-declared collection that no
 *    business process ever addresses: plausible-looking rows with ids no
 *    workflow can reach, never referenced by a ref, never in a report.
 * 2. Keep the list of their ids OUTSIDE the vault — in the code or the
 *    operator's config. It must never become a queryable "honeytokens"
 *    collection: that is a lookup table telling an insider which rows to
 *    avoid, i.e. the same second-copy mistake the sketches exist to avoid.
 * 3. Wrap the read path the app already owns and compare the id it is about
 *    to serve against that list. Any hit is a high-confidence signal — page
 *    the owner, and (with `withHistory()`) append a ledger entry so the
 *    detection itself is tamper-evident.
 * 4. Do not refuse the read. Serving it keeps the reader unaware they tripped
 *    a sensor, which is the entire value; refusing turns the honeytoken into
 *    an oracle for finding the other honeytokens.
 * 5. Rotate them when staff change. A honeytoken whose location has leaked is
 *    a honeytoken that reports nothing.
 *
 * ⚠️ Honeytokens detect ENUMERATION, not exfiltration of a known subset. They
 * complement coverage alerting; neither prevents anything.
 *
 * @category capability
 * @module
 */

export { withCoverage } from './active.js'
export { CoverageRegistry } from './accounting.js'
export type {
  CoverageCollectionPolicy,
  CoverageSnapshot,
  CoverageStats,
  WithCoverageOptions,
} from './accounting.js'
export { BloomFilter, HyperLogLog } from './sketch.js'
export type {
  CoverageEmitter,
  CoverageEvent,
  CoverageFieldMeta,
  CoverageObserver,
  CoverageStrategy,
} from '../../port/with/coverage-strategy.js'
// Exported so callers can compare against the un-opted-in floor (#844).
export { NO_COVERAGE } from '../../port/with/coverage-strategy.js'
