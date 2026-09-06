#!/usr/bin/env node
/**
 * Bundle-size + cross-leak invariants for the v0.25 catalog.
 *
 * Synthesizes consumer scenarios, builds them with esbuild in
 * production mode, and asserts:
 *
 *   1. **Floor invariant** — `import { createNoydb } from '@noy-db/hub'`
 *      with no other imports compiles to ≤ FLOOR_LIMIT_BYTES (gzipped).
 *
 *   2. **Per-subsystem invariant** — importing exactly one
 *      `with<X>()` factory adds at most its allowance over the floor.
 *
 *   3. **Cross-leak invariant** — implementation classes from
 *      subsystems (LedgerStore, BlobSet, Aggregation, …) never appear
 *      verbatim in the floor scenario's output. If they do, a runtime
 *      import has snuck in and the catalog is silently broken.
 *
 * Run via:    pnpm --filter @noy-db/hub bundle-check
 * CI gate:    invoked from turbo's bundle-check task; exit 1 fails CI.
 *
 * Manifest:   ./bundle-manifest.json — checked-in baseline. Update via
 *             `BUNDLE_BASELINE_UPDATE=1 pnpm --filter @noy-db/hub bundle-check`
 *             when you intentionally accept a size shift.
 */

import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const MANIFEST_PATH = join(__dirname, '..', 'bundle-manifest.json')

// Every runtime entry point the package publishes: subpath -> built file.
// Derived from package.json rather than transcribed, because a hand-kept copy
// of the exports map is a second thing to forget when a subpath is added, and
// the failure is silent — esbuild resolves the unaliased specifier through
// node_modules and measures whatever it finds there instead. `codemods/*.json`
// is published DATA, not code, and is excluded.
const HUB_EXPORT_TARGETS = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(join(HUB_DIR, 'package.json'), 'utf8')).exports)
    .filter(([, target]) => typeof target?.default === 'string' && target.default.endsWith('.js'))
    .map(([subpath, target]) => [subpath, join(HUB_DIR, target.default)]),
)

// esbuild alias map: '@noy-db/hub', '@noy-db/hub/history', … -> the built file.
const HUB_ALIAS = Object.fromEntries(
  Object.entries(HUB_EXPORT_TARGETS)
    .map(([subpath, file]) => [`@noy-db/hub${subpath === '.' ? '' : subpath.slice(1)}`, file]),
)

// Tolerance: real bundles wobble between builds by a few bytes due to
// hash-based chunk naming. Allow a 5% upward drift before failing.
const TOLERANCE_PCT = 5

// …and an absolute floor on that allowance (#1268).
//
// A PERCENTAGE on a small baseline measures the wrong thing. The `floor`
// scenario is ~500 gzipped bytes, so 5% is ~25 bytes — narrower than a single
// registration-time guard. This gate fired twice on necessary validation
// (#1249, #1266) and never once on the thing it exists to catch. The two are
// different by ORDERS OF MAGNITUDE: a subsystem leaking into a bundle is
// kilobytes (measured: forcing the AWS SDK inline moved a sibling package from
// 14,069 to 1,081,539 bytes), while a guard is tens of bytes.
//
// So a growth fails only if it exceeds BOTH the percentage AND this absolute
// allowance. On the large scenarios the percentage still binds and this is
// inert; on `floor` it stops a correct check obstructing correct code.
// Deliberately NOT a re-baseline: the numbers still ratchet, and a real leak
// clears this by three orders of magnitude.
const TOLERANCE_MIN_BYTES = 192

/**
 * Each scenario is a tiny consumer program. The script writes it to a
 * temp dir, runs esbuild against it (resolving @noy-db/hub through
 * the repo's installed dist), and measures the gzipped output.
 *
 * `leakCanaries` are class names that MUST NOT appear verbatim in the
 * raw (un-minified, un-gzipped) bundle output. Their presence
 * indicates the floor scenario re-bundled subsystem implementation
 * code that should have been gated.
 */
const SCENARIOS = [
  {
    name: 'floor',
    description: 'createNoydb only — no subsystem opt-in',
    code: `
      import { createNoydb } from '@noy-db/hub'
      export { createNoydb }
    `,
    leakCanaries: [
      // Each canary names a class whose presence in the floor bundle
      // would mean its subsystem leaked through a runtime import.
      //
      // NOTE: with `splitting: true` (the post-#130 measurement mode)
      // class/const-literal definitions live in shared chunk files,
      // not in entry.js. These literal-pattern canaries therefore
      // catch a regression only if the bundling strategy ever loses
      // splitting and the definition gets inlined back into the entry.
      // The discriminating signal under code-splitting is `eagerImports`
      // (below) — the bare symbol appearing in the entry's top-level
      // `import { ... } from "./chunk-…"` prologue.
      'class LedgerStore',     // history (re-added post.)
      'class Reduction',       // reduce
      'class GroupedQuery',    // reduce
      'class WindowedQuery',   // reduce/window (#1349) — a second opt-in inside reduce
      'class BlobSet',         // blobs
      'class DictionaryHandle',// i18n
      'class SyncEngine',      // sync
      'class PolicyEnforcer',  // session
      'class VaultInstant',    // history (time-machine)
      'class VaultFrame',      // shadow
      'class GuardRegistry',        // guards/registry.ts — must stay opt-in
      'class ReadOnlyVaultFacade',  // guards/read-only-facade.ts — must stay opt-in
      'class DerivationRegistry',   // derivations/registry.ts — must stay opt-in
      // #1363 read-coverage sensor. The floor holds NO_COVERAGE (a one-line
      // stub returning undefined); the sketches and the accounting engine must
      // arrive only via @noy-db/hub/coverage. This is the zero-cost-when-
      // unopted claim, measured rather than asserted.
      'class CoverageRegistry',     // coverage/accounting.ts
      'class HyperLogLog',          // coverage/sketch.ts
      'class BloomFilter',          // coverage/sketch.ts
      // Object-literal export shape (`const X = { ... }`). The trailing
      // `{` discriminates the actual static export from the lazy-loader
      // placeholder pattern `let GuardExecutor = null` that legitimately
      // lives in dynamic-import call sites.
      'GuardExecutor = {',          // guards/executor.ts (const object, not class) — must stay opt-in
      'DerivationExecutor = {',     // derivations/executor.ts (const object, not class) — must stay opt-in
    ],
    // Eager-import canaries — bare symbol names. The check scans the
    // entry chunk's top-level import prologue only; a hit means the
    // symbol arrived via a static `import { X } from "./chunk-…"`
    // statement rather than the intended `await import()` at the
    // call site. This is the load-bearing leak signal under
    // `splitting: true` — see #138 review (canaries didn't catch
    // residual statics because chunked definitions never appear in
    // entry.js).
    eagerImports: [
      'GuardRegistry',
      'ReadOnlyVaultFacade',
      'DerivationRegistry',
      'CoverageRegistry',      // #1363 coverage accounting engine
      'HyperLogLog',           // #1363 coverage sketch
      'BloomFilter',           // #1363 coverage sketch
      'GuardExecutor',
      'DerivationExecutor',
      // Archetype-3 schema engines (#553) -- declaration-gated, must never
      // be statically reachable from the floor:
      'quantizeMoneyFields',   // money write engine (linked by money())
      'decodeMoneyFields',     // money read engine
      'moneyFieldClause',      // money where() build engine
      'evaluateMoneyClause',   // money predicate engine
      'wrapMoneyReducers',     // money aggregation engine
      // #1355 geo -- same archetype-3 shape as money: the geohash engine is
      // linked by geo() at DECLARATION time, so a floor consumer that never
      // declares a geo field must not carry the spherical trigonometry.
      'encodeGeohash',         // geo write/index-key engine
      'haversineKm',           // geo predicate engine
      'prefixesForRadius',     // geo prefix-cover planner
      'geoFieldClause',        // geo where() build engine
      'evalComputedFields',    // computed-fields engine (lazy at first put)
      'LinkSet',               // link-set storage engine (lazy links() handle)
      'persistSchemaIfNeeded', // schema-update decision engine
      'FenceWatcher',          // cutover heartbeat/watcher
      'dumpVaultSchema',       // introspection walker
      'buildJsonSchema',       // JSON-Schema assembler
      // #267 keyring-grant → team split -- the multi-user keyring engines
      // are linked only by withTeam() (team subpath) / withCustody(), never
      // by the single-user floor:
      'rotateKeys',            // team keyring re-key engine
      // #479 credential broker -- the seed lifecycle + network/cache engine
      // is linked only by withBroker() (broker subpath), never by the
      // single-user floor; NO_BROKER (the throwing stub) is the only thing
      // the floor ever sees:
      'enrollSeed',            // _broker seed CAS-enrol engine
      'rotateSeed',            // _broker seed quiesce-then-swap rotate engine
      'mintStoreCredentials',  // challenge/response round-trip engine
      // #629 Task 7 -- the blob Via binder links eagerly (port/with/
      // blob-strategy.ts), but the binding is hook-free glue: the BlobSet
      // machinery must still only arrive via the @noy-db/hub/blobs subpath.
      // Complements the 'class BlobSet' literal canary above with the
      // load-bearing signal under splitting (eager chunk import).
      'BlobSet',
    ],
  },
  // ─── #1458 query tiers ────────────────────────────────────────────────
  //
  // The four scenarios below are the SIZE MEASUREMENT AS A TEST that the issue
  // asks for. `query-find` is the one that matters: a consumer who only finds
  // records must not carry the joins, the reducers or the live maintainer, and
  // the canaries name each of those by the symbol that proves it arrived.
  //
  // ⭐ **The three `query-find-*` scenarios are the CONTROL.** Without them a
  // green `query-find` proves only that the symbols are absent — it could not
  // distinguish "correctly tree-shaken" from "the extension never worked".
  // Each of these asserts the very symbol its sibling forbids, so the pair
  // says: gone when unasked-for, present when asked for.
  //
  // ⚠️ These measure the `/query` subpath, NOT the root barrel. The root
  // barrel imports all three groups on purpose (behaviour-identical for
  // today's consumers), so the `floor` scenario above is unaffected by the
  // split and must stay that way.
  {
    name: 'query-find',
    description: '#1458 — @noy-db/hub/query alone: Find, no extension group',
    code: `
      import { Query } from '@noy-db/hub/query'
      export function run(source) {
        return new Query(source).where('status', '==', 'paid').orderBy('date', 'desc').limit(20).toArray()
      }
    `,
    leakCanaries: [],
    // Reachability, not entry-presence: under `splitting: true` a definition
    // lives in a shared chunk, so the question is whether this consumer's
    // graph reaches it at all.
    reachableCanaries: [
      // Relate.
      // ⚠️ NOT `function applyJoins` — Find publishes a three-line SHIM of that
      // exact name (`builder.ts`, the join-conditional wrapper), so the obvious
      // canary matches Find's own code and fails green-for-the-wrong-reason.
      // Measured: it did, on the first run of this scenario. Name something
      // only the real implementation has.
      'function applyOneJoin',
      'function attachJoin',
      'function explainPlan',
      'function runTraversal',
      'function normalizeJoinOn',
      // Reduce
      // ⚠️ `reducerBuilder` is a `const` object, not a function — a
      // `function reducerBuilder` canary never matches and the scenario passes
      // for a reason that has nothing to do with the bundle. Name the shape
      // the source actually has.
      'reducerBuilder = {',
      'function truncateDate',
      // Live
      'function buildLiveQuery',
      'class LiveMaintainer',
    ],
  },
  {
    name: 'query-find-relate',
    description: '#1458 — Find + the Relate side-effect import',
    code: `
      import { Query } from '@noy-db/hub/query'
      import '@noy-db/hub/query/relate'
      export function run(source) {
        return new Query(source).where('status', '==', 'paid').toArray()
      }
    `,
    leakCanaries: [],
    requiredReachable: ['function applyOneJoin'],
  },
  {
    name: 'query-find-reduce',
    description: '#1458 — Find + the Reduce side-effect import',
    code: `
      import { Query } from '@noy-db/hub/query'
      import '@noy-db/hub/query/reduce'
      export function run(source) {
        return new Query(source).where('status', '==', 'paid').toArray()
      }
    `,
    leakCanaries: [],
    requiredReachable: ['reducerBuilder = {'],
  },
  {
    name: 'query-root-barrel',
    description: '#1458 — a root-barrel consumer still gets every group, unasked',
    code: `
      import { createNoydb, Query } from '@noy-db/hub'
      export function run(source) {
        return new Query(source).join('clientId', { as: 'client' }).toArray()
      }
      export { createNoydb }
    `,
    leakCanaries: [],
    // ⭐ THE PROMISE OF #1458, ASSERTED. "The root barrel imports all three, so
    // today's consumers see no change" is the sentence the whole split rests
    // on, and the way it breaks is silent: a bundler drops a side-effect import
    // it believes is pure, and `collection.query().join()` throws
    // QueryExtensionMissingError in production from code that typechecked.
    //
    // ⚠️ Read together with `floor` above, which must STAY at ~550 bytes. The
    // two are in tension — the naive way to guarantee this one is to install
    // eagerly from src/index.ts, and that measured 11,330 gzipped bytes on a
    // consumer who never writes a query. Both numbers, or neither.
    requiredReachable: ['function applyOneJoin', 'reducerBuilder = {', 'function buildLiveQuery'],
  },
  {
    name: 'query-find-live',
    description: '#1458 — Find + the Live side-effect import',
    code: `
      import { Query } from '@noy-db/hub/query'
      import '@noy-db/hub/query/live'
      export function run(source) {
        return new Query(source).where('status', '==', 'paid').toArray()
      }
    `,
    leakCanaries: [],
    requiredReachable: ['function buildLiveQuery'],
  },
  {
    name: 'lazy',
    description: 'createNoydb + withLazy (#267 lazy service)',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withLazy } from '@noy-db/hub/lazy'
      const lazyStrategy = withLazy()
      export { createNoydb, lazyStrategy }
    `,
    leakCanaries: [],
  },
  {
    name: 'team',
    description: 'createNoydb + withTeam (#267 keyring-grant → team split)',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withTeam } from '@noy-db/hub/team'
      const teamStrategy = withTeam()
      export { createNoydb, teamStrategy }
    `,
    leakCanaries: [],
  },
  {
    name: 'broker',
    description: 'createNoydb + withBroker (#479 credential broker)',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withBroker } from '@noy-db/hub/broker'
      const brokerStrategy = withBroker({ brokerId: 'b', endpoint: 'https://broker.example.com' })
      export { createNoydb, brokerStrategy }
    `,
    leakCanaries: [],
  },
  {
    name: 'history',
    description: 'createNoydb + withHistory',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withHistory } from '@noy-db/hub/history'
      export { createNoydb, withHistory }
    `,
    leakCanaries: [],
  },
  {
    name: 'classified',
    description: 'createNoydb + withClassified',
    // Baseline bumped 914 -> 1016 gz for slice-2b: findByDigest +
    // scrubEquatableTags + the equatable surface (descriptor/presets/
    // guards) + the config-drift marker are all public API added to the
    // eagerly-loaded Collection/classified module and cannot be deferred.
    // The find/mint ENGINES stay lazy (canary-guarded below): computeBidxTarget
    // stays behind active.ts's dynamic import exactly like the stage-2
    // verify/reveal engines, and mintBidxTag stays codec-internal like
    // mintVdigSlot. leaks stay ✓ — this is a legitimate size increase, not
    // an eager-engine leak.
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withClassified } from '@noy-db/hub/classified'
      const classifiedStrategy = withClassified()
      export { createNoydb, classifiedStrategy }
    `,
    leakCanaries: [],
    eagerImports: [
      'revealSealedField', // reveal engine (enclave-side since stage 2)
      'verifyDigestField', // verify oracle — MUST stay behind active.ts's dynamic import
      'matchGroupFields',
      'mintVdigSlot',      // write-side digest engine (codec-internal, never eager via the strategy)
      'computeBidxTarget', // findByDigest target/find engine — MUST stay behind active.ts's dynamic import (slice-2b)
      'mintBidxTag',       // write-side digest-index mint engine (codec-internal, never eager via the strategy)
    ],
  },
  {
    name: 'blobs',
    description: 'createNoydb + withBlobs (#629 Task 7 — via-blob scenario)',
    // Measures the real cost of opting into blobs (BlobSet + chunk AEAD +
    // mime-magic arrive eagerly through withBlobs() — that is the opt-in
    // working as designed, not a leak). The floor scenario's 'class BlobSet'
    // literal canary + 'BlobSet' eager-import canary remain the guards that
    // none of this reaches a consumer who never imports @noy-db/hub/blobs.
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withBlobs } from '@noy-db/hub/blobs'
      const blobsStrategy = withBlobs()
      export { createNoydb, blobsStrategy }
    `,
    leakCanaries: [],
  },
  {
    name: 'analytics',
    description: 'createNoydb + withIndexing + withReduce',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withIndexing } from '@noy-db/hub/indexing'
      import { withReduce } from '@noy-db/hub/reduce'
      export { createNoydb, withIndexing, withReduce }
    `,
    leakCanaries: [],
    // The aggregate service must not drag the money engine in -- money
    // reducer wrapping goes through the kernel's generic Via port
    // (kernel/via.ts's viaBinder) and the money binding only links when a
    // collection declares money() fields (#553).
    eagerImports: [
      'wrapMoneyReducers',
      'quantizeMoneyFields',
      'decodeMoneyFields',
      // #1349 — the window engine is a SECOND opt-in inside the reduce
      // service (`withReduce({ window: withWindow() })`), for exactly the
      // reason this list exists. `withReduce()` returns a live object the
      // bundler cannot prove unused, so a `window()` method that named
      // `WindowedQuery` directly linked the whole engine here: measured 960 →
      // 1,845 gzipped bytes, +92%, charged to every consumer who opted into
      // ordinary aggregation and will never call `.window()`.
      // ⛔ Do not resolve a failure on this line by folding `withWindow()`
      // back into `withReduce()` — the extra argument IS the fix.
      'WindowedQuery',
    ],
  },
  {
    name: 'search',
    description: 'createNoydb + withSearch, WITHOUT the approximate vector index (#1360)',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withSearch } from '@noy-db/hub/search'
      const searchStrategy = withSearch()
      export { createNoydb, searchStrategy }
    `,
    leakCanaries: [],
    // ⭐ #1360 part 2 — the tree-shaking PROOF, and the reason
    // `allChunkCanaries` exists at all.
    //
    // `entry.js` canaries cannot answer this question. `withSearch()` already
    // defers the whole retrieval facade behind a dynamic import, so the
    // scenario's entry chunk contains almost nothing either way — the ANN
    // index could be sitting in a split chunk that this consumer loads on its
    // first `retrieve()` and every entry-scoped check would still read green.
    //
    // These names are therefore matched against every chunk REACHABLE from the
    // entry, static or dynamic. A hit means a consumer who opted into search
    // but never called `withVectorIndex()` is nonetheless shipping the index —
    // which is the whole claim #1360 part 2 makes about its own cost.
    reachableCanaries: ['IvfFlatIndex', 'defaultNlist', 'fitCentroids'],
  },
  {
    name: 'search-ann',
    description: 'createNoydb + withSearch + withVectorIndex (#1360 part 2) — the opt-in cost',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withSearch, withVectorIndex } from '@noy-db/hub/search'
      const searchStrategy = withSearch()
      const index = withVectorIndex()
      export { createNoydb, searchStrategy, index }
    `,
    leakCanaries: [],
  },
  {
    name: 'coverage',
    description: 'createNoydb + withCoverage (#1363) — the read-coverage sensor is telemetry, and this is its price',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withCoverage } from '@noy-db/hub/coverage'
      const coverageStrategy = withCoverage({ collections: { clients: { corpusSize: 1000 } } })
      export { createNoydb, coverageStrategy }
    `,
    leakCanaries: [],
    // The zero-cost-when-unopted claim (#1363 step 2) measured rather than
    // asserted: these names exist ONLY in the sensor, and the `floor` scenario
    // — which is `createNoydb` with nothing opted in — is checked against them
    // below. If a future change makes the kernel reference the accounting
    // engine directly, `floor` grows and this list catches it.
    reachableCanaries: [],
  },
  {
    name: 'all-on',
    description: 'every published with*() factory actually enabled (upper bound)',
    // #1381 — this scenario is the one a reviewer reads to sanity-check total
    // cost, so it has to be an honest upper bound rather than a hand-kept
    // sample. Two properties make it that, and `assertAllOnCoversEveryFactory`
    // below enforces the first mechanically:
    //
    //   1. EVERY `with*()` factory the package exports appears here. Before
    //      #1381 twelve of forty-two did, so the row understated the cost of
    //      "everything on" by more than half the catalog.
    //   2. Each factory is CALLED and its result is WIRED IN — passed to
    //      `createNoydb`, nested inside the strategy that consumes it, or
    //      composed into the store. Re-exporting a factory retains that one
    //      function; it does not link the engine a nested opt-in reaches.
    //      `withReduce({ window: withWindow() })` is the case #1349 found, and
    //      `withRollup` / `withDeferredNumbering` / the six store middlewares
    //      are the same shape — a capability with no `createNoydb` slot of its
    //      own can only be measured by writing the call a consumer writes.
    //
    // The program is never executed, only bundled, so the argument values are
    // chosen to read like a real consumer's, not to be semantically meaningful.
    code: `
      import {
        createNoydb, memoryStore,
        withArchive, withDeferredNumbering,
      } from '@noy-db/hub'
      import {
        wrapStore,
        withRetry, withLogging, withMetrics,
        withCircuitBreaker, withCache, withHealthCheck,
      } from '@noy-db/hub/store'
      import { withHistory } from '@noy-db/hub/history'
      import { withVaultHead } from '@noy-db/hub/vault-head'
      import { withCrdt } from '@noy-db/hub/crdt'
      import { withSequence } from '@noy-db/hub/sequence'
      import { withTransactions } from '@noy-db/hub/transactions'
      import { withI18n } from '@noy-db/hub/i18n'
      import { withBlobs } from '@noy-db/hub/blobs'
      import { withClassified } from '@noy-db/hub/classified'
      import { withIndexing } from '@noy-db/hub/indexing'
      import { withReduce, withWindow } from '@noy-db/hub/reduce'
      import { withSearch, withVectorIndex } from '@noy-db/hub/search'
      import { withSession } from '@noy-db/hub/session'
      import { withTeam } from '@noy-db/hub/team'
      import { withBroker } from '@noy-db/hub/broker'
      import { withCustody } from '@noy-db/hub/custody'
      import { withSync } from '@noy-db/hub/sync'
      import { withConsent } from '@noy-db/hub/consent'
      import { withCoverage } from '@noy-db/hub/coverage'
      import { withPeriods } from '@noy-db/hub/periods'
      import { withForget } from '@noy-db/hub/forget'
      import { withTiers } from '@noy-db/hub/tiers'
      import { withAttestation } from '@noy-db/hub/attestation'
      import { withSealedRecord } from '@noy-db/hub/sealed-record'
      import { withPortability } from '@noy-db/hub/portability'
      import { withShadow } from '@noy-db/hub/shadow'
      import { withSnapshots } from '@noy-db/hub/snapshots'
      import { withLazy } from '@noy-db/hub/lazy'
      import { withCargo } from '@noy-db/hub/cargo'
      import { withFormats } from '@noy-db/hub/as'
      import { withGuard } from '@noy-db/hub/guards'
      import { withDerivation, withRollup } from '@noy-db/hub/derivations'
      import { withMaterializedView } from '@noy-db/hub/materialized-views'
      import { withOverlayedView } from '@noy-db/hub/overlay-views'

      // Store middleware is opt-in capability with a real size, and it has no
      // createNoydb slot — it is composed onto the store itself.
      const store = wrapStore(
        memoryStore(),
        withRetry(), withLogging(), withMetrics(),
        withCircuitBreaker(), withCache(), withHealthCheck(),
      )

      export const db = createNoydb({
        store, user: 'u', secret: 's',
        archiveStrategy: withArchive({ store: memoryStore() }),
        blobsStrategy: withBlobs(),
        indexingStrategy: withIndexing(),
        // The nested opt-in #1349 introduced. Passing withReduce() alone
        // measures a build with the window engine tree-shaken out.
        reduceStrategy: withReduce({ window: withWindow() }),
        searchStrategy: withSearch(),
        crdtStrategy: withCrdt(),
        tiersStrategy: withTiers(),
        consentStrategy: withConsent(),
        coverageStrategy: withCoverage({ collections: { clients: { corpusSize: 1000 } } }),
        periodsStrategy: withPeriods(),
        shadowStrategy: withShadow(),
        snapshotsStrategy: withSnapshots({ store: memoryStore() }),
        transactionsStrategy: withTransactions(),
        historyStrategy: withHistory(),
        vaultHeadStrategy: withVaultHead(),
        forgetStrategy: withForget({ subjects: { people: 'subjectId' } }),
        sessionStrategy: withSession(),
        syncStrategy: withSync(),
        attestationStrategy: withAttestation(),
        classifiedStrategy: withClassified(),
        sealedRecordStrategy: withSealedRecord(),
        portabilityStrategy: withPortability(),
        sequenceStrategy: withSequence(),
        custodyStrategy: withCustody(),
        teamStrategy: withTeam(),
        brokerStrategy: withBroker({ brokerId: 'b', endpoint: 'https://broker.example.com' }),
        lazyStrategy: withLazy(),
        cargoStrategy: withCargo(),
        i18nStrategy: withI18n(),
        formatsStrategy: withFormats(),
        // Declaration helpers: no strategy slot of their own, so they reach
        // the vault only through one of these arrays.
        guardStrategies: [withGuard({ collection: 'invoices' })],
        numbering: [withDeferredNumbering({
          series: 'inv', collection: 'invoices', field: 'number',
        })],
        derivationStrategies: [
          withDerivation({ source: 'invoices', outputs: { lines: () => [] } }),
          withRollup({
            from: 'lines', key: 'invoiceId', into: 'invoices',
            field: 'total', compute: () => 0,
          }),
        ],
        materializedViewStrategies: [
          withMaterializedView({ name: 'mv', projection: { from: 'invoices' } }),
        ],
        overlayedViewStrategies: [
          withOverlayedView({ name: 'ov', base: 'mv' }),
        ],
      })

      // #1360 part 2 — the approximate vector index is neither a createNoydb
      // slot nor a nested strategy option: it is declared PER COLLECTION, as
      // \`embeddings.index\`. A third shape, and the reason this guard matches
      // on the factory NAME rather than on the createNoydb call — a capability
      // can be published, real, and reachable through none of the shapes a
      // scenario would naturally enumerate. Exported so nothing is shaken out.
      export const embeddings = {
        dim: 8, model: 'stub', source: 'text',
        encode: async () => new Float32Array(8),
        index: withVectorIndex(),
      }
    `,
    leakCanaries: [],
  },
]

/**
 * #1381 guard — the `all-on` scenario must reference every `with*()` factory
 * the package publishes.
 *
 * The class this closes is structural, not a one-off: a capability reachable
 * only through a NESTED opt-in (`withReduce({ window: withWindow() })`,
 * `derivationStrategies: [withRollup(...)]`, `wrapStore(store, withRetry())`)
 * owns no `createNoydb` slot and no subpath of its own, so nothing about
 * adding one forces anybody to touch this file. `all-on` then keeps reporting
 * a number that is correct for what it builds and wrong for what it is named,
 * and — worse — a capability invisible here cannot regress here.
 *
 * The authority is the built `dist` reached through the package's own
 * `exports` map: what a consumer can actually import, measured rather than
 * transcribed. A new factory that ships without being added to the scenario
 * fails the bundle-check gate.
 *
 * There is deliberately NO allowlist. If a factory genuinely cannot be
 * enabled alongside the rest, add the allowlist together with the first entry
 * that needs it and record the reason on that entry — an empty escape hatch
 * invites use before anyone has to justify one.
 */
async function assertAllOnCoversEveryFactory() {
  const scenario = SCENARIOS.find((s) => s.name === 'all-on')
  const factories = new Map() // factory name -> the subpath that publishes it
  for (const [subpath, target] of Object.entries(HUB_EXPORT_TARGETS)) {
    const mod = await import(pathToFileURL(target).href)
    for (const name of Object.keys(mod)) {
      if (!/^with[A-Z]/.test(name)) continue
      // Prefer the dedicated subpath over the root barrel in the message.
      if (!factories.has(name) || subpath === '.') factories.set(name, subpath)
      if (subpath !== '.' && factories.get(name) === '.') factories.set(name, subpath)
    }
  }

  const missing = [...factories]
    .filter(([name]) => !new RegExp(`\\b${name}\\b`).test(scenario.code))
    .map(([name, subpath]) => `${name}()  —  @noy-db/hub${subpath === '.' ? '' : subpath.slice(1)}`)

  if (missing.length > 0) {
    console.error(
      `\n✗ The 'all-on' scenario does not enable every published capability (#1381).\n\n` +
      `  Missing:\n` +
      missing.map((m) => `    ${m}`).join('\n') +
      `\n\n  'all-on' is the row a reviewer reads as "what a consumer pays with\n` +
      `  everything enabled", so a factory absent from it makes that number\n` +
      `  wrong for its own name — and makes the capability unable to regress\n` +
      `  in any scenario. Add the factory to the scenario and CALL it, wiring\n` +
      `  the result into createNoydb (or into whatever consumes it: a nested\n` +
      `  strategy option, a declaration array, the store). Re-exporting the\n` +
      `  factory retains one function and links none of its engine.\n\n` +
      `  Then re-baseline: BUNDLE_BASELINE_UPDATE=1 pnpm --filter @noy-db/hub bundle-check\n`,
    )
    process.exit(1)
  }

  return factories.size
}

async function buildScenario(scenario) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'noy-db-bundle-'))
  const entry = join(tmpDir, 'entry.mjs')
  const outdir = join(tmpDir, 'out')

  writeFileSync(entry, scenario.code)

  // Resolve @noy-db/hub through the workspace's hub dist directly.
  // We use --packages=external for everything else so the measurement
  // reflects only @noy-db/hub's contribution to the consumer bundle.
  //
  // `splitting: true` is REQUIRED for accurate measurement after #130
  // — the hub now uses dynamic `import()` to defer guard + derivation
  // class loading. Without splitting, esbuild inlines those imports
  // into the entry chunk and the floor measurement counts code that a
  // real consumer bundler (Vite, webpack, esbuild-with-splitting,
  // Rollup) would emit as a separate chunk loaded on demand. We
  // measure only the entry chunk's size; the split chunks live in
  // their own files and aren't charged against the floor.
  await build({
    entryPoints: [entry],
    outdir,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    treeShaking: true,
    splitting: true,
    nodePaths: [join(HUB_DIR, '..', '..', 'node_modules')],
    alias: HUB_ALIAS,
    logLevel: 'silent',
  })

  // Measure the entry chunk only — what a consumer's "open createNoydb"
  // route actually loads. Dynamic-import chunks are loaded on demand
  // when the consumer reaches code that registers a guard / derivation.
  const minified = readFileSync(join(outdir, 'entry.js'))
  const gzipped = gzipSync(minified)

  // Cross-leak detection runs against the un-gzipped, un-minified
  // ENTRY chunk only so canary class names survive AND we don't
  // false-positive on classes that legitimately live in a
  // dynamic-import chunk (the whole point of code splitting). A leak
  // is a class statically reachable from the entry — anything in a
  // split chunk is loaded on demand and not a cross-leak.
  const probeDir = join(tmpDir, 'probe')
  await build({
    entryPoints: [entry],
    outdir: probeDir,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: false,
    treeShaking: true,
    splitting: true,
    nodePaths: [join(HUB_DIR, '..', '..', 'node_modules')],
    alias: HUB_ALIAS,
    logLevel: 'silent',
  })
  const probe = readFileSync(join(probeDir, 'entry.js'), 'utf8')

  const leaks = scenario.leakCanaries.filter((canary) =>
    probe.includes(canary),
  )

  // Reachable-chunk canaries — the check that answers "does this consumer SHIP
  // this code at all", which neither of the two above can.
  //
  // The entry-only checks stop at `entry.js`. That is exactly wrong for a
  // subsystem that is itself lazily loaded: `withSearch()` already defers the
  // whole retrieval facade behind a dynamic import, so a symbol could sit in a
  // chunk this consumer loads on its first `retrieve()` and every entry-scoped
  // canary would still read green.
  //
  // So this walks the module graph from `entry.js`, following BOTH static and
  // dynamic import specifiers — a dynamically imported chunk is deferred, not
  // absent, and it is still bytes on the consumer's disk and in their network
  // waterfall. Chunks NOT reachable from the entry are excluded deliberately:
  // esbuild materialises a chunk file for every `import()` it parses, including
  // ones inside a function it subsequently tree-shakes away, so an orphan file
  // in the output directory is dead output rather than a consumer cost. The
  // discriminator is reachability, not existence.
  const reachableCanaries = scenario.reachableCanaries ?? []
  if (reachableCanaries.length > 0) {
    const seen = new Set()
    const queue = ['entry.js']
    const sources = []
    while (queue.length > 0) {
      const file = queue.shift()
      if (seen.has(file)) continue
      seen.add(file)
      let text
      try { text = readFileSync(join(probeDir, file), 'utf8') } catch { continue }
      sources.push([file, text])
      for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.\/[^"']+\.js)["']/g)) {
        queue.push(m[1].slice(2))
      }
    }
    for (const canary of reachableCanaries) {
      const hit = sources.find(([, text]) => text.includes(canary))
      if (hit !== undefined) leaks.push(`reachable:${canary} (in ${hit[0]})`)
    }
  }

  // ⭐ #1458 — THE INVERSE ASSERTION, and the reason the query-tier scenarios
  // come in pairs. `reachableCanaries` can only say a symbol is ABSENT, and
  // absence has two causes: the tree-shake worked, or the feature was never
  // wired at all. A scenario that imports `@noy-db/hub/query/relate` and STILL
  // does not reach `applyJoins` is a broken side-effect import — silently, and
  // in exactly the shape a `sideEffects` mistake produces.
  //
  // So a control scenario names what it MUST reach, and its absence is a
  // failure reported through the same channel. This is not a size check; it is
  // what stops the size check passing for the wrong reason.
  const requiredReachable = scenario.requiredReachable ?? []
  if (requiredReachable.length > 0) {
    const seen = new Set()
    const queue = ['entry.js']
    const sources = []
    while (queue.length > 0) {
      const file = queue.shift()
      if (seen.has(file)) continue
      seen.add(file)
      let text
      try { text = readFileSync(join(probeDir, file), 'utf8') } catch { continue }
      sources.push([file, text])
      for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.\/[^"']+\.js)["']/g)) {
        queue.push(m[1].slice(2))
      }
    }
    for (const required of requiredReachable) {
      if (!sources.some(([, text]) => text.includes(required))) {
        leaks.push(`MISSING:${required} — the side-effect import did not bring it`)
      }
    }
  }

  // Eager-import scan — extract the top-level `import { ... } from
  // "./chunk-…"` prologue and look for any banned symbol name. Under
  // `splitting: true` this is the only place a static-vs-dynamic
  // regression shows up in the entry chunk (the symbol's definition
  // lives in a separate chunk file and never enters entry.js, so the
  // literal-pattern canaries above can't see it).
  const eagerImports = scenario.eagerImports ?? []
  if (eagerImports.length > 0) {
    // The prologue is every top-level `import` statement (possibly
    // multi-line) at the head of the file. Esbuild always emits these
    // before any function/class/const declarations. We walk the file
    // line-by-line tracking brace depth inside an open `import {` block
    // so multi-line specifier lists count as part of the prologue.
    const lines = probe.split('\n')
    let prologueEnd = 0
    let inImportBlock = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (inImportBlock) {
        prologueEnd = i + 1
        if (line.includes('}')) inImportBlock = false
        continue
      }
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        prologueEnd = i + 1
        continue
      }
      if (trimmed.startsWith('import')) {
        prologueEnd = i + 1
        if (trimmed.includes('{') && !trimmed.includes('}')) inImportBlock = true
        continue
      }
      break
    }
    const prologue = lines.slice(0, prologueEnd).join('\n')
    for (const symbol of eagerImports) {
      // Match the symbol as a standalone identifier inside the
      // braces of an import specifier list (allowing trailing commas
      // and `as` aliases).
      const re = new RegExp(`^\\s*${symbol}(?:\\s*,|\\s+as\\s+\\w+|\\s*$)`, 'm')
      if (re.test(prologue)) leaks.push(`eager-import:${symbol}`)
    }
  }

  rmSync(tmpDir, { recursive: true, force: true })

  return {
    minifiedBytes: minified.length,
    gzippedBytes: gzipped.length,
    leaks,
  }
}

async function main() {
  const update = process.env.BUNDLE_BASELINE_UPDATE === '1'

  // Ensure the hub is built first.
  if (!existsSync(join(HUB_DIR, 'dist', 'index.js'))) {
    console.error('No dist/ found — run `pnpm --filter @noy-db/hub build` first.')
    process.exit(1)
  }

  // Runs BEFORE any measurement, and before the baseline-update path: a
  // manifest blessed from a scenario that is missing a capability writes the
  // under-report into the repo as the new truth.
  const factoryCount = await assertAllOnCoversEveryFactory()

  const manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { scenarios: {} }

  const results = {}
  let failures = 0
  // Tracked separately from `failures` so `BUNDLE_BASELINE_UPDATE=1` can accept
  // an intentional SIZE change while still refusing to bless a cross-leak. The
  // guard below used to test `failures === 0`, which made the documented
  // baseline-update path unusable for the one case it exists for — the failure
  // output tells you to run it, and it then refused, citing leaks that were not
  // there.
  let leakFailures = 0

  console.log('\n📦 Bundle-size invariants — v0.25 catalog')
  console.log(`   all-on enables all ${factoryCount} published with*() factories (#1381)\n`)
  console.log(
    `  ${'scenario'.padEnd(14)} ${'min'.padStart(8)} ${'gz'.padStart(8)}` +
    `   leaks    baseline (gz)   delta`,
  )
  console.log('  ' + '─'.repeat(74))

  for (const scenario of SCENARIOS) {
    const result = await buildScenario(scenario)
    results[scenario.name] = {
      minifiedBytes: result.minifiedBytes,
      gzippedBytes: result.gzippedBytes,
    }

    const baseline = manifest.scenarios?.[scenario.name]?.gzippedBytes
    let deltaPct = baseline
      ? ((result.gzippedBytes - baseline) / baseline) * 100
      : null
    let status = ''

    // Cross-leak check
    if (result.leaks.length > 0) {
      status = `❌ LEAKED: ${result.leaks.join(', ')}`
      failures++
      leakFailures++
    } else if (baseline && deltaPct > TOLERANCE_PCT
      && (result.gzippedBytes - baseline) > TOLERANCE_MIN_BYTES) {
      status = `❌ +${deltaPct.toFixed(1)}% / +${result.gzippedBytes - baseline}B `
        + `(over ${TOLERANCE_PCT}% AND ${TOLERANCE_MIN_BYTES}B)`
      failures++
    } else if (baseline && deltaPct !== null) {
      status = `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`
    } else {
      status = '(no baseline yet)'
    }

    console.log(
      `  ${scenario.name.padEnd(14)} ` +
      `${result.minifiedBytes.toLocaleString().padStart(8)} ` +
      `${result.gzippedBytes.toLocaleString().padStart(8)}   ` +
      `${result.leaks.length === 0 ? '  ✓ ' : '  ✗ '} ` +
      `  ${baseline ? baseline.toLocaleString().padStart(10) : '       n/a'}   ${status}`,
    )
  }

  console.log()

  if (update) {
    if (leakFailures === 0 || process.env.BUNDLE_BASELINE_FORCE === '1') {
      const newManifest = {
        ...manifest,
        scenarios: results,
        updatedAt: new Date().toISOString(),
      }
      writeFileSync(MANIFEST_PATH, JSON.stringify(newManifest, null, 2) + '\n')
      console.log(`✓ Manifest updated: ${MANIFEST_PATH}\n`)
      process.exit(0)
    } else {
      console.error(
        '✗ Refusing to update manifest while leak failures are present.\n' +
        '  Fix the leaks first, or set BUNDLE_BASELINE_FORCE=1 to override.\n',
      )
      process.exit(1)
    }
  }

  if (failures > 0) {
    console.error(
      `✗ ${failures} bundle-size invariant${failures === 1 ? '' : 's'} failed.\n` +
      '  Investigate the regressions above. If the change is intentional,\n' +
      '  run `BUNDLE_BASELINE_UPDATE=1 pnpm --filter @noy-db/hub bundle-check`\n' +
      '  to accept the new baseline.\n',
    )
    process.exit(1)
  }

  console.log('✓ All bundle-size invariants pass.\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
