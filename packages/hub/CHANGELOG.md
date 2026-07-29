# Changelog — hub

## 0.4.0-pre.11

### Patch Changes

- Fix `wrapPodStore`: concurrent writes were lost, and `loadAll` leaked internal collections (#908)

  `wrapPodStore()` is the single choke point through which every pod-shaped backend
  (`@noy-db/to-drive`, `@noy-db/to-icloud`) enters the six-method store contract. It failed that
  contract on two counts, both reproducible against any `NoydbPodStore` — neither was store-specific.

  **Concurrent `put()`s lost writes.** 100 racing puts kept **one** record. `load()` had no in-flight
  deduplication, so every concurrent caller issued its own `readBundle` and then _replaced_ the shared
  snapshot with a freshly parsed object — orphaning the mutations earlier callers had already made to
  the object they were handed. `flush()` then serialised the surviving object, not theirs.

  Loads are now deduplicated per vault, and flushes are serialised through a per-vault chain so each
  one sees the version token its predecessor produced. Previously, concurrent flushes all sent the
  same `expectedVersion`; the losers took the conflict/merge path, and with enough of them the
  3-attempt retry budget was exhausted and the error surfaced to a caller whose write was valid.

  **`loadAll()` leaked internal collections** — `_keyring` and `_sync` appeared in vault snapshots.
  The store contract requires excluding `_`-prefixed collections, with `@noy-db/to-file` as the
  reference. `get()` and `list()` still serve them: this is about what a _snapshot_ claims, not about
  hiding data.

  `loadAll()` also returned the wrapper's **live internal object**, so a caller mutating the result
  silently rewrote the wrapper's cache. It now returns a copy.

  Found by wiring the extended stores into the adapter-conformance harness
  ([noy-db-to#26](https://github.com/vLannaAi/noy-db-to/issues/26)) — the wrapper is where
  `to-drive` and `to-icloud` were failing the shared suite.

## 0.4.0-pre.10

### Minor Changes

- Sync: a declared `syncPolicy` now actually runs (#897), and its scheduled pull is role-gated (#618)

  **The bug.** `SyncScheduler` was constructed but never started. `startScheduler()` had no
  callers anywhere in the codebase, and `SyncScheduler.notifyChange()` opens with
  `if (!this.started) return` — so every write hit that guard and returned. The result: no
  automatic sync existed at any policy. Declaring `syncPolicy: { push: { mode: 'on-change' } }`
  was silently equivalent to declaring nothing; you had to call `db.push()` / `db.pull()`
  yourself regardless.

  **What changes.** Opening a vault now starts the scheduler when a policy was **declared** —
  either `createNoydb({ syncPolicy })` or a per-target `policy`. `close()` stops every
  scheduler's timers alongside the other teardown.

  If you declared a policy expecting it to be inert, it is now live. To keep the old behaviour
  explicitly:

  ```ts
  syncPolicy: { push: { mode: 'manual' }, pull: { mode: 'manual' } }
  ```

  **Passing `sync:` alone still does not sync on its own.** A policy is always _resolved_
  (falling back to the store preset, e.g. `INDEXED_STORE_POLICY`), but resolving one is not
  consent: `push: 'on-change'` fires an **unawaited** push on every write, so enabling it for
  everyone who merely supplied a remote would turn on unattended background writes and make
  write ordering racy against anything else touching that remote. Automation is opt-in; declare
  a policy to get it.

  Two further fixes:

  - The scheduler is now built when **either** push or pull is non-manual. The construction
    test was `push.mode !== 'manual'` alone, so `{ push: manual, pull: interval }` silently got
    no scheduler and its pull mode was ignored entirely.
  - **#618** — the scheduler-initiated pull is role-gated to `sync-peer`. `Noydb` gates
    pull-from-sink for explicit calls, but the scheduler calls the engine directly and bypassed
    it, so a backup/archive target with an `interval` or `on-focus` pull policy would pull
    ungated and reintroduce #616. An explicit `engine.pull()` is unaffected and still pulls for
    every role.

- Sync: per-collection readiness for phased pull (#809)

  Under a phased pull, a `null` from `get()` is ambiguous — is the record absent, or has its
  collection not arrived yet? Apps had to choose between showing a false empty state and blocking on
  the whole bootstrap.

  `db.syncStatus(vault)` now reports readiness per collection while a `'phased'` policy runs:

  ```ts
  const inv = await invoices.get("inv-1");
  const { readiness, phase } = db.syncStatus("acme");

  if (inv === null && readiness?.get("invoices") !== "live") showSkeleton();
  else if (inv === null) showNotFound();

  // phase: { index: 2, total: 3 } while the sequence runs, null once it drains
  ```

  - `'cold'` — not pulled yet, or its phase did not complete cleanly. A miss proves nothing.
  - `'pulling'` — its phase is in flight. **Never terminal**: a phase always ends `'live'` or back in
    `'cold'`, because a stuck `'pulling'` would leave a permanent skeleton.
  - `'live'` — its phase completed cleanly, so a miss **is** a real absence.

  Only a clean phase reaches `'live'`. A pull that reports errors (`PullResult.errors` accumulates
  without throwing), one that throws, and one skipped by the role gate on a backup/archive target all
  leave the collection `'cold'` — completeness is never claimed on a target that never read. `stop()`
  resets any in-flight `'pulling'`, so no skeleton outlives the vault.

  A collection the sequence never names is **absent** from the map: `undefined` means _"no claim
  made"_, never a reason to gate a UI.

  Additive and opt-in. `readiness` and `phase` are optional on `SyncStatus` and absent for every
  non-phased policy, `get()` is untouched — no per-read cost, no mode-dependent return type — and the
  kernel orchestration files are byte-identical, since `syncStatus()` already delegated to the sync
  engine. `ReadinessState` is exported from the root barrel.

- Sync: `pull.mode: 'phased'` — pull collections in a declared order (#809)

  `PullPolicy` could say _when_ to pull, never _in what order_. A thin client that wants its
  navigation-critical collections before bulk history had to orchestrate that itself, outside the
  policy that already does the scheduling.

  ```ts
  const db = await createNoydb({
    store: toBrowserIdb(),
    sync: toAwsS3({ bucket, client }),
    user,
    secret,
    syncStrategy: withSync(),
    syncPolicy: {
      push: { mode: "on-change", minIntervalMs: 0, onUnload: true },
      pull: {
        mode: "phased",
        sequence: ["clients", "invoices", "attachments"],
      },
    },
  });
  ```

  The scheduler walks `sequence` **one collection at a time, in order**, each phase an ordinary
  `pull({ collections: [name] })` — phasing is sequencing, not new pull capability. Phases are
  strictly sequential; running them concurrently would defeat the prioritisation that is the point.
  A phase that fails does not abort the ones behind it.

  When the sequence drains, the scheduler **settles into steady state**: `pull.intervalMs` if you
  gave one, otherwise idle. Bootstrap and steady-state sync are one flow, not two APIs.

  `sequence` entries must be unique and non-empty, and `sequence` is rejected unless
  `mode === 'phased'`. An unusable policy throws when the scheduler is constructed, before any sync
  I/O, rather than failing silently on the first tick.

  Additive: `'phased'` is a new `PullMode` and `sequence` a new optional field. Existing policies are
  untouched, and a phased policy is by definition _declared_, so it starts under the
  declared-policy rule from #897 with no further wiring.

  **Period-scoped phases (`collection@period`) are deferred**, not rejected — the granularity here is
  db / vault / collection. `db.pull(vault, { periods })` remains available explicitly.

- Sync now lives in its own `with-sync/` layer rather than under `with-party/` (#895).

  `with-party/` describes **principals** — who you are, what you may do, how you prove it. Sync
  replicates state between **stores and contexts**, which is a different concern. Roughly 2,261 lines
  were filed under the wrong one, including `tab-coordination` and `tab-write-relay`, which coordinate
  browser tabs of the _same_ user and are not about principals at all.

  **Breaking, but narrow:** `@noy-db/hub/team` no longer re-exports `SyncEngine`, `SyncTransaction`,
  `PresenceHandle`, or the `_sync_credentials` helpers (`putCredential`, `getCredential`,
  `deleteCredential`, `listCredentials`, `credentialStatus`, `SYNC_CREDENTIALS_COLLECTION`,
  `SyncCredential`). They ship from the long-standing `@noy-db/hub/sync` subpath, which is unchanged:

  ```diff
  - import { SyncEngine } from '@noy-db/hub/team'
  + import { SyncEngine } from '@noy-db/hub/sync'
  ```

  `@noy-db/hub/sync` itself, `withSync()`, `NO_SYNC`, and every root-barrel export are unchanged. No
  behaviour changes.

  Removing the duplicate home also closed 5 type-reachability gaps that existed only because those
  helpers were reachable two ways.

## 0.4.0-pre.9

### Minor Changes

- **`@noy-db/hub` — the transaction revert pass is now atomic when the store supports it (#886).**

  `runTransaction`'s rollback previously unwound leg by leg, best-effort, so a crash mid-revert could
  leave a vault half-unwound. When the store declares `capabilities.txAtomic` and implements `tx()`,
  the whole revert is now submitted as one storage-layer operation instead.

  This works because the revert legs already carry **raw prior envelopes** captured before the write —
  exactly the shape `tx()` wants, with none of the Collection-layer machinery that makes delegating
  the _forward_ write path a much larger job (still tracked in #886).

  Failure stays best-effort: a rejected batch falls back to the per-leg loop rather than surfacing a
  revert-path error, because a revert failure must never mask the original error that triggered it.
  An **undeclared** `tx()` is never used, matching the implemented ⇒ declared rule the conformance
  harness enforces.

  **`@noy-db/to-meter` — `listVaults()` and `ping()` are now metered (#889).**

  Both previously passed through the wrap untimed. `listVaults` is a full enumeration on a remote
  store, and `ping` isolates round-trip time from work — arguably the most useful latency signal on a
  network-backed store. The synthetic `liveness` poller still calls the inner store directly, so the
  counters stay "what the app did".

## 0.4.0-pre.8

### Patch Changes

- `computed()` now installs its own via binder (#813).

  Every via declaration factory is the binding's opt-in unit: constructing a descriptor must leave
  the binder installed in whatever module instance produced it. `money()` and `lookup()` always did
  this. `computed()` did not — its binder was installed by a _different_ module
  (`port/with/computed-strategy.ts`), which the kernel spine happens to import.

  That holds whenever the consumer's `computed` import and the kernel spine resolve to one module
  instance, and breaks when they do not. Running vitest with `server.deps.inline: [/@noy-db\/.*/]`
  produced exactly that split: `isComputedDescriptor()` accepted the descriptor while the binder
  registry consulted at bind time — a different transformed instance — had no `computed` entry,
  failing with `via feature "computed" requires descriptors created via its declaration factory`.
  `moneyFields` / `i18nFields` / `dictKeyFields` were immune under the same config purely because
  they self-link.

  No API change. `installViaBinder` is idempotent and first-wins, so the existing eager call is
  unaffected.

## 0.4.0-pre.7

### Minor Changes

- Close the last service-subpath naming gaps and enforce the contract mechanically (#843).

  **Breaking: `@noy-db/hub/tx` is now `@noy-db/hub/transactions`.**

  ```diff
  - import { withTransactions } from '@noy-db/hub/tx'
  + import { withTransactions } from '@noy-db/hub/transactions'
  ```

  Nothing else about transactions changes — `withTransactions()`, `TransactionsStrategy`, and the
  `transactionsStrategy` option are unchanged. This was the one service where the naming contract
  did not hold: #844 named the types from the subpath `SERVICES.md` documented (`/transactions`),
  which had never actually shipped.

  **New subpaths** for three capabilities that already had a complete
  `strategy.ts` + `active.ts` + `NO_*` seam but shipped reachable only from the root barrel. Their
  exports are unchanged — they are simply importable from a themed subpath now, and tree-shake
  accordingly:

  - `@noy-db/hub/search` — `withSearch()`, `NO_SEARCH`, `SearchStrategy`
  - `@noy-db/hub/sequence` — `withSequence()`, `NO_SEQUENCE`, `SequenceStrategy`
  - `@noy-db/hub/custody` — `withCustody()`, `NO_CUSTODY`, `CustodyStrategy`

  `withArchive` and `withLookup` deliberately keep no subpath; the reasons are recorded in
  `SERVICES.md`.

  **New guard:** `pnpm check:architecture` gains `service-subpath-naming`, which fails both when a
  `with<Name>()` factory has no matching subpath and when a subpath has no factory producing it.

- Remove 30 hub-internal team symbols from the public root barrel (#843 C2).

  The team module exported 42 symbols reachable from no entry other than `@noy-db/hub` itself —
  crypto, recovery, delegation and tier plumbing that was never meant to be public API.

  **Removed** (no consumer outside the hub): `keyringRecoverSecret`, `DEED_RECORD_ID`,
  `hasRecoveryEnrolled`, the four `*ShamirRecoveryEntr*` helpers, `PaperRecoveryDoc`,
  `ShamirRecoveryEntry`, `ShamirRecoveryDoc`, `EnrollRecoveryResult`, `RotateRecoveryOptions`,
  `RotateRecoveryResult`, `SealedSecret`, `SealedEnvelope`, `loadSealedSecret`, `saveSealedSecret`,
  `parseSealedEnvelope`, `SEALED_SECRET_RECORD_ID`, `dekKey`, `effectiveClearance`,
  `assertTierAccess`, the whole delegation surface (`DelegationToken`, `IssueDelegationOptions`,
  `DELEGATIONS_COLLECTION`, `issueDelegation`, `loadActiveDelegations`, `revokeDelegation`),
  `MAGIC_LINK_CONTENT_INFO_PREFIX` and `MAGIC_LINK_KEK_INFO_PREFIX`.

  **Explicitly retained** — these are the `at-*`/`on-*` SPI, not internals, and are now identified
  as contract rather than sitting on the barrel by default: `sealRsaOaepTlv`, `parseRsaOaepTlv`,
  `aesGcmOpen`, `RecipientHint`, `RecipientSealer`, `SealingKeyProvider`, `MemorySealingKeyProvider`,
  `MemoryRecipientSealer`, `ShamirRecoveryProvider`, `keyringRotateSecret`, `MagicLinkGrantPayload`,
  `MagicLinkGrantRecord`, `IssueMagicLinkGrantOptions`, `MAGIC_LINK_GRANTS_COLLECTION`.

  If you were importing one of the removed symbols, it was hub-internal plumbing — please open an
  issue describing the use case so it can be given a supported home.

  Root barrel: **874 → 844** symbols.

- Four more themed subpaths, completing #843(c):

  - **`@noy-db/hub/cover`** — vault cover record: schema, storage, validation
  - **`@noy-db/hub/schema-update`** — `SchemaDelta` plus the `blindUpdate` / `additiveOnly` / `lockSchema` strategies
  - **`@noy-db/hub/policy`** — gate policy presets, engine and storage
  - **`@noy-db/hub/directory`** — directory config, user visibility, and the user-envelope surface

  `@noy-db/hub/introspection` (added in the previous release) gains the eight symbols it was missing:
  `SchemaIntrospection`, `FieldMeta`, `SemanticType`, `CollectionDescription`, `DescribedField`,
  `DescribeOptions`, `applyListProjection`, `ListProjectionOptions`.

  `@noy-db/hub/team` gains the auth-config introspection functions `describeAuthConfig`,
  `diagramAuthConfig`, `describeUserAuth` and `describeAllUsersAuth` — they are part of the
  `db.team.*` facade.

  **Nothing is removed.** Every symbol remains available from `@noy-db/hub`; the subpaths exist so
  the surface is navigable and tree-shakeable.

- Three new subpaths for symbols that previously had no home but the root barrel (#843 C3a):

  - **`@noy-db/hub/store`** — `routeStore`, `wrapStore`, and the six `StoreMiddleware` factories
    (`withRetry`, `withLogging`, `withMetrics`, `withCircuitBreaker`, `withCache`, `withHealthCheck`)
  - **`@noy-db/hub/introspection`** — `dumpVaultSchema` plus the describe/meta descriptor types
  - **`@noy-db/hub/money`** — the `money()` field descriptor and its arithmetic helpers

  **Nothing is removed.** Each symbol is still re-exported from `@noy-db/hub`, matching how
  `@noy-db/hub/classified` and `@noy-db/hub/i18n` have always been dual-homed. The subpaths exist so
  the surface is navigable and tree-shakeable — importing from one lets a bundler drop the rest.

  ```ts
  import { money } from "@noy-db/hub/money"; // new, tree-shakeable
  import { money } from "@noy-db/hub"; // still works
  ```

- Conform the `with*()` service catalog to one naming contract (#844, #846b), and write that
  contract into `SERVICES.md` as a governance rule so it stops drifting.

  **The rule: the subpath is canonical.** `@noy-db/hub/<name>` → `with<Name>()` → `<Name>Strategy`
  → `<name>Strategy:` option → `strategies.<name>` → `NO_<NAME>`.

  **Breaking — `createNoydb` option keys** (rename the key; the factory call is unchanged):

  | Before             | After                  |
  | ------------------ | ---------------------- |
  | `blobStrategy`     | `blobsStrategy`        |
  | `indexStrategy`    | `indexingStrategy`     |
  | `snapshotStrategy` | `snapshotsStrategy`    |
  | `txStrategy`       | `transactionsStrategy` |

  **Breaking — exported type names:** `BlobStrategy` → `BlobsStrategy`, `IndexStrategy` →
  `IndexingStrategy`, `SnapshotStrategy` → `SnapshotsStrategy`, `TxStrategy` →
  `TransactionsStrategy`, `TransactionStrategyOptions` → `WithTransactionsOptions`, `NO_TX` →
  `NO_TRANSACTIONS`. `BlobsService` is gone — `withBlobs()` now returns `BlobsStrategy`, which
  absorbed `cacheStats()`, so the service has exactly one name (`NO_BLOBS` answers with zeros).

  **Breaking — `withForgetCascade` is now `withForget`**, matching its `/forget` subpath.

  **Breaking — `Strategy` no longer means two opposite things.** For the four services you
  _declare_ rather than merely enable, the argument type is now `<Name>Spec` and the result is
  `<Name>Strategy` (was `<Name>Strategy` and `<Name>StrategyHandle` respectively):
  `GuardSpec`/`GuardStrategy`, `DerivationSpec`/`DerivationStrategy`,
  `MaterializedViewSpec`/`MaterializedViewStrategy`, `OverlayedViewSpec`/`OverlayedViewStrategy`.

  **Breaking — `@noy-db/hub/team` credential functions** take one trailing options object, and the
  first parameter is `store` everywhere (it was `adapter` in `keyring.ts` only):

  ```ts
  loadKeyring(store, vault, { userId, secret });
  createOwnerKeyring(store, vault, { userId, secret, validate });
  changeSecret(store, vault, keyring, { newSecret, allowWeakSecret });
  rotateKeys(store, vault, callerKeyring, { collections });
  ```

  The two same-typed positional strings on `loadKeyring`/`createOwnerKeyring` were a live
  transposition hazard the compiler could not catch; the options object removes it.

  **New:** `WithRollupOptions` and `WithDeferredNumberingOptions` — `withRollup` and
  `withDeferredNumbering` took inline object literals, so their argument types were unnameable.

  Non-breaking: `withBroker(config: BrokerConfig)` is unchanged and now recorded in `SERVICES.md`
  as a sanctioned exception — the argument is retained live configuration, not a factory bag.
  `with-store`'s middleware (`withRetry`, `withCache`, …) is likewise exempt: it returns
  `StoreMiddleware`, not a strategy.

## 0.4.0-pre.6

### Minor Changes

- **Every service's `NO_*` stub is now importable from that service's own subpath (#844).**

  The stubs are how you ask whether a service is actually enabled — the check is an identity comparison, exactly as `vault.forget()` does internally with `strategies.blob !== NO_BLOBS`. Several subpath docblocks recommend precisely that, but twelve of the stubs were exported from no entry a consumer could import, so the advice could not be followed:

  ```ts
  import { NO_SYNC } from "@noy-db/hub/sync"; // ← previously unresolvable

  if (db.strategies.sync !== NO_SYNC) {
    /* sync is really on */
  }
  ```

  Now exported from the subpath that owns each service: `NO_BLOBS` (`/blobs`), `NO_I18N` (`/i18n`), `NO_SESSION` (`/session`), `NO_HISTORY` (`/history`), `NO_CRDT` (`/crdt`), `NO_SHADOW` (`/shadow`), `NO_SNAPSHOTS` (`/snapshots`), `NO_SYNC` (`/sync`), `NO_INDEXING` (`/indexing`), `NO_AGGREGATE` (`/aggregate`), `NO_CONSENT` (`/consent`), `NO_PERIODS` (`/periods`).

  Purely additive. A test now walks the built declarations to keep it that way.

- **BREAKING: the `aggregate` service is now `reduce`, and its symbols have exactly one home (#843).**

  ```ts
  // before
  import { withAggregate, count, sum } from "@noy-db/hub"; // …or /query, or /aggregate
  createNoydb({ aggregateStrategy: withAggregate() });

  // after
  import { withReduce, count, sum } from "@noy-db/hub/reduce";
  createNoydb({ reduceStrategy: withReduce() });
  ```

  `./aggregate` becomes `./reduce`. Renamed with it: `withAggregate` → `withReduce`, `AggregateStrategy` → `ReduceStrategy`, `NO_AGGREGATE` → `NO_REDUCE`, `aggregateStrategy` → `reduceStrategy`, `Aggregation` → `Reduction`, `GroupedAggregation` → `GroupedReduction`, `AggregateSpec` → `ReduceSpec`, `AggregateResult` → `ReduceResult`, `buildLiveAggregation` → `buildLiveReduction`.

  "reduce" matches the vocabulary the service already used — `reduceRecords`, `reducerBuilder`, `groupAndReduce`.

  **The root barrel and `/query` no longer re-export any of it.** `count`, `sum`, `avg`, `min`, `max`, `moneySum`, `groupAndReduce`, `GroupedQuery` and the rest were reachable from three entries at once; they now have exactly one. Those re-exports were a backward-compatibility window left open after an earlier relocation, which the service's own documentation already described as superseded.

  `MinMaxState`, `MoneyString` and `MoneyDescriptor` are now exported from `/reduce` too — they appear in its signatures, so a caller needs them to annotate a result.

  Unaffected: derivation **rollup** aggregates. `ForgetResult.derivedAggregatesRecomputed` and the rollup vocabulary in `withRollup` are a different concept and keep their names.

- **Fixes a silent access-loss contract bug: `rotate()` now reports what it dropped (#854).**

  `Noydb.rotate(vault, collections)` documented that fresh DEKs are "re-wrapped into every remaining user's keyring" and that "every current member keeps access, but with fresh keys". The engine does the opposite — it deletes the rotated collections' DEK entries and permissions from every other member's keyring. An admin running the "just rotate, nobody is removed" path after a suspected leak locked their entire team out of those collections, with nothing in the API to indicate it.

  The engine is right and the documentation was wrong. A member's DEKs are wrapped under that member's KEK, and a KEK derives only from that member's own secret, so the caller cannot re-wrap a fresh DEK for anyone else. That is the zero-knowledge property working as intended; honouring the old wording would require a re-grant handshake against member public keys, which do not exist.

  **`rotate()` now returns `RotateResult`** instead of `void`:

  ```ts
  const { needsRegrant } = await db.rotate("acme", ["invoices"]);
  // needsRegrant → [{ userId: 'bob', collection: 'invoices' }]

  for (const { userId, collection } of needsRegrant) {
    // re-grant, or that member stays locked out
  }
  ```

  Members who never held a rotated collection are not reported. The caller is never reported — their own keyring is re-wrapped in place. `rotate()` still does not remove anyone from the vault; that remains `revoke()`.

  This is breaking only for callers who assigned the `void` return; ignoring it continues to work.

- **BREAKING: seven unused subpath entries removed, and six internals taken off the root barrel (#843).**

  The `./on`, `./at`, `./as`, `./by`, `./in`, `./with` and `./ui` subpaths were published as "port contracts" for satellite authors and had **zero importers**. Across the monorepo, satellites import `@noy-db/hub` (252×), `@noy-db/hub/team` (29×) and `@noy-db/hub/to` (9×) — and these seven not once. `/to` stays, because stores genuinely bind a narrow ciphertext contract that `check-architecture` enforces; the other six families never needed an equivalent.

  The exports map goes from 41 entries to 34. Anything that was reachable through one of the seven is still reachable from the root barrel.

  Also removed from the root barrel, as internal machinery that was never meant to be public API: `InternalCollectionStats`, `resetJoinWarnings`, `resetBrotliSupportCache`, `DebugPlaintextError`, `DebugReservedFieldError`, `readPlaintextRecord`. Each is still exported from its own module for internal use; none had a single import through the barrel.

  A side effect worth noting: the removed entries were exporting types that no entry made reachable, so this closes **13 type-reachability gaps** — the guard's baseline ratchets from 137 to 124.

  The root barrel still carries 472 values and 427 types, most reachable from no other entry. Classifying those, and pruning `/cargo`'s non-cargo re-exports, remain open under #843.

## 0.4.0-pre.5

### Minor Changes

- **BREAKING (type-level only): `vault.collection()` takes a named shape instead of positional generics (#839).**

  ```ts
  // before
  vault.collection<Invoice, "ssn", "clientId">("invoices");
  vault.collection<Sale, never, never, "amount" | "tax">("sales");

  // after
  vault.collection<Invoice, { sensitive: "ssn"; indexed: "clientId" }>(
    "invoices"
  );
  vault.collection<Sale, { money: "amount" | "tax" }>("sales");
  ```

  The positional tail `<T, S, Q, M>` was both unreadable and unsafe. `Q` (indexed fields) and `M` (money fields) are both `keyof T & string`, so swapping them type-checked silently and produced a collection narrowed on the wrong axis; and reaching `M` meant writing `never` placeholders for the two arguments before it.

  `CollectionShape<T>` names all three axes, every member optional. Omitting one keeps that axis permissive, exactly as passing `never` did.

  Runtime behaviour is unchanged — this is entirely type-level. Migration is mechanical: `<T, 'a'>` becomes `<T, { sensitive: 'a' }>`, `<T, never, 'b'>` becomes `<T, { indexed: 'b' }>`, `<T, never, never, 'c'>` becomes `<T, { money: 'c' }>`.

  `CollectionShape`, `SensitiveOf`, `IndexedOf` and `MoneyOf` are exported from the root barrel for callers who need to name the shape or extract an axis from it.

- **BREAKING: credential operations move to `db.team.*` (#846).**

  `Noydb` carried 23 methods that did nothing but restate a `TeamFacade` signature and forward to it. Every one had to be hand-kept in sync with its counterpart, and adding a credential operation meant editing two signatures for one capability. The facade is now exposed directly:

  ```ts
  // before
  await db.rotatePassphrase(vault, userId, input);
  await db.enrollRecovery(vault, enrollment);

  // after
  await db.team.rotatePassphrase(vault, userId, input);
  await db.team.enrollRecovery(vault, enrollment);
  ```

  Affected: `enrollAuthenticator`, `removeAuthenticator`, `listAuthenticators`, `updateAuthenticator`, `enrollWebAuthn`, `listWebAuthnSlots`, `unlockViaAuthenticator`, `describeAuthConfig`, `diagramAuthConfig`, `describeUserAuth`, `describeAllUsersAuth`, `rotatePassphrase`, `recoverPassphrase`, `rotateRecovery`, `openVaultAndEnrollRecovery`, `recoverManagedPassphrase`, `recoverUser`, `enrollRecovery`, `listRecoveryEntries`, `enrollUnlock`, `unlockViaPin`, `clearQuickUnlock`, `getKeyring`.

  Migration is a mechanical `db.X(` → `db.team.X(` for those names. Runtime behaviour is unchanged — the facade was already doing the work.

- **`vault.collection()`'s options are now a named, exported type (#841).**

  The option shape was a 122-line anonymous literal inlined into the method signature, so callers could not annotate a call and `describe()` could not reuse it. It is now `OpenCollectionOptions<T, S, Q, M>`, exported from the root barrel:

  ```ts
  import type { OpenCollectionOptions } from '@noy-db/hub'

  const opts: OpenCollectionOptions<Invoice, 'ssn'> = { indexes: [...], sensitive: ['ssn'] }
  const invoices = vault.collection<Invoice, 'ssn'>('invoices', opts)
  ```

  It is named `OpenCollectionOptions` rather than `CollectionOptions` to keep a clear gap from the existing `CollectionOpts`, which is the `Collection` constructor's input and is built from this one.

  Internally, 28 hand-written `if (options?.X !== undefined) collOpts.X = options.X` lines collapse into a single key-list copy, so adding a pass-through option is one entry rather than a line buried in a 534-line method. Options that carry logic keep their explicit handling, and the forget-subject rule still overrides `perRecordKeys` exactly as before.

  Purely additive — no behavioural change and no existing signature changed.

- **BREAKING: the `passphrase-*` API family is renamed to `secret-*` (#862).**

  The canonical name for the master credential has always been `secret` — it is the `createNoydb` option, and there was never a `passphrase` alias for it. But a family of public identifiers still said `passphrase`, so callers passed `secret` and then reached for `rotatePassphrase`, `passphraseMode` and `PassphrasePolicy` to manage that same value. The surface now reads consistently.

  | Before                                                  | After                              |
  | ------------------------------------------------------- | ---------------------------------- |
  | `db.team.rotatePassphrase`                              | `db.team.rotateSecret`             |
  | `db.team.recoverPassphrase`                             | `db.team.recoverSecret`            |
  | `NoydbOptions.passphraseMode`                           | `NoydbOptions.secretMode`          |
  | `PassphrasePolicy`                                      | `SecretPolicy`                     |
  | `validatePassphrase`                                    | `validateSecret`                   |
  | `allowWeakPassphrase`                                   | `allowWeakSecret`                  |
  | `assertStrongPassphrase`                                | `assertStrongSecret`               |
  | `WeakPassphraseError`                                   | `WeakSecretError`                  |
  | `PassphraseValidationResult`                            | `SecretValidationResult`           |
  | policy gates `rotate-passphrase` / `recover-passphrase` | `rotate-secret` / `recover-secret` |

  No deprecation aliases — the name is gone entirely, which is the point.

  **The managed-mode store path also moves**, from `_meta/sealed-passphrase` to `_meta/sealed-secret`. This is a wire change, not just a symbol rename: a vault created in managed mode by an earlier version will not find its sealed secret. There is no migration path and none is provided.

  One deliberate exception, documented at its definition: the enclave conformance suite's fixed-secret constant keeps the literal value `enclave-conformance-fixed-passphrase-v1`. Those are known-answer vectors whose wrapped DEKs were computed under that exact string — renaming the value would re-derive a different KEK and invalidate every vector. Only the symbol changed.

  `SecretPolicy` / `validateSecret` still govern the _phrase_ format of the secret (the "at least N lowercase words" rule); the name is now consistent with the option it validates, at the cost of being slightly less literal about what it measures.

### Patch Changes

- **Derivation and materialized-view dispatch moved out of the kernel spine (#842 part b).**

  `Collection` carried four dispatchers — `dispatchDerivations`, `dispatchMaterializedViews`, and their two delete-path mirrors — totalling some 270 lines of logic that belongs to the derivation service rather than the always-on kernel. They now live in `with-formula/derivations/dispatch.ts` and `with-formula/materialized-views/dispatch.ts`, with thin delegators left behind on the class so the public surface is unchanged.

  `collection.ts` drops from 4531 to 4263 lines and its kernel-surface ceiling ratchets down with it. Because the spine reaches the new modules through a dynamic `import()`, the dispatch code also leaves the floor bundle for consumers who never declare a derivation or a materialized view.

  `selfWriteFieldEqual` moved from a module-private helper in `collection.ts` to `kernel/via/dispatch.ts`, beside `putDerivedOutput` — both the spine's rollup recompute and the lifted dispatch need it, and both already import from there.

  No behavioural change and no public API change.

## 0.4.0-pre.4

### Minor Changes

- **One resolved strategy bag replaces the ~10-site-per-service spine plumbing (#838).**

  Threading one opt-in service through the kernel used to cost about ten mechanical edits across four files and three layers — a field on `NoydbOptions`, a conditional spread at the `new Vault(` site, a field declaration plus constructor parameter plus assignment on `Vault`, a forwarding spread, a field and a re-applied `?? NO_*` default in the collection config, and a field plus assignment on `Collection`. None of it carried logic, and nothing verified that a new service had reached every layer. That missing check is what produced #834: a copy of the Vault option block had silently dropped six strategies, so a vault reached that way threw `*NotEnabledError` for services the caller had in fact configured.

  `createNoydb` now resolves every service once into a `StrategyBag`, and `Noydb` → `Vault` → `Collection` share that one reference. The three layers can no longer disagree about which services are enabled. Twenty-one conditional spreads, twenty-one Vault fields with their constructor plumbing, eleven collection-config fields with nine duplicated `?? NO_*` defaults, and seven Collection fields are gone — 149 lines net, 87 of them out of the three ratcheted spine files, whose ceilings ratchet down accordingly.

  Adding a service is now one row in `StrategyBag` and one row in `STRATEGY_DEFAULTS`, both in a single file; omitting either fails the build and names the key, via two compile-time assertions checked against `NoydbOptions`.

  The table lives on the `/with` port rather than in the kernel, because the port-layering guard allows spine → `port/with/` but not spine → `with-*` — the same reason the existing `NO_*` stubs already lived there. Two services needed adjusting to fit "every key always resolves": `archive` gained a `NO_ARCHIVE` stub (it was the one service held as `undefined` behind a hand-rolled null gate), and `lazy` keeps `IMPLICIT_LAZY` as its floor because an un-opted-in collection still gets a working LRU. `coordinationStrategy` stays out of the bag — it is a `CoordinationProvider` with no `with*()` factory, resolved asynchronously from the store.

  No public API changes. `Noydb.custodyStrategy` and `Vault.cargoStrategy` behave exactly as before but are now getters rather than instance fields, which means they finally appear in the prototype-based kernel API manifest — it could not see them at all previously.

## 0.4.0-pre.3

### Minor Changes

- **Fixes a silent security downgrade (#850).** Declaring `sensitive: [...]` (structural group-encryption) on a CRDT collection is now refused at construction. It used to be accepted and silently ignored: the CRDT branch of `_putInternal` persists through `encryptJsonString` and returns before any sealing runs, so the listed fields were stored in the ordinary encrypted body — no `_sealed` slot, no HKDF-derived per-field key, no error. Verified empirically: an identical declaration on a non-CRDT collection produced `_sealed: { … }` while the CRDT one produced nothing.

  Not a plaintext leak — the CRDT body remains AES-GCM-encrypted under the collection DEK — but the caller received materially less protection than they asked for, silently. The refusal matches what `embeddings`, `unique` indexes and classified digest-only fields (guard R2) already do for the same underlying reason: the CRDT write path bypasses the pipeline those options are enforced by.

  Also adds guard tests pinning the three combinations that keep the CRDT write-tail divergences unreachable (#835), so relaxing any of those refusals fails loudly and points at the tail that would then need fixing.

- **Every previously-unspellable public type is now nameable, and a CI guard keeps it that way (#837).**

  Fourteen types appeared in public signatures but were exported from **no entry at all**, so a consumer could call the function and had no way to annotate the call: `EnclaveKey`, `EncryptResult`, `DerivationContext`, `RunResult`, `ExtractPartitionOptions`, `TransferSealPayload`, `IssuedChallenge`, `PutDerivedOutputCtx`, `SealedShredSlot`, `LookupBacking`, `MinMaxState`, `PolicyEnforcerOptions`, `TransformFn`, and one that only existed as a leaked local import alias. Each now ships from the entry whose signatures mention it (`EnclaveKey`/`EncryptResult`/`SealedShredSlot`/`IssuedChallenge` route through the enclave barrel, per the fork-swap contract).

  New `pnpm --filter @noy-db/hub check:types`, wired into CI after the build: it walks every subpath's built `.d.ts`, resolves re-export aliases, and fails when a subpath exports a function whose signature names a type that subpath does not export. The 137 remaining gaps — types reachable from another entry, so merely a dual-import annoyance — are baselined and ratcheted; new ones fail the build. `--report` splits unspellable from merely-misplaced, and `--counts` prints per-entry export totals.

- **Fixes a correctness bug (#834), breaking for one call pattern.** `db.vault(name)` no longer constructs a Vault — it returns the instance `openVault()` produced, or throws with an actionable message.

  It previously carried two fallback constructors beside the real open path, and the encrypted one had **silently drifted**: it omitted `attestationStrategy`, `classifiedStrategy`, `portabilityStrategy`, `sealedRecordStrategy`, `sequenceStrategy` and `forgetStrategy`. A vault reached that way threw `*NotEnabledError` for services the caller _had_ configured — the error actively misled, naming a strategy you already passed. Both fallbacks also skipped the async registry init and schema-fence snapshot `openVault` performs, which a synchronous accessor cannot await, so the object they returned was structurally incomplete regardless.

  Callers relying on the auto-open must `await db.openVault(name)` first (the thrown error says so). A test now asserts `noydb.ts` contains exactly **one** `new Vault(` site — that invariant, not review vigilance, is what keeps the drift from recurring.

## 0.4.0-pre.2

### Minor Changes

- Blobs: offline pinning + mobile cache budget (#808).

  - `collection.blob(id).pin(slot)` / `unpin(slot)` / `isPinned(slot)`: pin a blob slot for
    offline availability on THIS device. Pinning downloads eagerly (call while online) and
    exempts the slot from `vault.compact()` eviction — both the `blobFields` policy pass
    (reported via the new `CompactionResult.pinned` counter) and the new cache-budget pass.
    Pin state is device-local and never synced: it lives in the `withBlobs()` pin registry
    (`withBlobs({ pinStore })`, a pluggable 4-method `BlobPinStore`; in-memory default —
    supply an IndexedDB/SQLite-backed store for durable pins).
  - `vault.compact({ cacheBudget: { maxBytes } })`: LRU budget for locally-cached UNPINNED
    blob bytes, run as a dedicated pass inside the existing compaction machinery. Internal
    slots evict through the standard eviction writer (with a new `'budget'` audit reason);
    `external` slots only drop their device-local cached copy (the object-store copy is
    untouched). Pinned and `legalHold`/`retainUntil`-held slots are exempt. New
    `CompactionResult.budgetEvicted` / `budgetBytesFreed`; LRU order from the device-local
    `SlotInfo.lastAccessAt` stamp (fallback `uploadedAt`).
  - Offline read taxonomy: new typed `BlobOfflineError` (`code: 'BLOB_OFFLINE'`) — an
    `external` slot with no local copy while the object store is unreachable, or an internal
    blob whose chunk envelopes are absent from the local store. BREAKING-ish detail (pre-1.0):
    the internal missing-chunk case previously threw `NotFoundError`; it now throws
    `BlobOfflineError`, since the content exists but is not locally available. External reads
    now auto-populate the device-local encrypted side-cache, so a repeat read is served
    locally (and offline).
  - External pins are encrypted at rest locally: the object-store copy of an `external: true`
    slot is outside the ZK envelope by design, but the local pinned/cached copy is
    AES-256-GCM-encrypted under the vault's `_blob` DEK via the existing enclave path
    (AAD-bound), so plaintext never rests in the pin registry.
  - KPI counters for the 4G-budget demo: `withBlobs().cacheStats()` →
    `{ hits, misses, bytesDownloaded }` (local reads hit; object-store fetches miss + count
    bytes). `BlobSet.list()` now annotates `SlotInfo` with the device-local `pinned` /
    `lastAccessAt` / `cachedBytes` view.

- Complete the `/bundle` promotion (#812): the partition-transfer ops promoted onto `/cargo` in 0.4.0-pre.1 now ship with their own option/result types (`WalkClosureOptions`, `ClosureResult`, `DanglingRefNotice`, `ExtractPartitionResult`) — previously a caller could invoke `walkClosure()` from `/cargo` but could not name its options type. The **adopt half** of the transfer ceremony joins them (`adoptPartition`, `unsealDeks`, `createOwnerOnAdoptedPartition` + 6 option/result types): extraction without adoption was half the story. Transfer errors (`TransferSealError`, `AdoptionStateError`, `PartitionExtractionError`) land on `/cargo`, and the artifact/backup errors (`BundleIntegrityError`, `BundleSealMismatchError`, `PodVersionConflictError`, `BundleVersionConflictError`, `BackupLedgerError`, `BackupCorruptedError`) on `/pod`, so `instanceof` works from the subpath instead of the root barrel. Purely additive — `/bundle` still resolves everything it did, and its retirement follows in a later release. Also promotes `hasNoydbBundleMagic` onto `/pod` (#820) — it sat beside `NOYDB_BUNDLE_MAGIC` everywhere except the subpath, forcing klum's multi-bundle reader to keep a root-barrel import alive for one predicate.
- **BREAKING (no migration shim).** Removes every deprecated `publicEnvelope` alias left by the cover rename (#799): the 6 type aliases, 10 value re-exports, `Noydb.setPublicEnvelope`/`getPublicEnvelope`, `Vault.getPublicEnvelope`, the `NoydbOptions.publicEnvelope` option key, and `readNoydbBundlePublicEnvelope`. Use `Cover`, `setCover`/`getCover`, `NoydbOptions.cover`, `readPodCover`. The deprecation window's only purpose was the klum-db migration, which shipped in klum-db 0.4.0-pre.1. **The wire format is unchanged and stays frozen**: the `_meta/public-envelope` record id, the `_noydb_public: 1` discriminator, and the pod-header `publicEnvelope` JSON key are untouched — existing vaults and bundles need no migration.
- **BREAKING (no migration shim).** Removes three `NoydbOptions` fields that were declared but never read anywhere in the codebase, so setting them silently did nothing: `auth` (`'passphrase' | 'biometric'` — its JSDoc claimed a default that no code implemented; the real mechanisms are the `getKeyring` callback and the authenticator slots), `autoSync`, and `syncInterval` (both documented as superseded by `syncPolicy`, but no reader ever honored the stated precedence). Verified zero readers across every package before removal.
- **BREAKING (no migration shim).** The `@noy-db/hub/bundle` subpath is removed, and with it the entire `src/legacy/` folder. Its surface has permanent homes: `.noydb` artifact ops on `@noy-db/hub/pod`, partition-transfer ops (extract **and** adopt) plus their option/result types and errors on `@noy-db/hub/cargo`. Nothing is orphaned — the promotion completed in #812/#820 before this cut. `/cargo`'s internal re-export floor moved from `src/legacy/kernel.ts` to `src/with-cargo/floor.ts` (unpublished either way). Consumers still on `/bundle`: import from `/pod` or `/cargo`; the symbol names are unchanged.

### Patch Changes

- `closePeriod` (and the other `_periods` summary writes) now mark the record dirty, so a closure made on a device with its own local store **pushes** to the shared store instead of staying put (#822). Period-scoped pull (#807) already treated `_periods` as always-sync — it is the navigation index a thin client needs first — so pull symmetry without push symmetry meant other devices could never see the closure. The other three reserved period collections stay device-local by design: freezes are marker-convergence state, archives record a per-deployment hot→cold relocation, and target-purges describe the very targets they would be pushed to.

## 0.4.0-pre.1

### Minor Changes

- `/cargo` gains the partition-transfer helpers klum-db's interchange binds — `extractPartition` (withCargo()-gated), `walkClosure`, `describeExtraction`, `decryptExtractedPartition` + types `ExtractionPreview`, `DecryptedRecord` — promoted from the transitional `/bundle` subpath (#812 step 1). `/bundle` remains published until the orchestrator migrates; its retirement (and `src/legacy/`'s deletion) follows.
- Period-scoped sync pull — thin-client bootstrap (#807).

  - `PullOptions.periods?: string[] | { current: true }` — `{ current: true }` bounds a fresh device's first sync to records at-or-after the latest closed period's boundary; an array of closed-period names backfills exactly those periods on demand (idempotent — a deep link into an old period just calls `pull({ periods: ['FY2026-Q1'] })` again). Membership is by envelope write-time `_ts` against the closed periods' exclusive upper bounds — the same store-tier law freeze/archive use (the engine never sees business dates).
  - **Period summaries always sync**: a period-scoped pull first fetches `_periods` + the freeze/archive/target-purge companions in full — the navigation index — exempt from every filter, then resolves its windows from that freshly synced index (new `SyncEngine.setPeriodPullSource` injection seam, wired from `Vault.listPeriods()`; `listPeriods()` now always re-reads from the store so pulled closures are immediately visible and seal writes).
  - **Never period-filtered**: delete markers and tombstones (the #589/#590 convergence law — a device that never pulled period P backfills P later without resurrecting its deleted records, and tolerates a remote whose P-markers were already frozen away) and reserved lookup collections. `collections` ∧ `periods` = intersection; `modifiedSince` ANDs on top. **Push is never period-filtered** — `PushOptions` has no `periods` member; client writes always flow up in full.
  - **KPI hook**: period-scoped `PullResult` gains `phases` — `{ summaries: { records, bytes }, records: { records, bytes } }` (bytes ≈ ciphertext payload via the new sanctioned `envelopeBodySize` enclave helper) — for demonstrating a bounded first-sync download budget.
  - Validation: malformed shapes, unknown or opened-kind period names, and a period-scoped pull whose `_periods` records are unreadable (periods service not enabled — pass `periodsStrategy: withPeriods()`) throw `ValidationError` loudly.

- New `@noy-db/hub/share-link` subpath (#806): the canonical portal share-link grammar plus `buildShareLink`/`parseShareLink`. One link shape — `/r/{vaultHandle}/{collection}/{recordId}` with optional `?period=`/`?v=` and an optional single-use grant token carried ONLY in the URL fragment (`#g=`, the on-magic-link transport rule) — addresses vault/period/collection/record identically across the LIFF permalink, installed-PWA, and vendor-console surfaces. Strict-canonical `encodeURIComponent` segment encoding, LIFF permalink-prefix tolerance on parse, and fail-closed typed `ShareLinkParseError`s (never a default-vault fallback). Pure string/URL code with no dependency on the hub floor; export surface frozen by a golden test.
- Additive `kind: 'password'` variant on the `/to` seam's `StoreCredentials` union (#795): `{ kind: 'password'; username; password; domain?; expiresAt? }` for connection-auth stores — to-postgres/to-mysql user+password (omit `domain`), to-smb NTLM via `domain`; `expiresAt` covers password-shaped short-lived cloud IAM auth tokens. No breaking change — the export surface is unchanged and existing `'aws'`/`'token'` consumers are unaffected. Key-shaped auth (`kind: 'key'`) is deferred (to-ssh is keys-only by design and may refuse brokered keys entirely).

## 0.4.0-pre.0

### Minor Changes

- Cover: namespaced `custom` extension slot + total-size caps (#800).

  - `Cover.custom` / `SetCoverInput.custom` — a sanctioned, namespaced slot (`{ 'noydb.viewer': {...} }`) for integrator data that travels with the vault/pod, readable pre-unlock. Keys must be reverse-DNS / package-style (`/^[a-z0-9]+([.-][a-z0-9]+)+$/i`); values must be JSON-serializable (new `JsonValue` type) within an 8-level depth cap. Plaintext, public, unauthenticated — hints, never authority.
  - **Opt-in**: `'custom'` joins `COVER_FIELDS` but is excluded from `DEFAULT_COVER_SCHEMA.fields` — `cover: true` shorthand does NOT enable it; list it explicitly in `schema.fields`.
  - **Namespace-level patch semantics**: `setCover({ custom })` replaces provided namespaces, preserves absent ones, and deletes on explicit `null` (which never persists), so coexisting frameworks never read-modify-write each other's data.
  - **Size caps** (post-merge, on the would-be-persisted document): `maxCustomBytes` (default 8 KB) on the serialized `custom` object, and `maxCoverBytes` (default 300 KB) on the entire serialized cover — the latter also closes the previously unbounded locale-map key-count hole for `name` / `description`.
  - **Wire: purely additive** — no format-version bump; `isCover` and the pod-header validator already tolerate the new key, and `readPodCover` / `resolveLocale` carry `custom` through untouched.

- Rename the public-envelope feature to **cover** across the developer surface (#799). New canonical names: `Cover`/`CoverText`/`CoverSchema`/`ResolvedCoverSchema`/`CoverField`/`COVER_FIELDS`/`DEFAULT_COVER_SCHEMA`/`SetCoverInput`, `validateCoverInput`/`isCover`, `loadCover`/`saveCover`/`readCover`, `resolveCoverSchema`, `COVER_RECORD_ID`, `Noydb.setCover`/`Noydb.getCover`, `Vault.getCover`, `NoydbOptions.cover`, and `readPodCover`. Every old name remains as an `@deprecated` alias for one pre-release window (including the `NoydbOptions.publicEnvelope` option key — accepted alongside `cover`; `cover` wins when both are set). The wire format is byte-for-byte unchanged: the `_meta/public-envelope` record id, the `_noydb_public: 1` discriminator, and the pod-header JSON key `publicEnvelope` are frozen — existing vaults and bundles need zero migration. `readPodCover` and the `Cover` type are promoted to the frozen `@noy-db/hub/pod` subpath surface.
- Join/projection materialized view (#810) — a third `withMaterializedView` strategy form, `projection`, mutually exclusive with `query` / `unionSources`. One output row per record of a primary `source` collection, enriched BEFORE `map` runs by forward FK legs (`{ field, as }` — same `ref()`/`.join()` machinery as UNION arms) and NEW reverse one-to-many "collect" legs (`{ collect, on, as }` — every row of `collect` whose `on` field references the primary record's id, attached as a possibly-empty array; `on` must carry a `ref()` targeting the source, checked at first materialization; per-primary-row `maxRows` fan-out ceiling throws `JoinTooLargeError`). Filtering lives in `map` (return `null`/`undefined` to omit); post-map `groupBy` + `aggregate` run through the same shared pipeline as UNION. Dependencies are all auto — `{source} ∪ forward ref() targets ∪ collect collections` (explicit `sources` still additive) — so a write to ANY referenced collection drives eager refresh / lazy stale-marking; forward targets fold in on the first dispatch after their refs are declared. New exported types: `ProjectionSpec`, `ProjectionJoinLeg`.

## 0.3.0

### Minor Changes

- Credential broker (#479, slices 1+2): passphrase-bound, rolling, non-extractable store-auth.

  Slice 1 (adapter seam): `StoreCredentials`/`StoreCredentialSource` on `@noy-db/hub`'s `/to` port
  (additive, golden-bumped) and a `credentials?: StoreCredentialSource` option on `@noy-db/as-aws-s3`
  (`asAwsS3({ credentials })`), wired as a functional AWS SDK credential provider so
  `memoizeIdentityProvider` re-invokes it at each credential's own expiry.

  Slice 2 (service): new opt-in `@noy-db/hub/broker` (`withBroker()`, `vault.broker()`) — enrol a
  per-vault `_broker` seed (CAS create-if-absent, owner/admin-gated, KEK required only on first
  enrolment), then mint short-lived cloud credentials via a challenge/response HMAC proof
  (HKDF-derived, non-extractable `['sign']` key) against a broker host, with a single-flight
  per-profile refresh cache and a quiesce-then-swap `rotate()`. Ships `kernel/enclave/broker/proof.ts`
  (the proof crypto: `deriveBrokerProofBits`/`deriveBrokerProofKey`/`computeBrokerProof`/
  `issueChallenge`/`verifyBrokerProof`), the `_broker` reserved-collection guard + grant-exclusion
  (rides the already-shipped secret-bearing-reserved-collection guard), the three new error classes
  (`BrokerNotEnabledError`, `BrokerEnrolmentError`, `BrokerProofError`), and a `docs/subsystems/broker.md`
  service page with the threat-model candor table and a reference Lambda/STS broker host documenting
  the four mandated host obligations (KMS-wrap registered proof keys at rest, atomic burn-on-presentation
  challenge consumption, SHOULD rate-limit `/credentials`, accept old+new registration on rotate).
  SERVICES.md gains the Cluster G row.

  Bundle impact: 0 bytes when not opted in (`NO_BROKER` stub + dynamic-import seam).

  Deferred: slice 3 (sealed-to-instance credential delivery + non-extractable instance keypair) is
  not part of this release — see the spec's OQ4. `noy-db-to`'s `to-aws-dynamo`/`to-aws-s3` adoption
  (the `credentials` option + the required hub peer-floor bump) is a separate, manually-gated
  follow-up in that repo once this hub minor is published.

- Opt-in `scopedPurge` forget-strategy knob (#633). `withForgetCascade({ scopedPurge: true })` gates
  `vault.forget()`'s two vault-level purges — the `_sealed_cek` host-delivery envelope purge and the
  blob crypto-shred scan — on a per-collection via-declaration signal (`classifiedFields` for the
  sealed-CEK arm, `blobFields` for the blob arm) instead of running them unconditionally over every
  forgotten ref. Default (`scopedPurge` absent/false) stays fully unconditional — byte-identical to
  today's behavior — because a declaration is a necessary-but-not-sufficient proxy:
  `sealRecordToHost()` and `.blob(id)` both work on collections that never declared anything, so
  scoping by default would silently narrow the erasure promise.

  When scoped, an undeclared collection's purge is never silently skipped: `ForgetResult` gains a new
  additive field, `scopedPurgeResidue: readonly { reason, collection, count }[]`, with reasons
  `'skipped-undeclared-sealed-cek'` and `'skipped-undeclared-blob-scan'` — always empty under the
  unconditional default. The blob arm's scoped skip is also a perf win: an undeclared collection's
  scan is skipped entirely, with no `_blob_slots_<collection>` `list()` call at all. The knob rides
  `ForgetStrategy` the same way `subjects` does — set once per `createNoydb()` instance, threaded
  identically into every `Vault` opened from it.

  **Footgun:** a bare `sensitive: [...]` collection with no `classifiedFields` binding counts as
  UNDECLARED for the sealed-CEK arm — under `scopedPurge: true` its sealed-CEK envelopes are
  skipped-and-reported, not purged, even if `sealRecordToHost()` was called on it.

- New opt-in `Collection.rebuildEmbeddings(): Promise<{ rebuilt: number; skipped: number }>`
  (#788) — force-re-derive every eligible tier-0 record's `_vec` embedding sidecar once. Closes the
  recall gap #726 left open: `_vec` rows are now collection-namespaced (`<collection>/<recordId>`),
  so any pre-#726 bare-id sidecar is unreachable residue that previously only self-healed when its
  owning record was next `put()`. Calling `rebuildEmbeddings()` walks every live record and
  re-derives its sidecar immediately, without waiting for organic writes.

  Gated behind `searchStrategy: withSearch()`, mirroring every other search/retrieval method — a
  collection that never declared `embeddings` returns `{ rebuilt: 0, skipped: 0 }` without touching
  the strategy at all, and a collection that declared `embeddings` but never opted into
  `withSearch()` throws `SearchNotEnabledError`, matching `put()`'s existing behavior.

  Elevated records are **skipped, not refused** — the opposite of the `_applyCutoverTransform`/
  `migrateSatellitePerRecordKeys` precedent, which refuses the whole batch on any elevated record.
  An elevated record is _supposed_ to have no `_vec` sidecar (`syncTierSearch` purges it on
  elevate); re-deriving one here would write searchable plaintext-derived data above tier 0. Each
  elevated record is counted in `skipped` and the walk continues to the next id. Tombstones,
  delete-marker rows, and a raw read racing a concurrent delete all decode to `null` and are
  likewise skipped. Idempotent/resumable: a partial failure (e.g. a store error mid-walk) leaves
  earlier records rebuilt; re-running completes the rest — each id's re-derive is independent.

- Blob content now follows the tier of its owning record (#724, #741). Previously `tiers` + `blobFields` was refused (`UnsupportedTierCompositionError`); that refusal is removed and the composition is supported. A blob's storage tier equals its owning record's tier: its content-CEK, chunk address (eTag), slot-map metadata, and published versions are all keyed under `getDEK(dekKey('_blob'|collection, ownerTier))`. `blob(id)` reads are tier-gated at runtime (every content and metadata accessor refuses an elevated record's blob to a tier-0 caller, before any decrypt); writes to an elevated record are keyed at that record's tier; on `elevate` the record's blobs (and published versions) are re-homed under the tier DEK, and `demote` restores them (fully reversible). `forget()` of an elevated blob-owner now correctly crypto-shreds under the record's pre-tombstone tier.

  New collection option **`blobTierPolicy?: 'isolate' | 'dedup'`** (default `'isolate'`). For a blob shared (content-deduplicated) across records, `isolate` forks a private tier-scoped copy on elevate so co-owning tier-0 records are untouched; `dedup` (#741) leaves the shared object in place — the runtime read gate still hides it, but the shared chunks remain decryptable at rest under the flat `_blob` DEK (a documented, accepted residue, analogous to #722's aggregate-inference channel). A tiered collection that declares `blobFields` must set `perRecordKeys`; writing a legacy (non-`perRecordKeys`) blob to a tiered collection is refused (legacy blobs have no per-record key and cannot be tier-isolated).

  Known residuals, tracked separately: multi-blob re-home is not crash-atomic (#746); the `BlobObject` index-envelope metadata (size/mimeType/timestamps) stays under the flat `_blob` DEK (#747); `extract-partition` and external-projection blob writes are tier-blind (#748); there is no cleared-caller `blobAtTier` read path — an elevated record's own attachment is unreachable until demote (#749); and `forget()` does not shred published versions at all (#750, pre-existing).

- Deletes now converge under sync (#589). `collection.delete()` on a synced vault writes a version-ordered `_del` marker instead of a physical removal, so a delete propagates on pull and offline peers can no longer resurrect deleted records; a legitimate re-create at a higher version still resurrects the id (guaranteed non-resurrection remains `forget()`'s job). A concurrent same-version delete-vs-edit resolves via the collection's conflict resolver, or delete-wins by default. Adds an operator purge seam (`Vault._purgeDeleteMarkers`) for the forthcoming period-close feature (#604). Adds an optional `_del` field to `EncryptedEnvelope` on the `@noy-db/hub/adapter` seam (additive) — every `to-*` store must round-trip it (new adapter-conformance vector); `noy-db-to` stores need a conformance pass. Local-only (non-synced) collections keep physical deletes — no change.
- Retire the `/adapter`, `/kernel`, and `/describe` deprecated subpath aliases (legacy retirement, phase 1). This is a coordinated removal, not a deprecation: all known consumers were verified migrated before the aliases were pulled. `noy-db-to`'s stores bind `@noy-db/hub/to` (0 remaining `/adapter` references); `klum-db`'s lobby binds `@noy-db/hub/cargo` (0 remaining `/kernel` references); `@noy-db/ui`/`@noy-db/ui-nuxt` bind `@noy-db/hub/ui` (0 remaining `/describe` references). In-repo consumers (`to-memory`, `to-file`, `to-browser-idb`, `by-peer`, `by-tabs`, the `test-adapter-conformance` harness) were migrated in the same commit — `/adapter` → `/to`, `/kernel` → `/cargo`.

  `/adapter` and `/describe`'s backing `src/legacy/*.ts` files are deleted outright — nothing referenced them internally. `src/legacy/kernel.ts` survives on disk (unpublished): `@noy-db/hub/cargo` re-exports its runtime-helper/error-class/type surface as its internal floor (`export * from '../legacy/kernel.js'`), so the file stays as an implementation detail of `/cargo`, not as a published subpath — the `./kernel` entry is gone from both `tsup.config.ts` and the `package.json` exports map.

  `/bundle` is untouched and stays published — klum-db's interchange still binds it; its migration to `/pod` + `/cargo` is tracked as phase 2/3. Old published `@noy-db/hub` versions keep their `/adapter`, `/kernel`, `/describe` aliases; this only shapes the next release.

  Removed the now-redundant golden freeze tests for the retired aliases (`adapter-surface-golden.test.ts`, `adapter-seam.test.ts`, `kernel-surface-golden.test.ts`, `kernel-surface.test.ts`, and their baseline JSON fixtures). `kernel-api-surface-golden.test.ts` (the `Noydb`/`Vault`/`Collection` prototype freeze) and `cargo-surface-golden.test.ts` are untouched — the latter still reads `src/legacy/kernel.ts` directly as part of its own mechanism, which is exactly why that file had to stay.

- Satellite collections v1 follow-ups (milestone #22).

  - **#596 (fix):** a satellite fan-out leg whose write throws no longer drops a pre-existing
    dirty entry for the same `(collection, id)` — a data-loss bug where a legitimate, already-queued
    sync write could silently vanish when a _different_ leg of a joined put/pair delete failed.
    `Leg` now tracks a `wrote` flag; dirty-compensation is skipped for a leg that never actually
    wrote. A narrow, pre-existing edge case (a leg whose write lands but throws afterward, during
    derivation/materialized-view dispatch) is out of scope for this fix and tracked separately as #687.
  - **#595 (rename, no behavior change):** the one-satellite-per-base v1 scope guard's refusal id
    moves `R-S1` → `R-S10`, freeing `R-S1` for the design's real fields-overlap routing-ambiguity
    rule (`post-register.ts`), which was always the documented R-S1 but shared the id with the
    scope guard in the shipped v1 error string.
  - **#597 (additive):** persisted satellite pairing markers and classified markers now carry an
    optional `epoch` (ISO-8601, stamped on first persist, stable across every later re-declare/no-op
    fast path — deliberately excluded from marker equality). A latent reuse-staleness guard for
    when a collection name gets freed and reused; the epoch-mismatch _rejection_ itself is deferred
    until a delete-collection API exists — there's nothing to reject against yet.
  - **#599 (new public API):** `Vault.migrateSatellitePerRecordKeys(satelliteName)` unblocks R-S7
    retro-coverage — walks an existing satellite's records via `_applyCutoverTransform`, minting a
    distinct per-record CEK for each, so a satellite declared before forget-coverage was added can
    be migrated into `perRecordKeys` mode instead of being permanently stuck behind R-S7's refusal.
    Resumable (already-migrated records keep their CEK on a re-run); asserts the collection wasn't
    already opened this session without `perRecordKeys` (throws `SatelliteConfigError` otherwise);
    no vault-wide fence/quiesce — run it before the satellite collection serves other traffic.
  - **Bounded #588 consolidation:** `kernel/best-effort-revert.ts` — a shared best-effort-revert
    helper now consumed by both satellite fan-out (`with-shape/satellites/fanout.ts`) and
    `with-commit`'s transaction revert (`with-commit/tx/transaction.ts`), replacing two near-identical
    reverse-iterate/put-or-delete loops with one. Internal-only (not part of any public barrel).
    #588's actual ask — a kernel cross-collection atomic-write primitive — remains descoped/parked
    (closed not-planned): it's adapter-contract-breaking (ripples to every `to-*` store in the
    sibling `noy-db-to` repo plus the `adapter-conformance` harness) and needs its own design spec;
    revisit on a real torn-pair report or when that cross-repo adapter work is independently scheduled.

- Milestone #26 — docs/release infra + a CRDT build-warning fix + a delete-conflict caveat.

  - **#660 (hub minor trigger): DTS build memory.** The hub's declaration build blew past 8GB peak
    RSS (measured ~4.9GB steady-state, up to ~9GB peak footprint), forcing a
    `--max-old-space-size=12288` cap in both CI workflows and the package's own `build` script.
    Replaced tsup's `dts: true` (rollup-plugin-dts bundling) with a single plain
    `tsc --emitDeclarationOnly` pass (`packages/hub/tsconfig.dts.json`), wrapped in an RSS guard
    (`packages/hub/scripts/build.mjs`). Peak RSS dropped ~4.9GB → ~410-435MB (~91% reduction);
    `.github/workflows/ci.yml` / `release.yml` `NODE_OPTIONS` dropped 12288 → 4096.
    **Shipped `.d.ts` layout changed**: instead of tsup's flat bundled-per-subpath files, `dist/**`
    now mirrors `src/`'s directory tree 1:1 (e.g. `dist/with-commit/history/index.d.ts` instead of
    `dist/history/index.d.ts`), so the file count went from 54 to 398. All 41 `package.json`
    `exports[...].types` targets were retargeted accordingly. The public API, types, and import
    specifiers are unchanged — every subpath still resolves the same way through `exports` — but the
    on-disk layout behind that map is different, which is why this is a **minor**, not a patch, per
    pre-1.0 convention for consumer-visible packaging changes. A build-time guard now also verifies
    every `exports` target (`types`/`import`/`default`) actually resolves to a file in `dist/` after
    build, catching a stale/typo'd subpath before it ships.
  - **#667**: fixed a Rollup dts circular-dependency warning between `kernel/types.ts` and
    `with-commit/crdt/strategy.ts` (`CrdtStrategy` re-export cycle). Hoisted `LwwMapState`/
    `RgaState`/`YjsState` into `kernel/types.ts` alongside the other CRDT types, and redirected the
    `CrdtStrategy` type import in `vault.ts`/`collection.ts`/`collection-config.ts` from the indirect
    `with-commit/crdt/strategy.js` re-export to the direct `kernel/types.js` origin. No runtime
    behavior change; no public API change.
  - **#600**: `release.yml`'s `publish` job now opens a `noy-db-docs` issue (`continue-on-error`,
    via a `DOCS_SYNC_TOKEN` PAT) on every successful publish, carrying the version/tag, npm
    dist-tag, run link, and the list of published `@noy-db/*` packages — so the docs repo's doc-sync
    has a trigger instead of relying on someone noticing a new release.
  - **#607**: added a JSDoc caveat to `ConflictPolicy<T>` (`kernel/types.ts`) — and mirrored in
    `docs/subsystems/via.md` — documenting that `'last-writer-wins'`/`'first-writer-wins'`/`'manual'`
    compare raw envelopes, so an edit _can_ beat a delete marker, whereas a custom-fn resolver and
    the CRDT modes `'lww-map'`/`'rga'` decrypt both sides first and unconditionally let a
    shred/tombstone win before the merge function ever runs (`'yjs'` is the one CRDT-mode exception:
    it never decrypts and falls back to a plain higher-`_v` compare, so an edit can win there too).
    Doc-only; no behavior change.
  - **#624**: taxonomy-convergence analysis for the `noy-db-docs` migration (PR #498) — a gap
    analysis (9 verified divergences between `SERVICES.md`/`packages/hub/src/**` and
    `noy-db-docs`'s `features.yaml`/taxonomy), a `feature-schema.json`/`features.yaml` proposal,
    two new ADRs (`docs/adr/0001-minimal-kernel-core.md`, `docs/adr/0002-placement-is-not-opt-in.md`
    — the first ADRs in this repo), and an 18-step migration checklist. Analysis/docs only; nothing
    in `packages/**` changed.

- Milestone #31 via backlog closure — six issues (#666, #664, #639, #665, #661, #625), one branch.

  - **#666 — `Collection._setVia(pipeline)` writer seam.** Internal refactor: the untyped
    `coll as { via; codec: { setVia } }` cast `applyTaintOverlay` used to reassign a collection's
    compiled `ViaPipeline` is replaced by a typed method. No observable behavior change; it exists
    to give #664's late-attach machinery a sound way to rebuild the pipeline from outside
    `collection.ts`.

  - **#664 — late-attach (reconcile) parity for `i18nFields`/`dictKeyFields`/`lookupFields`.** A
    SECOND-OR-LATER `vault.collection(name, {...})` call against an already-open collection always
    supported `moneyFields`/`computed`/`fieldMeta`/`meta`/`classifiedFields`; these three families
    were silently ignored on that path with no error. Now they attach: enum/static-tier lookup
    fields attach cleanly (self-contained, no vault registry touch); reserved-tier (`dict()`) attach
    additionally wires the same vault registries fresh construction populates (sync + reference-graph
    both see the field immediately). **Matrix-tier lookup fields (`backing: 'collection'`) REFUSE to
    late-attach** with a `ValidationError` naming the field/dimension/remedy unless the backing
    collection is already open, this vault session, in eager (prefetch-enabled) mode — this is a
    deliberate scope limit, not a bug: a lazy or not-yet-open backing dimension fails LOUD at
    declare time instead of surfacing a confusing error the first time a query touches the field.
    The pre-existing declare-time collision guard (two via families claiming the same field) now
    also runs on every late-attach call, both within one call's own incoming fields and against the
    collection's already-declared fields. Three known late-attach residuals, documented, not fixed
    in this pass: `describeAsync({resolveDictLabels:true})`, `describe()`'s legacy top-level field
    list, and join-side `presentForJoin` dressing — each reads a `Collection` field captured once at
    fresh construction, not re-derived by a later reconcile call.

  - **#639 — mutual/rotating rollup cycles now refused at declare time.** Two or more `withRollup()`
    strategies whose targets mutually depend on each other used to be silently declarable — the
    cycle was invisible to the dependency graph's cycle check because a rollup's target is a field
    the graph only ever writes into, never reads from. `ViaGraph.assertAcyclic()`'s traversal now
    additionally treats a real-field write as also being a write to its owning collection, closing
    the gap. Fires at `Noydb.openVault()` (every derivation/MV strategy validates at vault open), and
    throws `DerivationCycleError` — the same class every other declare-time cycle already throws.
    Deliberately scoped to rollup-shaped cycles only; no runtime depth/reentrancy guard was added
    (a declare-time sentinel fix, not a cycle breaker).

  - **#665 — computed-first present order; `<field>Label`/`<field>Formatted` dressing now sees a
    virtual computed field's output.** Before this fix, `computed`'s `present()` hook ran LAST, so
    i18n/lookup's dressing hooks ran before a `mode: 'virtual'` computed field's value existed —
    dressing was always a no-op for a composed field. `ViaPipeline._presentOrder` reorders the
    PRESENT phase only (every other phase keeps the existing money-first compile order) so computed
    runs before i18n/lookup. **Money is explicitly carved OUT of the generic reorder and kept in its
    original present position** (a three-way partition: money, then computed, then everything else)
    — money's `present()` DECODES its input as a stored scaled-int, unlike i18n/lookup which only
    ADD a dressing key; running money after a virtual computed on the same field would misread the
    computed output's raw major-unit number as a scaled-int and corrupt the value, not just leave it
    undressed. **Two tradeoffs, pinned as tests, not follow-ups:** (1) a virtual computed field can
    no longer read another field's dressing output (`<field>Label`/`Formatted`) — that composition
    direction was never in this fix's scope and silently regresses if anyone relied on it; (2)
    chained virtual computeds stay declaration-order-sensitive (a later-declared virtual field can
    read an earlier-declared one's output; the reverse falls back to the reader's sentinel) — this
    was already true before #665 and is unrelated to the present-order fix, just documented
    alongside it. **Money-decorating-a-virtual-computed-field's-own-output stays an explicit,
    out-of-scope KNOWN LIMITATION** — closing it needs a quantize-the-computed-output decision, not
    an ordering fix; filed as a wrap-up follow-up.

  - **#661 — bare-array lookup fields gain element-wise support.** A plain field whose own value is
    an array (distinct from the pre-existing `[].`-wildcard multi-value path) had ZERO enforcement —
    `getAtPath` resolved it to one opaque value, so both the altKey-normalizing `ingest` hook and the
    closed-vocabulary `enforceWrite` hook silently skipped it; any value, known or not, passed
    `put()` under `vocabulary: 'closed'`. Both hooks now handle this shape element-wise, reusing the
    same canonical core the scalar and `[].`-wildcard paths already use — including at a dotted,
    non-wildcard path (`'meta.tags'`), which works with no dedicated code since the underlying path
    helpers already resolve dotted paths generically.

  - **#625 — `ViaBinding.indexProbe` restores the index-accelerated fast path for fixed-mode money
    `where()`.** A new, optional hook lets a binding hand the query builder a STORED-form operand for
    a direct index-bucket lookup on `==`/`in`; without it (multi-currency money, every other
    operator), the query builder falls back to a full scan, unchanged. This restores a fast path
    phase A lost for money fields specifically. **Honest mixed-era caveat**: the fast path is
    byte-exact for every record written through the money write path (which always produces a
    canonical scaled-integer digit string); a legacy record whose stored value predates the field's
    `money()` declaration may hold a non-canonical scaled string (e.g. `'0100'` instead of `'100'`)
    — the index buckets it under that raw string and a canonical `==`/`in` probe misses it, while
    the fallback scan (which re-parses via `BigInt`) still matches it correctly. The indexed fast
    path therefore returns the canonical subset of matches, not literally every stored byte
    sequence; a re-`put()` of a legacy record canonicalizes it going forward. A money-aware
    index-key canonicalization would close this generally — filed as a wrap-up follow-up, not
    implemented here.

  **Additive surface, no breaking change:** `ViaBinding.indexProbe?(op, payload): unknown | undefined`
  (kernel/via.ts) is a new optional hook — a type-level addition every existing binding is free to
  leave unimplemented (falls back to a scan, unchanged behavior). Verified no `**/*golden*` file
  changed anywhere on this branch (`git diff a2c80969..HEAD -- '**/golden*'` — empty), so no frozen
  public-surface snapshot needed regenerating for any of the six issues above.

  See [`docs/subsystems/via.md`](../docs/subsystems/via.md) (new "Milestone #31" section),
  [`docs/subsystems/via-lookup.md`](../docs/subsystems/via-lookup.md) (late-attach + bare-array
  sections), [`docs/subsystems/via-computed.md`](../docs/subsystems/via-computed.md) (present-order
  section), and [`docs/subsystems/via-money.md`](../docs/subsystems/via-money.md) (indexing section)
  for the full story, every example traced to a shipped test.

- Milestone #32 via follow-ups — four issues closed.

  - **#670** — `LookupHandle.rename()` publishes the new key to the sync cache before rewriting referencing records, so renaming a key on a `vocabulary: 'closed'` field no longer self-refuses with `UnknownLookupKeyError`; mid-rename, both the old and new keys are legitimately members.
  - **#672** — Money-aware eager-index key canonicalization now runs at every bucket-mutation site (build/rebuild-on-hydrate, `put()`, `delete()`), via a new `ViaBinding.canonicalizeIndexKey` hook. A mixed-era (pre-money-declaration) legacy value's index fast path now agrees with the fallback scan instead of stranding it under its raw, non-canonical key. Boundary: lazy-mode (`prefetch: false`) collections keep their own raw-bucketing `PersistedCollectionIndex` side-car, unaffected — tracked separately.
  - **#669** — Money now dresses a virtual computed field's own output (`via(computed(fn, {mode:'virtual'}), money(...))` on the same field) as MAJOR UNITS: the fn's return value is quantized to the currency scale (per the descriptor's declared rounding) and presented exactly like a stored money field — decimal string, `<field>Formatted`, `<field>Number` — via a new `ViaBinding.presentLate` hook. Unparseable/absent output is left raw, no throw. A taint-redacted virtual field's `Formatted`/`Number` companions are stripped along with the base field.
  - **#671** — Five late-attach (reconcile) residuals fixed: (1) `getDictionary`/`resolveDictLabels` now resolves a late-attached dict field's labels, (2) `describe()`'s legacy top-level field list now includes late-attached fields, (3) `presentForJoin` now dresses late-attached i18n/lookup fields through the join path, (4) a money- or classified-only late-attach no longer silently drops an already-materialized taint overlay, (5) `ViaGraph.assertAcyclic()` no longer false-positives on legitimate mutual-FK `lookup`/`ref` edges between two collections. Items 1-3 ride a new `Collection._reconcileReadState` writer seam.

- Period-driven cold archival (#613, #604 Spec 3). New `vault.archivePeriod(name)` relocates a closed period's in-window records (`_ts < periodExclusiveUpperBound(endDate)`) from the hot store to a configured cold tier, driving `routeStore`'s existing hot→cold migration + cold read-through. Non-destructive (reads still resolve), idempotent, gated only on a `closed` period, and records a `_period_archives/<name>` companion + ledger entry parallel to `freezePeriod` (the chained `_periods` record stays byte-immutable). Requires a `routeStore` with a cold route (`age: { cold }`); throws otherwise.

  Supporting additions: `routeStore.compact(vault, { before })` accepts an explicit cutoff (and `AgeRoute.coldAfterDays` is now optional — `age: { cold }` alone = period-driven archival only); `StoreCapabilities.coldArchival` advertises a cold-capable router.

  Note: `routeStore` now surfaces its primary store's `capabilities` (previously it exposed none), layering `coldArchival` on top. A consequence is that CAS-gated features (e.g. gap-free `sequence().next()`) are now permitted on a routeStore-backed vault when the primary store reports `casAtomic` — previously they refused on any routeStore. A router without its own cold route never advertises `coldArchival`, even when nested over a cold-capable primary.

- Period freeze (#604). `vault.freezePeriod(name)` physically reclaims the space held by a closed accounting period's delete markers — it purges the delete markers whose write-time falls within the period (via the operator-asserted safe-point the closed period provides), records a `_period_freezes/<name>` companion + a tamper-evident ledger entry, and leaves the hash-chained period record byte-immutable. Terminal and idempotent; requires `withPeriods()`. Forget-tombstones, history, and live records are untouched. Closes the `_purgeDeleteMarkers` audit-emission deferred from #589.
- Single-vault target-purge (#615, scoped base of #611). New `vault.purgePeriodTargets(name)` sweeps delete markers (`_ts < periodExclusiveUpperBound(endDate)`) off the vault's **push-only** sync targets (`backup`/`archive` roles) for a period that is already **closed and frozen** locally — reclaiming remote marker space that `freezePeriod`'s local purge can't reach. Records a `_period_target_purges/<name>` companion + ledger entry (mirroring freeze/archive; the chained `_periods` record stays byte-immutable), idempotent, gated on frozen-first. `sync-peer` targets are deliberately skipped (purging their markers could re-open the resurrection window — the deferred half of #611). A vault with no push-only targets writes no companion and is re-runnable. Single-vault only; fleet-wide purge remains klum's concern over `@noy-db/hub/cargo`. `surface: api` — rides the existing store contract (`loadAll`/`delete`), no adapter change.
- Via consolidation (milestone #30): four latent gaps surfaced by the phase A–D whole-branch
  reviews — #642, #651, #654, #640 — plus riders on #644 (items 1+3) and #646 (fixture discipline).
  No shipped consumer uses any of the affected surfaces yet (pre-1.0), so none of this carries a
  migration story.

  - **#642 — formula outputs derived from a classified-bearing collection are now sealed at rest,
    non-exportable, and query-refused by default (BEHAVIOR CHANGE, the #636-principle completion).**
    #636/#638 closed the leak for a `computed` field's own declared `deps`; a with-formula edge
    (derivation/rollup/MV) still folded its posture from its source's whole-record `'*'` node, which
    never carried a registered posture and always fell back to max-permissive — so a derive/rollup/MV
    `fn` (which receives DECRYPTED records by design) that copied a classified field's plaintext
    landed it UNSEALED in the output: exportable, queryable, synced. Both target shapes are now
    covered — **rollup targets** (a real field on the parent) inherit the fold automatically through
    the existing field-specific taint overlay; **derivation/MV/overlay output collections** (`'*'`
    targets) gain a collection-level default posture that seals every non-`_`-prefixed field of the
    output record. The fold is axis-scoped, not a blanket clamp: only `encryptedAtRest`/`exportable`/
    `forgettable` fold from a classified source; `queryable` is left at the base posture and is never
    pulled down by a blob/money/i18n-only source, and a `ref` edge's `'*'` source is excluded from the
    fold entirely (kept at identity, so a lookup-referencing field never seals just because its
    backing dimension happens to have a classified column — the countries-matrix recipe stays
    byte-identical). **No migration**: pre-1.0, no shipped consumer reads a formula output today, so
    there is nothing to migrate — a deliberate, ratified security-correct default. Explicit
    per-declaration declassification is deferred to phase E, not built here. **KNOWN LIMIT**: the MV
    leg is currently theoretical for classified sources — all three MV refresh modes pre-open their
    source collection at `openVault`, and the pre-existing classified retro-declare guard then refuses
    classifying it there, so the fold applies mechanically but is structurally unreachable today.
    Landing this exposed
    three genuine, pre-existing latent bugs in the at-rest cache layer — all three gated on a
    collection's _local_ `sensitiveFields` being non-empty, which was always true historically because
    a sealed field always co-occurred with a locally-declared classified field until a
    taint-only-sealed collection (zero local `sensitiveFields`, sealed entirely via the graph fold)
    became reachable: `RecordCodec.toCacheRecord` (a write-then-immediate-`get()` returned cached
    plaintext instead of a `SealedHandle`), `Collection.resolvePriorValues`, and the `_getStoredRecord`
    lazy-mode branch (both of the latter, left unfixed, broke the self-write cycle-termination guard
    for a rollup patching its own parent — an **infinite write loop**, not a wrong-value bug).
    `resolvePriorValues` and the `_getStoredRecord` lazy branch are now gated on
    `sensitiveFields.size > 0 || via?.hasAtRestHooks === true`; `toCacheRecord`'s equivalent stale gate
    was removed outright — the envelope's own `_sealed` presence fully determines whether wrapping is
    needed.
  - **#651 — one canonical key-resolution core; matrix direct-read `present()` dressing now works for
    a non-default `key`.** A matrix lookup declared with `key !== 'id'` (e.g. `lookup('countries', {
key: 'iso2' })`) previously resolved its DIRECT (non-join) `<field>Label` read by the backing
    collection's PUT-id, not `descriptor.key` — silently omitting the label for exactly the canonical
    recipe this feature exists for. `coerceLookupKey`/`resolveBackingRowKey`/`matchesReferencingValue`
    are now the one shared key-resolution core all six call sites converge on (snapshot rows, altKey
    index, membership check, compare-key resolution, the restrict/propagation match predicate, and
    `getLookupBacking`'s direct-read closure) — ending a bare-`String()`-vs-guarded-coercion drift
    between them. Two poisoning classes close as a result: a backing row missing its `descriptor.key`
    field no longer enters the snapshot/altIndex under the literal string `"undefined"` (previously a
    closed-vocabulary field could wrongly accept `"undefined"` as a valid key); and a nullified or
    never-set referencing field no longer bare-`String()`-coerces to the literal `"null"`/`"undefined"`
    and spuriously matches a dimension whose canonical key genuinely is that string. An altKey
    candidate row VALUE may now be a string or a number — both normalize through the same core
    (deliberate uniformity, not a new capability anyone asked for), and the ownership-uniqueness
    collision check still fires across the numeric/string boundary (a numeric `1` and a string `'1'`
    on two different rows still throw `ValidationError`).
  - **#654 — an unresolvable restrict edge now REFUSES instead of silently letting the delete through;
    ordinary-delete propagation residue-reports instead of silently dropping.** A `restrict`-mode
    lookup edge whose compare-key can't be resolved (a corrupted backing row — the `key` field missing
    or non-scalar) used to `continue` past the check entirely, deleting/forgetting the row with no
    proof references don't exist. It now throws the new `RestrictRefUnresolvableError` (root-exported,
    `{ dimension, key, referencing }`), the same "cannot prove no references ⇒ refuse" reasoning
    `DictKeyInUseError` already applies when references ARE provably present. The `cascade`/`nullify`
    ordinary-delete propagation path's twin failure (previously a bare `continue`, no report channel
    at all) now proceeds but reports the skipped edge on a new `lookup:propagation-residue` event
    (`{ vault, dimension, key, residue }`) — the ordinary-delete counterpart of the pre-existing
    `forget()`-path `ForgetResult.lookupReferencesResidue` channel, which is unaffected. A resolvable
    edge behaves exactly as before in every mode; this is a corruption-class-rarity refinement, not a
    change to the common path.
  - **#640 — sync-applied deletes now recompute rollup parents.** Previously, only a _local_ delete
    triggered `dispatchRollupsOnDelete`; a remotely-deleted rollup child pulled over sync left its
    parent aggregate stale indefinitely. The sync-apply choke point now classifies each applied
    envelope as a put or a delete and threads deleted ids, batched and per-parent-deduped, through the
    same dispatch wave `pull()`/`push()`/cutover/restore already run — routed to the rollup-recompute
    trio only, never `dispatchDerivations`/MV-on-delete, mirroring the existing local-delete dispatch
    boundary. **KNOWN LIMIT, stated honestly**: the deleted child's rollup-parent intents are resolved
    from a synchronous pre-invalidation cache peek with no extra I/O; if that peek misses — a cold or
    evicted child (lazy-mode LRU eviction before the sync-apply lands) **or** an un-hydrated eager
    collection whose first sync operation for that child is itself a delete — the miss is silent and
    freshness-only: that one child's contribution to the parent goes uncounted until the next sibling
    write recomputes the parent from scratch. Correctness elsewhere is unaffected (the recompute always
    reads the remaining children from the store, so nothing double-counts). Riders: `push()`/`pull()`
    now flush the graph batch in a `finally` around `persistMeta()`, so a throw there no longer leaves
    a stale open batch silently dropping the next wave's touches (#644 item 1); both the puts and
    deletes legs of the dispatch wave now additionally emit a structured `'derivation:wave-error'`
    event (`{ collection, id, error }`) alongside the pre-existing `console.warn`, so a sync that
    completed with a failed per-id recompute is programmatically discoverable, not just logged (#644
    item 3).

  **Additive surfaces** (non-breaking): `RestrictRefUnresolvableError` (root-exported, alongside
  `DictKeyInUseError`); the kernel event map gains `'lookup:propagation-residue'` and
  `'derivation:wave-error'`.

  See [`docs/subsystems/via.md`](../docs/subsystems/via.md) (Phase C section — the #642
  formula-output-posture and #640 sync-delete-rollup subsections) and
  [`docs/subsystems/via-lookup.md`](../docs/subsystems/via-lookup.md) (the #651 key-resolution/altKey
  notes and the #654 restrict/propagation policy section) for the full story, every example traced to
  its shipped test.

- The Via port (#629, phase B): classified fields and blobs join phase A's money/i18n as
  kernel-orchestrated via-features, and every binding's declared `ViaPosture` — `encryptedAtRest`,
  `queryable`, `exportable`, `forgettable` — is now an **enforced** contract instead of
  documentation. `via-classified` (`shape/via-classified/`) seals `'recoverable'` fields at rest,
  enforces preset validation and `storage: 'never'` rejection before a write reaches the store, and
  participates in erasure; `via-blob` (`shape/via-blob/`) is a deliberately thin declaration +
  posture binding — blob content crypto stays service-side (`with-shape/blobs/`), never routed
  through the kernel's field-feature pipeline. Query, export, and forget all now consult posture
  generically (no per-feature brand checks): the query DSL refuses a `queryable: 'none'` field
  (new `FieldNotQueryableError` for `blobFields` — classified's own `det-exact` query behavior is
  unchanged, a byte-for-byte parity pin); `Vault.exportStream()`/`exportJSON()` deliberately redact
  an `exportable: false` field to the literal `'[sealed]'` on the record itself, ahead of the
  pre-existing `SealedHandle.toJSON()` accident that produced the same string as a side effect
  (both layers now verified independently); `vault.forget()` consults `forgettable` and folds each
  sealed-posture binding's `erase()` hook into its report, with parity-pinned shred/residue counts.
  New kernel machinery, `ViaCryptoCtx` (`sealedSlots` + `reservedEnvelopes`, both in
  `kernel/enclave/record-keys/sealed-slots.ts`), gives via-features a scoped, key-free door into
  per-record/per-collection crypto — the first consumer is `via-i18n`'s dictionary handle, which
  this phase reroutes off a direct `kernel/enclave` import onto `reservedEnvelopes('_dict_')`,
  **retiring the one remaining `via-enclave-isolation` grandfather** (that allowlist is now empty;
  `via-layering`'s allowlist is unchanged, still exactly `kernel/query/join.ts` → #626).

  **Downstream export output change:** the default (non-`redact`-option) export of a classified
  field via `@noy-db/as-csv`/`@noy-db/as-sql`/`@noy-db/as-xml` changes bytes — pre-#629 these
  satellites saw a live `SealedHandle` object and fell through to `JSON.stringify`-shaped output
  (`"""[sealed]"""` in a CSV cell; a `jsonb` SQL column with literal `'"[sealed]"'`); post-#629 they
  see the plain string `'[sealed]'` directly (a bare `[sealed]` CSV cell; a `text` SQL column with
  literal `'[sealed]'`). The new output is the intended one — the old bytes were an accidental echo
  of a live, `.reveal()`-capable handle reaching an export stream, which this phase's deliberate
  redaction closes.

  **Two erase-hook code paths ship real and unit-tested but stay production-dormant by design:**
  the sealed-CEK `_sealed_cek/*` host-delivery envelope purge (`via-classified`) and the blob-shred
  purge (`via-blob`) are both proven, by their respective pre-existing forget/erasure suites, to be
  vault-level operations unconditional on any given collection declaring `classifiedFields`/
  `blobFields` — routing either exclusively through its via `erase()` hook would silently regress
  collections that don't declare the field but still exercise `.blob()`/`sealRecordToHost()`.
  `vault.forget()` keeps calling both directly; the via bindings' `erase()` hooks carry only the
  classification/participation they legitimately own (classified's `_sealed`-slot shred/residue
  accounting, which IS live and wired). Making the purge scoping collection-declaration-aware is a
  future product decision, not a gap in this phase.

- The Via port (#638, phase C): a per-vault dependency graph (`ViaGraph`, `kernel/via-graph.ts`)
  now connects every derivation, rollup, materialized view, and `computed` field to the sources it
  reads, and enforces four structural fixes that were previously either silently wrong or a design
  gap:

  - **#636 — derived fields now inherit their strictest source's security posture.** A
    `computed` field whose `deps` include a classified source used to silently copy that source's
    plaintext (or a derivative of it) into an ordinary, unredacted field — the taint algebra
    (`foldPosture`) now folds `encryptedAtRest`/`queryable`/`exportable`/`forgettable` from every
    source, and a materialized field folding to `encryptedAtRest: 'sealed'` is actually sealed at
    rest (the same `ctx.sealedSlots` capability `via-classified` uses); a virtual field (never
    stored) is redacted on every read instead. **BEHAVIOR CHANGE, pre-1.0, deliberate security
    fix:** any existing `computed`-from-classified configuration now inherits the classified
    posture where it previously did not — such a field's `get()`/`list()`/export/query behavior
    changes from plaintext to sealed/redacted/refused after upgrading.
  - **#621 — sync-applied, cutover, and restore writes now dispatch derivations.** Previously only
    a local `put()` triggered a collection's derivations/rollups/materialized views; a write
    applied by `pull()`/`push()`/schema cutover/restore silently skipped dispatch entirely. A
    batched, per-target-deduped wave now runs once at the end of a sync session (and around
    cutover/restore) — N synced children of one rollup parent recompute the parent exactly once,
    not N times; a collection with no dependents in the graph is skipped with zero decrypt cost
    (unchanged for money/i18n-only collections).
  - **#622 — `vault.forget()` now fans out to derived residue.** Forgetting a record used to leave
    its derived copies and aggregate contributions behind. Record-grain derived artifacts (MV
    rows, array-shape derivation rows, same-id record-shape derivation copies) are now erased;
    aggregate-grain rollups are recomputed without the forgotten contribution in open periods, or
    skip + audit in frozen ones — the subject's own record is still unconditionally shredded
    either way.
  - **#637 — a frozen-period derivation output now skips + audits instead of failing the source
    write.** A derivation/rollup/MV output landing in a closed period used to throw
    `PeriodClosedError` straight through the _legal_ write that triggered the recompute (live
    local-write dispatch, `deriveAll()`, `refreshView()`, and — after the #621 fix above — the
    sync dispatch wave too). It now skips the write (the historical output stands) and emits a
    new `'derivation:skipped-frozen'` event, plus a `'lifecycle'` audit-ledger entry when
    `withHistory()` is active. In the sync dispatch wave specifically, one frozen (or otherwise
    failing) target in a batch no longer aborts the whole `pull()`/`push()` or starves a co-batched
    healthy target.

  **The declare-time typo guard (closes the #636 "typo reopening"):** on a collection that also
  declares classified fields, a `computed` entry with no declared `deps` — or with a `deps` entry
  naming an unknown field — now throws `ValidationError` at construction (an opaque function could
  otherwise silently copy a classified field's plaintext with no way for the graph to know). On a
  non-classified collection, `deps` may still name any field, including a plain field with no via
  feature declared on it at all — there is no schema-introspection API to validate against, and an
  unregistered dep folds to the default (untainted) posture, which is safe. **KNOWN LIMIT** (pinned,
  not silently left): the guard only checks that a `deps` entry names _some_ known field, not that
  it names the field the function actually reads — `deps: ['amount']` on a function that actually
  reads `ssn` still passes construction and still leaks, because the graph edge folds from
  `amount`'s posture, not `ssn`'s. Closing this fully needs runtime read-tracking or a
  schema-introspection capability outside this phase's scope. See
  [`docs/subsystems/via-computed.md`](../docs/subsystems/via-computed.md) for the declaration-order
  asymmetry this guard has (a single call combining a `storage: 'never'` classified field with a
  depsless `computed` field is refused; the identical pairing split across two separate
  `vault.collection()` calls is accepted, by design — a `never`-storage value cannot structurally
  reach a computed field's output) and its reconcile-path scope limit (a `deps` entry naming a
  classified field declared in an _earlier_, separate call currently over-refuses; the workaround is
  to declare both together in one call).

  **`computed(fn, { deps, mode })` ships as a full via-feature**, composable through `via(...)`
  (`via(computed(fn, { deps: [...], mode: 'virtual' }))`) and through an extended `computed: {
field: { fn, deps, mode } }` sugar form — both additive. `mode: 'materialized'` (the default) is
  byte-for-byte the prior eager write-time compute. `mode: 'virtual'` is new: the field is computed
  fresh on every read, never stored (absent from `_data`), and unconditionally
  `queryable: 'none'`. **Composition semantics are pinned for both modes** — `computed` always
  compiles last in the via-binding stack, so `via(computed(...), money(...))` on the _same_ field
  behaves differently per mode: in `mode: 'virtual'`, money's `present()` runs before the computed
  value exists, so the raw computed number survives unformatted; in `mode: 'materialized'`
  (default), the computed value is merged into the record before `encodeWrite`, so money's own
  encode/decode/present hooks format it normally, exactly like a plain money field. The formerly
  `@internal` `computedDeps` staging option (an interim seam from earlier in this phase, explicitly
  documented as "do not depend on this shape") is **removed** — folded into each `computed` entry's
  own `{ fn, deps?, mode? }` shape.

  **Additive surfaces** (non-breaking): `vault.deriveAll()`'s result gains a `skippedFrozen` counter,
  distinct from `derived` (a frozen-skip is not counted as a successful write); `ForgetResult` gains
  `derivedRecordsErased: number`, `derivedAggregatesRecomputed: number`, and
  `derivedResidueFrozen: readonly string[]` (all pre-existing `ForgetResult` fields are byte-shape
  unchanged); the kernel event map gains `'derivation:skipped-frozen'`
  (`db.on('derivation:skipped-frozen', handler)`).

  See [`docs/subsystems/via.md`](../docs/subsystems/via.md) (Phase C section) and
  [`docs/subsystems/via-computed.md`](../docs/subsystems/via-computed.md) for the full story,
  including every example above traced to its shipped test.

- The Via port (#650, phase D): a new `'lookup'` via-feature — `lookup()` / `enum()` / `dict()` —
  collapses the legacy `dictKey()`/`staticDict()` code-field pattern and a first-class
  reference-collection pattern into **one** binding with three backing tiers: `enum` (inline keys,
  no store), `dict` (a reserved `_dict_<name>` micro-collection — the native spelling of `dict()`,
  what `dictKey()` compiles onto), and `matrix` (a first-class collection like `countries` — the
  native spelling of `lookup()`'s default `backing: 'collection'`, what `staticDict()`'s table-based
  sibling `lookup(name, { backing: 'static', table })` also compiles onto for its own tier).

  **`dictKey()`/`staticDict()` are now aliases**, not deprecated spellings — internally they build
  the equivalent `LookupDescriptor` shape and validate against it, but they still compile onto the
  **`'i18n'`** via-binding, not the new `'lookup'` one. Their stored envelopes, the
  `type`/`widget`/`dict` slice of `describe()` output, and `.join()` dressing stay byte-identical to
  their native equivalent (`packages/hub/__tests__/via/lookup-alias-parity.test.ts`), but they do
  **not** gain the new `.lookup` describe() block below (only a native `lookup()`/`enum()`/`dict()`
  field produces one). Existing code using either sugar continues to work unchanged.

  **New capability, additive:**

  - `altKeys` — declare candidate values (e.g. an ISO3 code, a phone call-prefix) that normalize to
    the canonical key on `ingest`, sync and pure, from an already-materialized backing snapshot (no
    store read per `put()`).
  - `vocabulary: 'closed'` — write-time membership refusal (`UnknownLookupKeyError`) against the
    backing dimension's **actual current rows**, checked live, not a hardcoded universe. `'open'`
    (the `dictKey()`/`dict()` default) is unaffected. The dict tier's closed membership specifically
    is declared `keys` **union** the reserved dictionary's live rows (a declared key is known even
    before any row for it exists; a live row for an undeclared key is known too) — pinned by
    `lookup-vocabulary.test.ts:96`. Matrix tier has no declared key list at all — membership is
    purely the backing collection's live rows.
  - `sortBy` / `orderBy(field, dir, { by: 'label' })` — exact ordering by the resolved label, either
    fixed (`compareForOrder`, needs a declared `displayLocale`) or per-call (`{ by: 'label' }`,
    resolves at the query's own locale — a genuinely different sort order per call, not cached).

  **BEHAVIOR CHANGES (deliberate, pre-1.0, `@next` only):**

  - **#649 — closed-vocabulary membership is now real.** The `dictKey()` doc comment always claimed
    that a declared key set was enforced on `put()`; it never actually was (the runtime `keys` array
    was silently dropped at registration). `dictKey()` itself is UNCHANGED (still open — closing
    this for the alias was explicitly out of scope, to avoid silently breaking existing dictKey
    collections). The fix landed on the native `lookup()`/`enum()`/`dict()` spellings' own
    `vocabulary: 'closed'` opt-in only.
  - **#648 — `restrict` is the default reference semantics for a declared lookup field, and it is
    now enforced.** Deleting (or `forget()`-ing) a backing dictionary/collection row that a declared
    lookup field still references now throws `DictKeyInUseError` naming the referencing collection
    and count, refusing the delete before any mutation. `DictKeyInUseError` was declared, exported,
    and documented since before this phase, but its throw site was an empty comment block — this is
    its first-ever implementation. `cascade` (tombstones/deletes the referencing records) and
    `nullify` (nulls the referencing field via an ordinary `put()`) are opt-in per declaration
    (`onDelete`), propagating additively through both plain deletes and `forget()`
    (`ForgetResult.lookupReferencesCascaded`/`lookupReferencesNullified`/`lookupReferencesResidue`,
    new additive fields — `lookupReferencesResidue` reports any `cascade`/`nullify` propagation
    skipped because a reference's compare-key couldn't be resolved even from the live pre-shred
    backing row, always empty in the ordinary case, never silent when non-empty — every pre-existing
    `ForgetResult` field is unchanged). **A plain dictionary delete with no declared
    lookup-referencing field is completely unaffected** — this only fires for dimensions a
    `lookupFields`/`via(lookup(...))` declaration actually points at.
  - **Matrix-tier `sortBy` was silently inert through Task 6; it is now functional.** `sortBy` was
    accepted at declare time on a matrix-tier (`backing: 'collection'`) lookup field since it
    shipped, but `compareForOrder` had no route for that tier — a plain `orderBy()` on such a field
    silently fell back to raw stored-code order, no warning, no error. This task wires the matrix
    branch through the same sync snapshot `presentForJoin` already reads (`registry.ts`'s
    `buildLookupSnapshotRows`, keyed by `descriptor.key`), so a `sortBy` + `displayLocale`-declared
    matrix field's plain `orderBy()` now genuinely sorts by its resolved label, same as the reserved
    tier already did. Reserved-tier `sortBy` is unaffected.
  - **#647 — reserved (`_dict_*`) collections now participate in sync.** Before this phase,
    `vault.dictionary()` writes bypassed the mutation choke point entirely (raw adapter I/O, no
    dirty-log entry) and `SyncEngine.pull()` skipped every `_`-prefixed collection by the store
    contract — dictionaries never crossed `push()`/`pull()`, only backup/bundle export. Reserved
    lookup writes now dirty-log and dispatch like any other write, and `pull()` additionally
    enumerates an explicit reserved-lookup prefix registry through the ordinary apply path.
    **Deletes travel as version-ordered delete-markers**, the same #589 law every ordinary
    collection's sync-safe delete already follows — a deleted dictionary key can no longer be
    silently resurrected by a stale peer's next push.

  **#626 retired**: `kernel/query/join.ts` no longer imports `shape/via-i18n/core.js` — it calls a
  sync `presentForJoin` hook the `Collection` builds from its own i18n + lookup bindings instead
  (now covering the matrix tier too, not just reserved). The `via-layering` architecture guard's
  allowlist (`VIA_SHAPE_ALLOWLIST`) is EMPTY, proven to still fire on a synthetic violation. The
  sibling `via-enclave-isolation` guard's allowlist (`VIA_ENCLAVE_ALLOWLIST`) has also been empty
  since phase B and gains the same synthetic-fire proof (both in `via-guards-empty.test.ts`).

  **`describe()` gains a normalized `lookup` block**, sourced from `ViaBinding.describeFragment()` —
  declared since phase A, unconsumed until now. Present alongside (not replacing) the pre-existing
  `dict` block, which stays byte-stable for the `dictKey()`/`staticDict()` alias. Carries
  `dimension`/`backing`/`vocabulary`/`key`/`altKeys`/`present`/`sortBy`/`onDelete`, and the
  statically-known closed-vocabulary key set where one exists.

  **Removed**: `vault.applyLocale()` — a full parallel i18n+dict+static label-resolution path with
  zero production callers (superseded by `via.present`, orphaned since the phase A/C cutover).
  Dead public API; no behavior change for any caller (there were none).

  See [`docs/subsystems/via.md`](../docs/subsystems/via.md) (Phase D section) and
  [`docs/subsystems/via-lookup.md`](../docs/subsystems/via-lookup.md) for the full story — the
  canonical countries-matrix example, every capability traced to its shipped test.

- The Via port (#623, phase A): a kernel-owned field-feature SPI. Everything a field can be is now a **via-feature** — a per-field declaration plugging into one phased pipeline (write: ingest → encode; read: present) with a brand-keyed binder registry generalizing the #553 declaration-links-engine pattern. **money and i18n are fully retrofitted** behind the port: the kernel imports nothing from the feature layer (closes #612), enforced by two new architecture rules (`via-layering`, `via-enclave-isolation`) with exactly two documented grandfathers (`kernel/query/join.ts` → #626; `via-i18n/dictionary.ts` → phase-B ViaCryptoCtx). New public surface (additive): `via(...)` composer + the `viaFields` collection option — existing spellings (`moneyFields`, `i18nFields`, `dictKeyFields`) are preserved as sugar compiling to identical bindings (byte-identical stored envelopes, identical `describe()`). Also: an origin-tagged mutation choke point lands with strict behavior parity (the socket phase C plugs the dependency graph into — #621/#622); generic path utilities moved to `kernel/paths`; `I18nStrategy`/`NO_I18N`/dict predicates moved to the kernel port (`port/with/i18n-strategy`). Folder moves: `with-shape/money` → `shape/via-money`, `with-shape/i18n` → `shape/via-i18n` (subpath exports unchanged). Kernel net effect: collection.ts −232 lines (first ratchet-down since Phase 5); 20 money call sites + 10 i18n value bindings + 7 type inversions collapse to one grandfathered import. Upgrade note: materialized views with money `where()` clauses re-materialize once after upgrade (query-hash format changed; self-healing). Behavior is otherwise unchanged — the full money/i18n suites pass unmodified.
- **Behavior change:** on a collection that declares `tiers`, a tier-0 `put()` or `delete()` targeting an **elevated** (`_tier > 0`) record now throws the new `TierWriteRefusedError` instead of succeeding (#715, #716). Use `putAtTier()` / `elevate()` / `demote()` — the tier-aware paths — which are unaffected, as are tier-0 records and any collection that never declares `tiers`.

  Previously such a write **silently demoted** the record to tier 0 with no clearance check and no cross-tier audit event, destroying the elevated content: because elevated records correctly read as _missing_ on tier-0 surfaces, `put()` treated the id as a create — and a create at tier 0 is a demotion. `delete()` was worse in a quieter way: its marker carried no tier, so it **erased the elevation signal** and the record's prior versions re-decrypted through `history()`. Refusing at the two write choke points also makes the write path's remaining ungated decodes unreachable, including a CRDT branch that threw a raw crypto error and a lazy path that wrote a history snapshot of the elevated plaintext.

  Note on hooks: `onBeforeWrite` user hooks still fire for a refused put (consistent with every other `put()` rejection, e.g. schema validation) and receive a **null** prior for the elevated record, never its plaintext. `beforePut` **gate** handlers do not fire at all — the refusal precedes the gate bus.

  Known residue, tracked: writes made by internal machinery are not gated — derivation/materialized-view cleanup deletes (#718) and sync-apply / coordinated-cutover migration rewrites (#708) can still drop an elevated record's tier. An elevated record's prior versions also remain decryptable at rest until history keys are rewrapped on elevation (#712).

### Patch Changes

- **BREAKING (embeddings, `@next` only) — `_vec` embedding sidecars are now collection-namespaced
  (#726).** `_vec` rows used to be keyed by the bare record id, vault-wide — two collections sharing
  a record id shared one `_vec` row. This was NOT a confidentiality leak: every collection has its
  own DEK, and AES-GCM auth-tag verification means decrypting a foreign collection's `_vec` row under
  the wrong DEK throws `TamperedError` rather than returning wrong plaintext, so no cross-collection
  content ever surfaced. The actual bug was id collision: `put()`/`elevate()`/`forget()` in one
  collection could **clobber or delete** a same-id sidecar owned by another collection, and a
  collection whose `similarTo()` / cold semantic `retrieve()` encountered a foreign same-id row
  **crashed with an uncaught `TamperedError`** (a denial-of-service, not a disclosure). The store
  bucket stays the literal `'_vec'`; the id is now composite (`<collection>/<recordId>`, via the new
  `encodeVecId`/`decodeVecId`/`isVecIdFor` helpers in `with-lookup/embeddings/vec-id.ts`), which
  eliminates both the clobber and the crash and structurally precludes even a theoretical
  cross-collection read.

  **Migration: no dual-read fallback.** A read-time fallback to the legacy bare-id key would be
  unsound in the colliding-id case — which collection a legacy `_vec/<id>` row belongs to is
  irreducibly ambiguous. Consumers with embeddings already populated on `@next` should expect a
  **recall gap** for un-rewritten records: an existing bare-id `_vec` row becomes unreachable
  ciphertext residue (fails safe — toward not-found, never toward wrong-record-surfaced) until the
  owning record is rewritten. `embedOnWrite` re-derives and re-persists the sidecar on every `put()`
  when embeddings are declared, so any record written after upgrading self-heals for free — no action
  needed beyond a normal `put()`. Sidecars are a pure function of live plaintext + model, so they are
  always re-derivable.

  An opt-in bulk re-embed/rebuild utility (mirroring the `Vault.migrateSatellitePerRecordKeys()`
  precedent, for consumers who want to close the recall gap proactively rather than wait for organic
  rewrites) is a planned follow-up, tracked separately as #788.

- `elevate()`/`demote()`/`putAtTier()` now snapshot the pre-move version into `_history` (#728). Previously a tier move bumped `_v` and overwrote the live envelope without ever saving the version that existed just before the move, so `history()`/`getVersion()` silently lost it. The snapshot reuses the SAME `rewrapBodyToDek(envelope, fromDek, toDek)` rewrap each function already computes for its live write (`putAtTier` computes one more, over the record it's about to overwrite), so it lands wrapped under the DESTINATION tier's DEK — never `ctx.codec.encryptRecord`, which always resolves the tier-0 DEK and would have leaked the pre-move body at rest whenever the prior tier was above 0. The snapshot is untagged (`_tier`/`_elevatedBy` stripped, matching an ordinary `put()` history entry) so the read-gate doesn't hide it permanently once the record demotes back — at-rest protection comes from the ciphertext's DEK, not from a tag. No-op when history is disabled or no history strategy is wired.
- `vault.collection()` now refuses `tiers` + `crdt` on a collection that is (or becomes) a registered rollup/derivation/materialized-view source (#739). `RecordCodec.decryptRecordAtDek()` — the tier-aware pre-move decode `syncDerived` uses on `elevate()`/`demote()`/`putAtTier()` (#722) — has no CRDT resolution step, so a registered rollup/derivation reading a CRDT-mode tiered source saw raw `CrdtState` instead of the resolved record: its key/value fields read as `undefined` and the recompute silently no-op'd, letting the #722 derived-output-follows-tier leak back in for this one combination. Refused loudly at construction (`UnsupportedTierCompositionError`, mirrors the #724/#748/#740 tier-composition guards) instead of building CRDT-aware pre-move decode. Reliably catches rollup/derivation sources (`DerivationRegistry` is fully populated before any `vault.collection()` call reaches user code); does NOT catch a materialized-view source first constructed inside the MV's own single-query `query(db)` callback — see the doc comment in `collection-config.ts` for the exact boundary.
- `decryptResponse()` now unwraps the per-blob content CEK, resolves the tier-scoped `_blob` DEK, and verifies the content address (#757). Previously it decrypted chunks directly under the flat `_blob` DEK, so it was **broken for every erasable (`perRecordKeys`) blob** (whose chunks live under a per-blob CEK), tier-blind, and — because it decrypts caller-provided ciphertext with no integrity check beyond AEAD — a **silent substitution side door**: a holder of the flat `_blob` DEK could feed forged, self-consistent bytes and have them returned as genuine content. It now resolves the chunk key via `resolveChunkKey` (unwrapping `_cek`), resolves the blob DEK at the owner/cleared tier (so a cleared `atTier()` read works, an elevated record stays invisible to an uncleared caller), and recomputes `hmacSha256Hex(blobDEK, plaintext)` against the requested eTag — throwing `TamperedError` on mismatch (the same content-address defense the main read paths got in #749). Multi-chunk blobs, which this single-Response API shape cannot carry, are now refused loudly (`ValidationError`) instead of silently mis-decrypting.
- A permanently-stuck persisted-search-index compensation no longer aborts a tier move (#764). The sticky compensation retry from #725 rethrew the raw adapter error uncaught, so a genuinely permanent failure (e.g. a read-only store) would abort `elevate()`/`demote()` mid-flight — after the record's tier-move write landed but before ledger/derived sync — and recur on every future move for that collection. The stuck compensation is now a distinguishable `PersistedIndexCompensationError` (wrapping the raw error as `cause`), and `elevate()`/`demote()` catch it and complete the move — reporting the deferred search-index purge via a new `TierMoveResult { searchResidue: boolean }` return — instead of aborting. Only the compensation-stuck case is caught; any other search failure still propagates.
- `putAtTier()` now registers the record's subject ref in the forget index (#766). A record whose FIRST persistence was `putAtTier(id, rec, tier)` — the sensitive-from-birth pattern — previously bypassed the write-hook pipeline that maintains `_subject_index`, so `vault.forget(subjectId)` silently never found it: an unforgettable record, a GDPR-erasure gap. `putAtTier` now registers the ref through the same path `Collection.put()` uses (idempotent, no-op when no forget strategy is declared, and consistent with the existing `put()`+`elevate()` flow which already leaves the ref in the index). `elevate()`/`demote()` are unaffected — they operate only on records that already exist (and were therefore already registered).
- Two milestone-34 follow-ups. The `describeExtraction` dry-run preview now surfaces `danglingRefs` (with a `reason: 'missing' | 'elevated'` discriminant), so a caller who previews a partition sees that an FK will dangle — matching what the actual `extractPartition` result reports (#772). And `putAtTier()` now routes its search-index purge through the same `syncSearchResilient` guard `elevate()`/`demote()` use, so a permanently-stuck persisted-index compensation no longer aborts the write mid-flight — the record is written and the deferred search purge is reported via `TierMoveResult { searchResidue }` (#774, the putAtTier sibling of #764).
- Two MV/derivation candor follow-ups. A same-collection Query-form materialized view whose input filter matched a field its output copies could **self-perpetuate** — its stale output row re-satisfied the MV's own filter on the next eager refresh, re-deriving after the true source was deleted/forgotten (a forgotten record's contribution reappearing via its own orphaned output). The executor's input scan now excludes rows stamped with the MV's own `_materializedFrom.mvName` before they feed materialization or the tombstone diff (#777). Separately, `forget()` erasure candor improves: an MV output row that is elevated above tier 0 and can't be decoded under the default DEK is now surfaced as `ForgetResult.derivedResidueUndecodable` instead of being silently skipped (#776a), and the eager executor's tombstone leg now counts only rows it actually erased — a `#718`-skipped elevated row no longer over-reports as erased (#776b).
- Two final erasure-candor follow-ups. The eager materialized-view executor's tombstone leg now surfaces residue instead of silently skipping: an MV output row that is elevated-and-undecodable, or decoded-and-owned but undeletable (the `#718` tier gate declined), is reported via `ForgetResult.derivedResidueUndecodable` on both the eager and lazy invalidation paths — closing a silent-survival gap on the eager `forget()` path (#782). A legitimate other-owner/other-MV row (stamp mismatch) is still correctly skipped, never reported as residue. Separately, the `vault.elevate(...).collection().put()` convenience path now surfaces the `TierMoveResult { searchResidue }` signal (previously discarded), so a caller can tell whether a stuck search-index compensation left residue on that write (#779).
- **Audit precision (`@next` only) — MV forget/refresh residue now splits undecodable vs. declined
  (#785).** `ForgetResult.derivedResidueUndecodable` used to fold two compliance-distinct outcomes
  into one array: (1) an MV output row whose `_materializedFrom` ownership stamp could not be
  decoded (undecodable under the default DEK — ownership **unconfirmed**), and (2) a row that DID
  decode and stamp-match but whose erasure was declined by the #718 tier-elevation gate (ownership
  **confirmed**, a live tier-holder-decryptable copy deliberately retained). An auditor reading the
  field name as "couldn't tell" was, for the second case, wrong — the system knew exactly whose data
  it was and chose to keep it.

  `derivedResidueUndecodable` is now narrowed to undecodable-only; a new `derivedResidueDeclined`
  carries the #718-declined rows. The split threads all the way down: `RefreshResult` (the
  `with-formula/materialized-views/executor.ts` `refresh()` return, also the shape of the **public**
  `vault.refreshView()`) gains `residueUndecodable`/`residueDeclined` in place of the single
  `residue` field; `invalidateMVAtRest`'s return does the same; `dispatchMaterializedViewsOnDelete`
  and `ForgetFanoutStats` mirror it. `vault.refreshView()`'s return shape changes as part of this —
  acceptable since the whole campaign is unpublished on `@next`.

  No behavior changes: every row that was previously reported now still is, just routed into the
  array matching its actual reason.

- Blob writes (`put`/`adoptExternal`/`publish`) now refuse a record id, slot name, or version label that contains `::` or starts/ends with `:` (`ValidationError`, #752). `::` is the blob version-key separator; without the guard, ids like `a` and `a::x` (or the boundary case `a:`) made the `{recordId}::` prefix scans match across records — which escalated from a mis-read to destructive cross-record erasure once `forget()` began shredding published versions (#750). The rule makes the `::`-joined key grammar prefix-free by construction. Write-surface only: pre-existing `::`/boundary-colon data stays readable, sheddable, and tier-movable (a constructor throw would have broken `forget()` on such records); re-put under a clean id to clear the legacy ambiguity.
- Crash-safe tier-move blob rehome (#746) + tier-aware migrate() (#756), completing the blob durability journal (#753 shipped the shred half). A tier move (`elevate`/`demote`/`putAtTier`) that re-keys a record's blobs to the destination tier's DEK is now journaled: destination refCount increments are row-scoped stamped so a crash mid-move can't over-count (and thus never strand content undecryptable-but-alive), and `rehomeForTier` resumes with per-step from-then-to tolerance — a half-moved record heals on the next tier op or blob touch instead of staying silently split across tiers at rest. `forget()` resumes a pending rehome to completion before erasing (so a half-moved blob a row no longer references can't survive erasure), and a shred supersedes a pending rehome the other way. `migrate()` (legacy-blob → per-record-CEK upgrade) is now tier-aware — it no longer throws `TamperedError` on a previously-elevated record and skips already-erasable blobs. No swallowed releases under a marker: a failed from-tier crypto-shred during a rehome surfaces rather than silently dropping. Known residuals (documented for the audit): a version whose eTag is held only by a published version (never a slot) can read `null` after a crash between its release and metadata write (availability only); and rehome destination-increment idempotency has one intrinsic non-atomic window — the refCount `+1` and the marker's `appliedStamps` append are separate writes (`+1` first, deliberately, so a crash can only over-retain, never under-count and data-loss), so a crash in that window plus ≥8 concurrent rehomes converging on one shared destination before resume can still over-count (retained-too-long, not a leak of readable content).
- Crash-safe blob erasure (#753). `shredAllForRecord` (the `forget()` blob arm) is now journaled: `forget()` mints an encrypted intent marker (reserved `_blob_intent` collection) BEFORE the tombstone, each refCount release is stamped atomically in its CAS write (bounded `lastOps` ring on the `BlobObject`), and every blob mutator resumes a pending shred before proceeding. A crash at any point — mid-release, between a decrement-to-zero and its chunk deletion, before or after row deletion — now resumes to exactly-once semantics: a co-owned blob can never be over-released by a retry (the destructive case), and an elevated record's holds are never stranded by the tombstone (the permanent-leak case). Markers travel in backups; two-tab terminal-race residue is documented. Rehome journaling (#746) and migrate() tier-awareness (#756) follow on these primitives.
- Tiers×blobs completeness (#747, #749). The `BlobObject` index envelope (size/mimeType/compression/chunkCount/refCount/createdAt) now follows its eTag's tier `_blob` DEK, so an elevated record's blob metadata is no longer readable by a tier-0 DEK holder at rest — content was already tier-isolated (#724); this closes the metadata sidecar. Dedup-policy shared blobs and legacy blobs legitimately stay under the flat DEK (documented residue; reads fall back, and a cleared read that resolves via the flat fallback re-verifies the content address — `hmacSha256Hex(flatDEK, plaintext)` against the requested eTag — so a tier-0 key holder with raw store write access cannot silently substitute an elevated blob's content; forged rows throw `TamperedError`). Known accepted residue: `blobInfo()`/`list()` metadata on a cleared view is not content-verified (no content fetch happens there). No migration: the tiers×blobs arc has never been published. And `blob(id).atTier()` is the new sanctioned cleared-read path to an elevated record's blobs — the `getAtTier` analogue, gated by `assertTierAccess` on the caller's keyring for BOTH the data collection and the `_blob` tier DEK BEFORE any key resolution (an ungranted or partially-granted caller gets `TierNotGrantedError` and no key material is minted), while plain `blob(id)` keeps treating the elevated record's blobs as nonexistent.
- Partition extraction is now tier- and journal-aware (#759, #767, #769). `walkClosure`'s outbound-completion phase re-checks a referenced FK parent's tier visibility (the same gate root selection and inbound expansion already use): an elevated (or missing) parent is skipped rather than admitted — no longer crashing `reKeyClosure` on an undecryptable elevated record — and the resulting dangling FK is surfaced as a `danglingRefs` notice on the extraction result so the caller knows the child's reference points outside the partition. In-flight `_blob_intent` crash-recovery markers are now carried into an extracted partition (re-keyed under the destination DEK) so resume-on-touch heals a mid-shred/mid-rehome record after restore, mirroring the full-vault backup allowlist. The per-slot `pendingRelease` resume breadcrumb is stripped from partition slot records (it is a source-vault-local pointer, meaningless cross-vault) while full-vault `dump()` deliberately retains it (same-vault-resumable) — the asymmetry is documented.
- Elevating a record now removes its contribution from **eager** derived outputs — materialized-view rows, rollup values, and `withDerivation` outputs (#722). These are computed from a source record and written to output collections at tier 0, holding the source's plaintext; `elevate()` previously left them, so any tier-0 caller could read an elevated record's derived plaintext there. On a tier move, the record's eager derived outputs are recomputed from the tier-aware cache — which excludes elevated records — so a record-grain view row is deleted and an aggregate/rollup drops the elevated contribution. `demote()` (and `putAtTier()` back to tier 0) restore it: the change is fully reversible. Recompute reuses the same fanout `forget()` uses and reads only the tier-gated cache, so it never re-materializes the elevated plaintext.

  Scope and known residuals (all shared with `forget()`'s fanout, tracked separately): this covers **eager** materialized views; a **lazy or manual** MV keeps its stale persisted output row until its next refresh, so a cold-session tier-0 read can still serve the pre-elevation row (#736). A rollup contribution baked into a **frozen** period is not recomputed (freeze law). For **aggregate** views and rollups, the value changes observably when a contributor is elevated (a tier-0 observer can infer that a record with roughly that contribution was elevated) — an accepted property, since `_tier` is already store-visible metadata. A tier move on a collection with no derivations does no extra work (the record decode is gated on the presence of a derivation/materialized-view source).

- Fix three `describe()` fidelity gaps (#657):

  - A field declared only via `blobFields` was invisible in `describe()` — or, with a `fieldMeta` entry, appeared as `type:'unknown', widget:'text', editable:true`, actively wrong for binary content. The `'blob'` binding's `describeFragment()` is now consumed (mirroring the existing `'lookup'` consumer), so a blobFields field always appears with `type:'blob'`, `widget:'file'`, `editable:false`, and a `blob: { retainDays, ..., queryable:'none' }` block.
  - Async `describe({}).constraints` no longer leaks zod's `.int()` ±`Number.MAX_SAFE_INTEGER` safe-integer sentinel as `minimum`/`maximum` — those are JS-representability facts, not authored validation intent. An authored bound on a non-`.int()` field is untouched.
  - The static tier of `lookup()`/`dict()` (table-backed, no declared `keys`) now emits `lookup.keys` from the table's own key set, matching the `DescribedField.lookup` docblock's promise. Reserved/matrix tiers are unaffected.

  - Note: `toJSONSchema()` currently degrades the new `type: 'blob'` to JSON-Schema `type: 'string'` with no marker — a describe()-only fidelity pass; the JSON-Schema story is a separate follow-up.

- Tiers × external-projection guards (#748). `adoptExternal()`/`setExternalMeta()` now require the slot to be a declared `blobFields[slot].external` field (`ValidationError`) — they previously bypassed both `put()`'s declaration gate and the construction-time tiers mandate. Declaring `tiers` together with an external blob field marked `public: true` is now refused at construction (`UnsupportedTierCompositionError`): the object key is deterministic and the bytes world-readable by design, so elevation can never make that content invisible — use a presigned/private external field or a non-tiered collection. Private/presigned external fields on tiered collections are unaffected. Extraction hardening: `reKeyClosure`/`reKeyBlobs` carry defense-in-depth canaries (`PartitionExtractionError`) refusing any elevated envelope reaching a partition, and a regression test pins that elevated records are excluded from closure roots and inbound expansion (the outbound-completion gap is tracked as #759).
- `vault.forget()` erasure now covers two residue classes it previously left at rest (#734, #750). (1) The forgotten record's plaintext `_ledger_deltas` rows are purged via the #729 primitive — chain-safe (`verify()` recomputes the tamper-chain from the retained entries, never the delta rows), with the count reported as `ForgetResult.ledgerDeltasPurged` and failures surfaced in `ForgetResult.ledgerDeltaResidue` rather than swallowed. As part of this, forget() without a history strategy now fails FAST with nothing shredded (was: shred everything, then throw on the summary-entry step). (2) `shredAllForRecord` now enumerates the record's published blob versions (`_blob_versions_*`): each version's independent refCount hold is released (crypto-shredding version-held content at refCount 0, retaining shared content for co-owners) and the version rows are deleted; an unreadable version row is reported as blob residue and left in place rather than blind-deleted (which would orphan its refCount hold).
- Elevating a record now re-keys its history snapshots to the tier DEK, so an elevated record's prior versions are no longer decryptable at rest under the collection's tier-0 DEK (#712 — completing the fix whose read-gate shipped earlier). Each `_history` snapshot carries its own tier-0-wrapped key material, which `elevate()` previously left untouched — so any tier-0 holder could recover a prior version's plaintext at rest even though `history()`/`getVersion()` returned nothing. `elevate()`, `demote()`, and `putAtTier()` now rewrap every history snapshot's key from the record's current-tier DEK to its new-tier DEK (via the enclave's `rewrapEnvelope`, reusing the vetted `rewrapBodyToDek`); `demote()` restores tier-0 readability. This is defense-in-depth beneath the read-gate: the ciphertext is protected even if the gate is bypassed. A record elevated before this release keeps tier-0-wrapped history until its next tier move, handled by a tier-0 fallback in the rewrap.

  **Whole-branch review fixes (same PR):**

  - **`putAtTier` now also asserts access to the record's EXISTING tier**, not just the target tier. Previously, a caller cleared only for the target tier could `putAtTier` over a record parked at a tier they'd never been granted; the history-rewrap's from-tier `getDEK` would then silently mint a fresh tier DEK into their keyring — a non-cleared caller creating tier key material. `putAtTier` over a record whose current tier you don't hold is now refused (`TierNotGrantedError`) instead of silently minting — this is an intended, correct behavior change (you can't move a record you can't see); owner/admin/custodian are unaffected (they may still mint).
  - **`syncHistory` now runs LAST** in `elevate`/`demote`/`putAtTier` (after indexes/cache/search are synced), so a `syncHistory` failure strands only its own `_history` artifact instead of leaving a moved-tier live record with unsynced cache/indexes/search on the error path.
  - **`rewrapHistory` gained a toDek-first idempotency skip**: before rewrapping an entry, it checks whether the entry is already wrapped under `toDek` and skips it if so. This makes same-target retries and demote-after-crash fully self-healing. **Residual limitation (accepted, fail-closed):** a crash that strands entries mid-loop under an _intermediate_ tier — i.e. some entries already moved to `toDek` from THIS call, then a later, different tier move targets yet another key — can still leave those entries permanently un-rewrappable (unreadable under `fromDek`, the tier-0 fallback, or the new call's `toDek`, since the original `toDek` is a third key nothing probes for). There is no recovery API for this window; it is availability-only (the ciphertext is never exposed under the wrong key) and considered acceptable given how narrow the trigger is (a crash exactly between two back-to-back tier moves on the same record).

- Elevating a record now purges its tier-0-era plaintext audit deltas from the ledger (#729). The audit ledger is a flat, vault-wide, tamper-evident hash-chained log; a record's reverse-JSON-Patch deltas (the exact fields that changed at each tier-0-era put) were stored in `_ledger_deltas` under a shared ledger key that `elevate()` never touched, so any tier-0 caller could reconstruct an elevated record's prior plaintext at rest. `elevate()` (and `putAtTier()` above tier 0) now delete the record's delta rows. This is chain-safe — `verify()` recomputes the tamper-chain from the ledger entries (which retain the `deltaHash`), never from the deleted delta rows, so the chain stays valid and the audit record that a change occurred (op/version/timestamp/actor) is preserved; only the change's plaintext content is removed. Two consequences by design: it is irreversible (`demote()` does not restore delta reconstruction), and the retained entry metadata still reveals that the record was mutated. `forget()` has the same unaddressed gap for its erasure path (#734, a follow-up reusing this purge).
- `listPage`/`scan`/`aggregate` skip elevated records (#706, completing the tier-0 read-surface invisibility law of #691/#701): no more elevated plaintext in page items from the elevating session (the warm-CEK-cache leak was audit-free), no more cold-session `InvalidKeyError` bricking every scan over a collection containing one elevated record, and the opportunistic page-fill can no longer poison the eager cache/indexes with elevated plaintext. Lazy `count()` now counts only live tier-0 envelopes (envelope inspection, no decryption) — parity with eager count, which also stops counting delete-markers left by sync.
- Milestone #29 sync-engine follow-ups.

  - **#653** — Partial sync (`pull`/`push({ collections })`) now auto-includes the reserved `_dict_*` dictionaries a named collection's lookup fields depend on (mirrors the satellite-pair expansion), so labels and membership no longer go stale on partially-synced instances.
  - **#606** — A per-collection marker-id set skips the redundant, usually-null `adapter.get` on every synced-eager insert that #589's re-create version-continuity gate previously forced.
  - **#693** — Under multi-tab coordination sharing one store, the re-create gate falls back to the pre-#606 unconditional store read (the marker-id set is per-instance and can't see a peer tab's out-of-band delete-marker until the relay lands) — closing a data-loss window.
  - **#658** — Sync-applied deletes now heal materialized-view rows and array-shape derivation outputs, matching the local-delete boundary (previously the sync-delete wave was rollup-only).

- Milestone #33 via follow-ups — two internal correctness fixes.

  - **#678** — `ViaGraph.assertAcyclic()`'s ref-edge filter now keys on the edge itself, not the target. Previously it re-derefed the target's `_in` entry for `kind`, which a later `registerDerived` call could have overwritten (e.g. a dual-role target registered computed-then-ref, #631's exempt composition order) — silently excluding a genuine computed edge from the cycle-detection DFS and hiding a real derivation cycle. `_out` edges now carry their own `kind` at registration; the filter and `referencingEdgesOf` both read it edge-local. Latent regression guard — not reachable in production today (`assertAcyclic()` runs once at `openVault()`, before `_in`/`_out` is populated).
  - **#677** — Lazy-mode `PersistedCollectionIndex` now canonicalizes money index keys at every bucket-mutation site (`ingest`/`upsert`/`remove`) and canonicalizes the `==`/`in` probe value before lookup, mirroring eager mode's #672 fix. A lazy-mode mixed-era (pre-money-declaration) record now agrees with the fallback scan the same way an eager one does. The end-to-end gap this fix did NOT close — `LazyQuery.where()` never built a `clause.via`, so `lazyQuery().where(moneyField, ...).toArray()` returned empty at `scale > 0`, and lazy money range clauses dispatched through `lookupRange` with no scan fallback — was tracked in #684 and is CLOSED in this same release (see the via-port lazy/index follow-ups entry).

- Milestone-34 batch D — read-gate, race, and write-ring completeness (#730, #725, #720, #718, #708). Time-machine reads (`vault.at(ts)`) now honor the tier invisibility law: an elevated record's history returns `null`/is omitted instead of an opaque decrypt error plus an id-existence reveal, and per-record-CEK snapshots decrypt correctly. Persisted full-text-index saves are epoch-guarded — a stale save is skipped before its write, a purge landing mid-save is undone by a compensating remove, and a failed compensation is retried stickily by every subsequent store operation rather than swallowed — closing the debounced-flush race that could briefly re-persist an elevated or forgotten record's text at rest (both the elevate and forget entry points are test-locked; #764 tracks stuck-compensation ergonomics). Lazy `putAtTier` resolves the prior record through a tier-gated decode, so dropping an indexed field clears its sidecar exactly like `put()` does. The write ring now covers machinery paths: internal derivation/MV cleanup deletes SKIP elevated records (tier-0 machinery treats them as nonexistent — no tier-signal erasure), and a coordinated schema cutover REFUSES loudly (`TierWriteRefusedError`) while any record is elevated, instead of silently demoting it — demote first, then cut over. Housekeeping: the tier-composition guard now lives in the tier domain (`with-audit/tiers`).
- MV/derivation erasure candor (#761, #762). Fixes a data-loss bug: the eager
  materialized-view executor's `onEmpty: 'delete'` tombstone diff listed every
  id in the output collection with no ownership filter, so a same-collection
  partition MV (`output: { collection: <source>, partition }`) wiped OTHER
  untouched user source rows on every refresh — including an ordinary
  `delete()`. The diff is now scoped to rows the MV itself stamped via
  `_materializedFrom.mvName`, the same discipline `invalidateMVAtRest` already
  used.

  Also fixes `vault.forget()` never reaching a same-collection MV — the
  partition-disjoint same-collection edge was dropped from the derived-artifact
  graph, so `forgetDerivedFanout`'s MV arm never fired for it, leaving the
  forgotten subject's contribution in the MV's output row at rest. The MV arm
  now runs unconditionally (self-guarding, O(1) no-op when the collection has
  no MV).

  Candor improvements: `ForgetResult.derivedRecordsErased` now counts lazy/manual
  MV purges (`invalidateMVAtRest`), not just the eager executor's tombstone leg;
  a `#718`-skipped elevated record (internal cleanup over an elevated row) no
  longer over-counts as erased in completeness-tracking callers.

- Derived-output tier/erasure completeness (#736, #737, #740). Invalidating a lazy or manual materialized view from `forget()` or a tier move now DELETES the MV's persisted output rows at rest (previously the pre-elevation/pre-forget plaintext row survived until an in-session refresh — and a cold session served it as fresh), and for lazy MVs persists the stale mark in the reserved `_mv_stale` collection so a cold session recomputes on first read instead of serving an empty view; a manual MV serves empty until `vault.refreshView()` (erasure wins over manual staleness). Ordinary source writes keep the cheap in-memory-only stale path. The tier-move pre-move decode gate is now source-grained (#737) — a tiered collection with no derivations of its own no longer decodes on elevate/demote when an unrelated derivation exists in the vault. And `tiers` on an `encrypted: false` collection is now refused at construction (`UnsupportedTierCompositionError`, #740) — per-record clearance IS per-tier encryption; a plaintext collection cannot honor it.
- Write-path prior reads and history reads treat elevated records as missing (#707, #712 read-gate), and lazy `count()` batches via `adapter.listPage` when the store provides it (#713).

  Write hooks, subsystem gate handlers, and the `i18nProvenance` audit accessor no longer receive an elevated record's plaintext when a tier-0 write touches it (previously the elevating session leaked it through the warm CEK cache while a cold session threw `InvalidKeyError`); the gate-prior read's swallowing `try/catch` is replaced by an explicit pre-decrypt check, so a genuine decrypt failure now fails loudly instead of silently presenting the record as absent. `history()`/`getVersion()` no longer return an elevated record's prior-version plaintext, and CRDT `getRaw()` returns `null` for an elevated record instead of throwing — history snapshots keep tier-0-wrapped keys and carry no tier of their own, so these doors gate on the live record's tier.

  Known limitations, tracked: the history read-gate can still be bypassed by a tier-0 `delete()` (which erases the elevation signal, #716) or by a `put()` (which silently demotes the record, #715); an elevated record's prior versions also remain decryptable at rest until the history keys are rewrapped on elevation (#712).

- Never pull from a `backup`/`archive` sync target (#616). `Noydb.sync()` now calls the primary engine push-only when the primary's role isn't `sync-peer`, and `Noydb.pull()` is a no-op (empty result) for a non-`sync-peer` primary — so a backup/archive-only config (where the sink was elected as the primary) is no longer pulled from. This applies the role→direction policy the secondary fan-out already used to the primary too, making the code match `sync()`'s existing "backup/archive do push-only" contract. `surface: internal` — no public API change; an explicitly constructed `SyncEngine.pull()` still pulls.
- Security (#590): sync now treats crypto-shred tombstones as terminal. `pull()` never overwrites a `forget()` tombstone with a live envelope regardless of `_v` and re-asserts the shred outward; `push()` asserts tombstones unconditionally and never conflict-resolves against one (resolvers are bypassed — an erasure cannot be overruled); `forget()` tombstones now enter the sync dirty log so the shred propagates on push. Suppressed edits are reported via `PushResult.erasures` / `PullResult.erasures` and the new `sync:erasure` event (new `ErasureEnforcement` type). Also fixes #598: every sync-applied local write now refreshes the Collection in-memory caches, so same-session readers see sync results (and never a decrypted residue of a shredded record).
- Complete the elevated-record invisibility story on tier-0 surfaces (#701, #702; extends #691). Eager cold-session hydration and the vault-snapshot hydration path skip elevated envelopes instead of throwing — a single elevated record no longer bricks the whole collection; lazy cache-miss reads return `null` in both sessions (previously the elevating session leaked tier plaintext through the warm CEK cache while cold sessions threw); `reveal()` on an elevated record throws the domain not-found error instead of a raw crypto error (no elevation disclosure). `putAtTier` now keeps the record cache coherent like `elevate`/`demote`: evict above tier 0, canonical re-seed at tier 0.
- Declaring `blobFields` on a `tiers`-enabled collection is now refused at registration with `UnsupportedTierCompositionError` (#724). An elevated record's blob content is not yet tier-aware — the blob chunks use a vault-shared key that tier moves don't re-key, and `collection.blob(id)` isn't tier-gated, so the content stays readable at rest and through the blob API even when `get()` correctly returns null. Until a blob tier handler ships, the composition is refused rather than left to leak silently (a forward-compatible "not yet supported" wall, mirroring `unique` + `tiers`). Note: the guard catches the declared-`blobFields` case; ad-hoc `collection.blob(id)` use on a tiered collection without declared fields is tracked separately in #724. The already-supported tier compositions — field indexes, full-text/vector search, and history — are unaffected.
- Tier-0 read paths treat elevated records as missing instead of throwing on tier-wrapped key material (#691). `verify`/`verifyGroup` return the padded `{ok:false}` verdict (no elevation oracle, C4 pad path identical to a missing record), `findByDigest` drops the elevated hit without aborting the scan, and `findByDet`/`queryByDet` skip elevated envelopes — deterministically, regardless of CEK-cache state, closing the elevating-session leak that bypassed the cross-tier audit trail. Tier moves now maintain the record cache (`elevate`/`demote` evict after the write lands; demote-to-tier-0 re-seeds, so demoted records stay plain-readable), and `elevate`/`demote` on a deleted/tombstoned id throw the domain not-found error instead of `TamperedError`.
- Elevating a record now removes it from tier-0 indexes (#709). Previously its persisted index side-cars (`_idx/<field>/<recordId>`) survived the tier move holding the indexed field's **plaintext value**, always encrypted under the collection's tier-0 DEK whatever the record's own tier — so elevating a record never hid what it was indexed by, and any tier-0 caller could read the value back. `elevate()` (and `putAtTier()` above tier 0) now purge the record's side-cars and drop its in-memory index entries; `demote()` and a tier-0 `putAtTier()` rebuild them from the record. This applies to `elevate()` the same fix `forget()` already had via `purgePersistedIndexes`.

  Index rebuild and reconcile now skip elevated records instead of decrypting them: previously the elevating session's warm key cache let the decrypt succeed and **minted a fresh tier-0 side-car** from the elevated record's plaintext (reconcile would even re-create one that had been deleted), while a cold session threw and bricked the whole operation.

  A tier-0 `putAtTier()` also refreshes the record's index entries, fixing a stale-entry false positive: a query on the record's **old** field value could return it, because an index hit is not re-verified against the record.

  Intended consequence: an elevated record is not present in any **secondary (field) index**, so it is not findable by structured index-driven queries — including from a session that holds its tier DEK. `getAtTier()` / `listAtTier()` remain the tier-aware read surfaces. Unique indexes were already refused on tiered collections, and are unaffected.

  This covers field indexes only. The **search** subsystem is not yet tier-aware: full-text (`retrieve()`) and vector (`similarTo()`) indexes still retain an elevated record's derived plaintext and can still surface it (#721), and materialized-view / rollup outputs derived from a record survive its elevation (#722).

- Elevating a record now removes it from full-text and semantic search (#721). Previously the persisted lexical index (`_ftindex`) held each record's **complete verbatim indexed text**, and the embedding sidecar (`_vec/<recordId>`) held its text-invertible vector — both encrypted under the collection's tier-0 DEK whatever the record's own tier, and neither touched by `elevate()`. So elevating a record never hid what it was searchable by: any tier-0 caller could read the verbatim text out of the at-rest `_ftindex` blob, and even a cold `similarTo()` surfaced the elevated record's id and similarity score. `elevate()` (and `putAtTier()` above tier 0) now purge the `_vec` sidecar and delete the stale `_ftindex` blob; `demote()` and a tier-0 `putAtTier()` re-embed and rebuild. As defense against a legacy or failed-purge sidecar, the vector loader also skips `_vec` rows whose owning record is elevated. This applies to `elevate()` the same purge `forget()` already had.

  Intended consequence: an elevated record is not present in any search index, so it is not findable by `retrieve()` or `similarTo()` — including from a session that holds its tier DEK — until it is demoted. `getAtTier()` / `listAtTier()` remain the tier-aware read surfaces.

  With #723's field indexes, this closes the derived-index surface. Materialized-view / rollup outputs derived from a record still survive its elevation (#722), and blob content may (#724, unverified); an elevated record's prior history versions remain decryptable at rest until #712; and a debounced index flush racing the purge can briefly re-persist a stale `_ftindex` blob (#725).

- Via hardening round 2 (milestone #30 closure batch): nine small, independent hardening fixes on
  top of the merged via-consolidation pass, plus a build-script rider. No shipped consumer uses any
  of the affected surfaces yet (pre-1.0).

  - **#632** — the static-import scanner (`scripts/check-architecture.mjs`) now also catches
    side-effect imports (`import './x.js'`) and default imports (`import x from './x.js'`), not just
    named/namespace imports. Both new forms are proven by a synthetic-violation canary; the guard
    stays green on the real tree.
  - **#645** — the reconcile computed-deps validator's "known fields" universe now unions
    `ViaGraph`'s own field memory with the current call's options-derived set. A two-call scenario
    (classified field declared in call 1, a computed field's `deps` naming it in call 2) no longer
    spuriously refuses with "does not name a declared field".
  - **#631** — a declare-time cross-binding guard refuses two different binding families (e.g.
    `moneyFields` + `blobFields`) claiming the same field name. The exemption set is earned, not
    assumed: `{computed,money}`, `{computed,i18n}`, and `{computed,lookup}` compositions are proven
    legal by dedicated pins, and the guard is tightened to exactly-two-claimants. Classified/blob
    collisions always refuse. The guard is construction-time; the late-attach reconcile path remains
    narrower (a colliding re-open still half-applies as before — tracked follow-up).
  - **#652** — lookup ingest now normalizes an array-valued (`[].`-wildcard) field element-wise,
    matching `enforceWrite`'s existing all-elements semantics, instead of bailing on
    `values.length !== 1`. Single-value behavior is unchanged. (Bare-array — non-`[].`-wildcard —
    shape is a separate, still-open gap tracked by #661.)
  - **#635** — an elevated-tier (`tier > 0`) read now processes `_sealed` slots through the same
    `applySealedSlots` codec helper `decryptRecord` already uses, instead of falling back to raw
    plaintext-shaped JSON. Tier-0 and tier>0 reads now share one contract. (The write-side
    elevate/demote gap is separate and tracked by #662.)
  - **#627** — `viaFields` sugar (e.g. `viaFields: { price: money('EUR') }`) now participates in the
    late-attach reconcile path the same way the raw `moneyFields` sugar key already did — driven off
    the merged `mergeViaFields` view, not the raw sugar key alone. A colliding late-attach
    declaration now refuses loudly instead of silently no-op'ing.
  - **#634** — `exportRedact`'s `(coll as any).via` reach-in is replaced by a typed internal `_via`
    accessor; no behavior change, just removes the any-cast.
  - **#641** — lazy materialized-view resolve-on-read now respects the frozen-output rule in both
    strict and non-strict modes: a read whose MV output row falls in a frozen period returns the
    historical row, skips the write, and emits `derivation:skipped-frozen` — it no longer lets a
    `PeriodClosedError` escape through a read path.
  - **#646** — the two remaining vacuous two-instance sync pins (`mutation-choke-point.test.ts`'s
    MV sync-apply pin, `sync-dispatch.test.ts`'s id-threaded-decrypt pin) are retrofitted to
    db2-only strategy registration, so a passing assertion can only be satisfied by the puller's own
    wave-driven dispatch, not a shared-store write riding along from the local writer. Adds the two
    net-new tests the issue's mutation-testing pass flagged as missing: cm23 (a virtual computed
    field's structural absence from the sync payload, proven end-to-end over a real push()/pull()
    cycle) and cm15 (the reconcile cross-read taint assertion, replayed against a fresh session so
    the read is envelope-empirical rather than served from the writer's own warm cache).

  Rider: the hub package's `build` script now carries the DTS worker's heap flag via `execArgv`
  instead of requiring it in the caller's environment — plain `pnpm build` works with no env setup.
  (#660 tracks the underlying type-surface fix that makes the larger heap necessary in the first
  place.)

- Via-port follow-ups — lazy/index correctness.

  - **#684** — Lazy queries are now Via-aware end-to-end. `LazyQuery.where()` builds a `clause.via` and the lazy post-filter runs against the RAW stored record (mirroring eager: filter stored-form, decode survivors on output), fixing money (and any decode-transforming via) lazy queries that previously returned empty at `scale > 0` under every query spelling. Money range clauses enumerate the field index and post-filter via-aware (closing the no-scan-fallback hole); `==`/`in` prefer `clause.via.indexValue`, and the `queryable: 'none'` posture guard + multi-currency `==`/`in` now match eager. The `LazyQuerySource` shape on the `@noy-db/hub/indexing` subpath changed (a raw-fetch seam added) — pre-1.0, no external implementer exists. Lazy `orderBy` ordering parity for money is a separate, still-open item (#695).
  - **#695** — Lazy `orderBy` on a money field is now Via-aware: `toArray()` sorts the RAW survivors via `ViaPipeline.compareForOrder` (scaled BigInt compare, mirroring eager) and decodes only the returned page, so money orders numerically instead of lexicographically (`'10.00'` no longer sorts before `'2.00'`).
  - **#696** — The lazy composite-index `==` fast path is skipped when a covered clause is Via-covered (money), falling through to the already-Via-aware single-field path — a money field in a composite index no longer misses (returned `[]`).
  - **#698** — Lazy now decomposes a composite index into its component single-field indexes on declare (matching eager), so a composite-ONLY declaration serves single-field queries and the #696 fall-through instead of throwing `IndexRequiredError`. (Adds per-component single-field side-cars, the same tradeoff eager makes.)
  - **#686** — Late-attaching `money()` (a second `vault.collection()` call) onto an already-built EAGER index now re-canonicalizes the existing buckets, so rows indexed before the money declaration are no longer silently under-returned by canonical `==`/`in` probes until the next rebuild.
  - **#687** — Documented (as an accepted known limitation) the narrow satellites fan-out post-`onDirty`-dispatch-throw orphaned-dirty-entry hazard (harm: one self-healing sync-push cycle), and hardened the pair-delete revert test with a direct dirty-log assertion.
  - @noy-db/attestation@0.3.0

## 0.3.0-pre.13

### Minor Changes

- New opt-in `Collection.rebuildEmbeddings(): Promise<{ rebuilt: number; skipped: number }>`
  (#788) — force-re-derive every eligible tier-0 record's `_vec` embedding sidecar once. Closes the
  recall gap #726 left open: `_vec` rows are now collection-namespaced (`<collection>/<recordId>`),
  so any pre-#726 bare-id sidecar is unreachable residue that previously only self-healed when its
  owning record was next `put()`. Calling `rebuildEmbeddings()` walks every live record and
  re-derives its sidecar immediately, without waiting for organic writes.

  Gated behind `searchStrategy: withSearch()`, mirroring every other search/retrieval method — a
  collection that never declared `embeddings` returns `{ rebuilt: 0, skipped: 0 }` without touching
  the strategy at all, and a collection that declared `embeddings` but never opted into
  `withSearch()` throws `SearchNotEnabledError`, matching `put()`'s existing behavior.

  Elevated records are **skipped, not refused** — the opposite of the `_applyCutoverTransform`/
  `migrateSatellitePerRecordKeys` precedent, which refuses the whole batch on any elevated record.
  An elevated record is _supposed_ to have no `_vec` sidecar (`syncTierSearch` purges it on
  elevate); re-deriving one here would write searchable plaintext-derived data above tier 0. Each
  elevated record is counted in `skipped` and the walk continues to the next id. Tombstones,
  delete-marker rows, and a raw read racing a concurrent delete all decode to `null` and are
  likewise skipped. Idempotent/resumable: a partial failure (e.g. a store error mid-walk) leaves
  earlier records rebuilt; re-running completes the rest — each id's re-derive is independent.

- Blob content now follows the tier of its owning record (#724, #741). Previously `tiers` + `blobFields` was refused (`UnsupportedTierCompositionError`); that refusal is removed and the composition is supported. A blob's storage tier equals its owning record's tier: its content-CEK, chunk address (eTag), slot-map metadata, and published versions are all keyed under `getDEK(dekKey('_blob'|collection, ownerTier))`. `blob(id)` reads are tier-gated at runtime (every content and metadata accessor refuses an elevated record's blob to a tier-0 caller, before any decrypt); writes to an elevated record are keyed at that record's tier; on `elevate` the record's blobs (and published versions) are re-homed under the tier DEK, and `demote` restores them (fully reversible). `forget()` of an elevated blob-owner now correctly crypto-shreds under the record's pre-tombstone tier.

  New collection option **`blobTierPolicy?: 'isolate' | 'dedup'`** (default `'isolate'`). For a blob shared (content-deduplicated) across records, `isolate` forks a private tier-scoped copy on elevate so co-owning tier-0 records are untouched; `dedup` (#741) leaves the shared object in place — the runtime read gate still hides it, but the shared chunks remain decryptable at rest under the flat `_blob` DEK (a documented, accepted residue, analogous to #722's aggregate-inference channel). A tiered collection that declares `blobFields` must set `perRecordKeys`; writing a legacy (non-`perRecordKeys`) blob to a tiered collection is refused (legacy blobs have no per-record key and cannot be tier-isolated).

  Known residuals, tracked separately: multi-blob re-home is not crash-atomic (#746); the `BlobObject` index-envelope metadata (size/mimeType/timestamps) stays under the flat `_blob` DEK (#747); `extract-partition` and external-projection blob writes are tier-blind (#748); there is no cleared-caller `blobAtTier` read path — an elevated record's own attachment is unreachable until demote (#749); and `forget()` does not shred published versions at all (#750, pre-existing).

- **Behavior change:** on a collection that declares `tiers`, a tier-0 `put()` or `delete()` targeting an **elevated** (`_tier > 0`) record now throws the new `TierWriteRefusedError` instead of succeeding (#715, #716). Use `putAtTier()` / `elevate()` / `demote()` — the tier-aware paths — which are unaffected, as are tier-0 records and any collection that never declares `tiers`.

  Previously such a write **silently demoted** the record to tier 0 with no clearance check and no cross-tier audit event, destroying the elevated content: because elevated records correctly read as _missing_ on tier-0 surfaces, `put()` treated the id as a create — and a create at tier 0 is a demotion. `delete()` was worse in a quieter way: its marker carried no tier, so it **erased the elevation signal** and the record's prior versions re-decrypted through `history()`. Refusing at the two write choke points also makes the write path's remaining ungated decodes unreachable, including a CRDT branch that threw a raw crypto error and a lazy path that wrote a history snapshot of the elevated plaintext.

  Note on hooks: `onBeforeWrite` user hooks still fire for a refused put (consistent with every other `put()` rejection, e.g. schema validation) and receive a **null** prior for the elevated record, never its plaintext. `beforePut` **gate** handlers do not fire at all — the refusal precedes the gate bus.

  Known residue, tracked: writes made by internal machinery are not gated — derivation/materialized-view cleanup deletes (#718) and sync-apply / coordinated-cutover migration rewrites (#708) can still drop an elevated record's tier. An elevated record's prior versions also remain decryptable at rest until history keys are rewrapped on elevation (#712).

### Patch Changes

- **BREAKING (embeddings, `@next` only) — `_vec` embedding sidecars are now collection-namespaced
  (#726).** `_vec` rows used to be keyed by the bare record id, vault-wide — two collections sharing
  a record id shared one `_vec` row. This was NOT a confidentiality leak: every collection has its
  own DEK, and AES-GCM auth-tag verification means decrypting a foreign collection's `_vec` row under
  the wrong DEK throws `TamperedError` rather than returning wrong plaintext, so no cross-collection
  content ever surfaced. The actual bug was id collision: `put()`/`elevate()`/`forget()` in one
  collection could **clobber or delete** a same-id sidecar owned by another collection, and a
  collection whose `similarTo()` / cold semantic `retrieve()` encountered a foreign same-id row
  **crashed with an uncaught `TamperedError`** (a denial-of-service, not a disclosure). The store
  bucket stays the literal `'_vec'`; the id is now composite (`<collection>/<recordId>`, via the new
  `encodeVecId`/`decodeVecId`/`isVecIdFor` helpers in `with-lookup/embeddings/vec-id.ts`), which
  eliminates both the clobber and the crash and structurally precludes even a theoretical
  cross-collection read.

  **Migration: no dual-read fallback.** A read-time fallback to the legacy bare-id key would be
  unsound in the colliding-id case — which collection a legacy `_vec/<id>` row belongs to is
  irreducibly ambiguous. Consumers with embeddings already populated on `@next` should expect a
  **recall gap** for un-rewritten records: an existing bare-id `_vec` row becomes unreachable
  ciphertext residue (fails safe — toward not-found, never toward wrong-record-surfaced) until the
  owning record is rewritten. `embedOnWrite` re-derives and re-persists the sidecar on every `put()`
  when embeddings are declared, so any record written after upgrading self-heals for free — no action
  needed beyond a normal `put()`. Sidecars are a pure function of live plaintext + model, so they are
  always re-derivable.

  An opt-in bulk re-embed/rebuild utility (mirroring the `Vault.migrateSatellitePerRecordKeys()`
  precedent, for consumers who want to close the recall gap proactively rather than wait for organic
  rewrites) is a planned follow-up, tracked separately as #788.

- `elevate()`/`demote()`/`putAtTier()` now snapshot the pre-move version into `_history` (#728). Previously a tier move bumped `_v` and overwrote the live envelope without ever saving the version that existed just before the move, so `history()`/`getVersion()` silently lost it. The snapshot reuses the SAME `rewrapBodyToDek(envelope, fromDek, toDek)` rewrap each function already computes for its live write (`putAtTier` computes one more, over the record it's about to overwrite), so it lands wrapped under the DESTINATION tier's DEK — never `ctx.codec.encryptRecord`, which always resolves the tier-0 DEK and would have leaked the pre-move body at rest whenever the prior tier was above 0. The snapshot is untagged (`_tier`/`_elevatedBy` stripped, matching an ordinary `put()` history entry) so the read-gate doesn't hide it permanently once the record demotes back — at-rest protection comes from the ciphertext's DEK, not from a tag. No-op when history is disabled or no history strategy is wired.
- `vault.collection()` now refuses `tiers` + `crdt` on a collection that is (or becomes) a registered rollup/derivation/materialized-view source (#739). `RecordCodec.decryptRecordAtDek()` — the tier-aware pre-move decode `syncDerived` uses on `elevate()`/`demote()`/`putAtTier()` (#722) — has no CRDT resolution step, so a registered rollup/derivation reading a CRDT-mode tiered source saw raw `CrdtState` instead of the resolved record: its key/value fields read as `undefined` and the recompute silently no-op'd, letting the #722 derived-output-follows-tier leak back in for this one combination. Refused loudly at construction (`UnsupportedTierCompositionError`, mirrors the #724/#748/#740 tier-composition guards) instead of building CRDT-aware pre-move decode. Reliably catches rollup/derivation sources (`DerivationRegistry` is fully populated before any `vault.collection()` call reaches user code); does NOT catch a materialized-view source first constructed inside the MV's own single-query `query(db)` callback — see the doc comment in `collection-config.ts` for the exact boundary.
- `decryptResponse()` now unwraps the per-blob content CEK, resolves the tier-scoped `_blob` DEK, and verifies the content address (#757). Previously it decrypted chunks directly under the flat `_blob` DEK, so it was **broken for every erasable (`perRecordKeys`) blob** (whose chunks live under a per-blob CEK), tier-blind, and — because it decrypts caller-provided ciphertext with no integrity check beyond AEAD — a **silent substitution side door**: a holder of the flat `_blob` DEK could feed forged, self-consistent bytes and have them returned as genuine content. It now resolves the chunk key via `resolveChunkKey` (unwrapping `_cek`), resolves the blob DEK at the owner/cleared tier (so a cleared `atTier()` read works, an elevated record stays invisible to an uncleared caller), and recomputes `hmacSha256Hex(blobDEK, plaintext)` against the requested eTag — throwing `TamperedError` on mismatch (the same content-address defense the main read paths got in #749). Multi-chunk blobs, which this single-Response API shape cannot carry, are now refused loudly (`ValidationError`) instead of silently mis-decrypting.
- A permanently-stuck persisted-search-index compensation no longer aborts a tier move (#764). The sticky compensation retry from #725 rethrew the raw adapter error uncaught, so a genuinely permanent failure (e.g. a read-only store) would abort `elevate()`/`demote()` mid-flight — after the record's tier-move write landed but before ledger/derived sync — and recur on every future move for that collection. The stuck compensation is now a distinguishable `PersistedIndexCompensationError` (wrapping the raw error as `cause`), and `elevate()`/`demote()` catch it and complete the move — reporting the deferred search-index purge via a new `TierMoveResult { searchResidue: boolean }` return — instead of aborting. Only the compensation-stuck case is caught; any other search failure still propagates.
- `putAtTier()` now registers the record's subject ref in the forget index (#766). A record whose FIRST persistence was `putAtTier(id, rec, tier)` — the sensitive-from-birth pattern — previously bypassed the write-hook pipeline that maintains `_subject_index`, so `vault.forget(subjectId)` silently never found it: an unforgettable record, a GDPR-erasure gap. `putAtTier` now registers the ref through the same path `Collection.put()` uses (idempotent, no-op when no forget strategy is declared, and consistent with the existing `put()`+`elevate()` flow which already leaves the ref in the index). `elevate()`/`demote()` are unaffected — they operate only on records that already exist (and were therefore already registered).
- Two milestone-34 follow-ups. The `describeExtraction` dry-run preview now surfaces `danglingRefs` (with a `reason: 'missing' | 'elevated'` discriminant), so a caller who previews a partition sees that an FK will dangle — matching what the actual `extractPartition` result reports (#772). And `putAtTier()` now routes its search-index purge through the same `syncSearchResilient` guard `elevate()`/`demote()` use, so a permanently-stuck persisted-index compensation no longer aborts the write mid-flight — the record is written and the deferred search purge is reported via `TierMoveResult { searchResidue }` (#774, the putAtTier sibling of #764).
- Two MV/derivation candor follow-ups. A same-collection Query-form materialized view whose input filter matched a field its output copies could **self-perpetuate** — its stale output row re-satisfied the MV's own filter on the next eager refresh, re-deriving after the true source was deleted/forgotten (a forgotten record's contribution reappearing via its own orphaned output). The executor's input scan now excludes rows stamped with the MV's own `_materializedFrom.mvName` before they feed materialization or the tombstone diff (#777). Separately, `forget()` erasure candor improves: an MV output row that is elevated above tier 0 and can't be decoded under the default DEK is now surfaced as `ForgetResult.derivedResidueUndecodable` instead of being silently skipped (#776a), and the eager executor's tombstone leg now counts only rows it actually erased — a `#718`-skipped elevated row no longer over-reports as erased (#776b).
- Two final erasure-candor follow-ups. The eager materialized-view executor's tombstone leg now surfaces residue instead of silently skipping: an MV output row that is elevated-and-undecodable, or decoded-and-owned but undeletable (the `#718` tier gate declined), is reported via `ForgetResult.derivedResidueUndecodable` on both the eager and lazy invalidation paths — closing a silent-survival gap on the eager `forget()` path (#782). A legitimate other-owner/other-MV row (stamp mismatch) is still correctly skipped, never reported as residue. Separately, the `vault.elevate(...).collection().put()` convenience path now surfaces the `TierMoveResult { searchResidue }` signal (previously discarded), so a caller can tell whether a stuck search-index compensation left residue on that write (#779).
- **Audit precision (`@next` only) — MV forget/refresh residue now splits undecodable vs. declined
  (#785).** `ForgetResult.derivedResidueUndecodable` used to fold two compliance-distinct outcomes
  into one array: (1) an MV output row whose `_materializedFrom` ownership stamp could not be
  decoded (undecodable under the default DEK — ownership **unconfirmed**), and (2) a row that DID
  decode and stamp-match but whose erasure was declined by the #718 tier-elevation gate (ownership
  **confirmed**, a live tier-holder-decryptable copy deliberately retained). An auditor reading the
  field name as "couldn't tell" was, for the second case, wrong — the system knew exactly whose data
  it was and chose to keep it.

  `derivedResidueUndecodable` is now narrowed to undecodable-only; a new `derivedResidueDeclined`
  carries the #718-declined rows. The split threads all the way down: `RefreshResult` (the
  `with-formula/materialized-views/executor.ts` `refresh()` return, also the shape of the **public**
  `vault.refreshView()`) gains `residueUndecodable`/`residueDeclined` in place of the single
  `residue` field; `invalidateMVAtRest`'s return does the same; `dispatchMaterializedViewsOnDelete`
  and `ForgetFanoutStats` mirror it. `vault.refreshView()`'s return shape changes as part of this —
  acceptable since the whole campaign is unpublished on `@next`.

  No behavior changes: every row that was previously reported now still is, just routed into the
  array matching its actual reason.

- Blob writes (`put`/`adoptExternal`/`publish`) now refuse a record id, slot name, or version label that contains `::` or starts/ends with `:` (`ValidationError`, #752). `::` is the blob version-key separator; without the guard, ids like `a` and `a::x` (or the boundary case `a:`) made the `{recordId}::` prefix scans match across records — which escalated from a mis-read to destructive cross-record erasure once `forget()` began shredding published versions (#750). The rule makes the `::`-joined key grammar prefix-free by construction. Write-surface only: pre-existing `::`/boundary-colon data stays readable, sheddable, and tier-movable (a constructor throw would have broken `forget()` on such records); re-put under a clean id to clear the legacy ambiguity.
- Crash-safe tier-move blob rehome (#746) + tier-aware migrate() (#756), completing the blob durability journal (#753 shipped the shred half). A tier move (`elevate`/`demote`/`putAtTier`) that re-keys a record's blobs to the destination tier's DEK is now journaled: destination refCount increments are row-scoped stamped so a crash mid-move can't over-count (and thus never strand content undecryptable-but-alive), and `rehomeForTier` resumes with per-step from-then-to tolerance — a half-moved record heals on the next tier op or blob touch instead of staying silently split across tiers at rest. `forget()` resumes a pending rehome to completion before erasing (so a half-moved blob a row no longer references can't survive erasure), and a shred supersedes a pending rehome the other way. `migrate()` (legacy-blob → per-record-CEK upgrade) is now tier-aware — it no longer throws `TamperedError` on a previously-elevated record and skips already-erasable blobs. No swallowed releases under a marker: a failed from-tier crypto-shred during a rehome surfaces rather than silently dropping. Known residuals (documented for the audit): a version whose eTag is held only by a published version (never a slot) can read `null` after a crash between its release and metadata write (availability only); and rehome destination-increment idempotency has one intrinsic non-atomic window — the refCount `+1` and the marker's `appliedStamps` append are separate writes (`+1` first, deliberately, so a crash can only over-retain, never under-count and data-loss), so a crash in that window plus ≥8 concurrent rehomes converging on one shared destination before resume can still over-count (retained-too-long, not a leak of readable content).
- Crash-safe blob erasure (#753). `shredAllForRecord` (the `forget()` blob arm) is now journaled: `forget()` mints an encrypted intent marker (reserved `_blob_intent` collection) BEFORE the tombstone, each refCount release is stamped atomically in its CAS write (bounded `lastOps` ring on the `BlobObject`), and every blob mutator resumes a pending shred before proceeding. A crash at any point — mid-release, between a decrement-to-zero and its chunk deletion, before or after row deletion — now resumes to exactly-once semantics: a co-owned blob can never be over-released by a retry (the destructive case), and an elevated record's holds are never stranded by the tombstone (the permanent-leak case). Markers travel in backups; two-tab terminal-race residue is documented. Rehome journaling (#746) and migrate() tier-awareness (#756) follow on these primitives.
- Tiers×blobs completeness (#747, #749). The `BlobObject` index envelope (size/mimeType/compression/chunkCount/refCount/createdAt) now follows its eTag's tier `_blob` DEK, so an elevated record's blob metadata is no longer readable by a tier-0 DEK holder at rest — content was already tier-isolated (#724); this closes the metadata sidecar. Dedup-policy shared blobs and legacy blobs legitimately stay under the flat DEK (documented residue; reads fall back, and a cleared read that resolves via the flat fallback re-verifies the content address — `hmacSha256Hex(flatDEK, plaintext)` against the requested eTag — so a tier-0 key holder with raw store write access cannot silently substitute an elevated blob's content; forged rows throw `TamperedError`). Known accepted residue: `blobInfo()`/`list()` metadata on a cleared view is not content-verified (no content fetch happens there). No migration: the tiers×blobs arc has never been published. And `blob(id).atTier()` is the new sanctioned cleared-read path to an elevated record's blobs — the `getAtTier` analogue, gated by `assertTierAccess` on the caller's keyring for BOTH the data collection and the `_blob` tier DEK BEFORE any key resolution (an ungranted or partially-granted caller gets `TierNotGrantedError` and no key material is minted), while plain `blob(id)` keeps treating the elevated record's blobs as nonexistent.
- Partition extraction is now tier- and journal-aware (#759, #767, #769). `walkClosure`'s outbound-completion phase re-checks a referenced FK parent's tier visibility (the same gate root selection and inbound expansion already use): an elevated (or missing) parent is skipped rather than admitted — no longer crashing `reKeyClosure` on an undecryptable elevated record — and the resulting dangling FK is surfaced as a `danglingRefs` notice on the extraction result so the caller knows the child's reference points outside the partition. In-flight `_blob_intent` crash-recovery markers are now carried into an extracted partition (re-keyed under the destination DEK) so resume-on-touch heals a mid-shred/mid-rehome record after restore, mirroring the full-vault backup allowlist. The per-slot `pendingRelease` resume breadcrumb is stripped from partition slot records (it is a source-vault-local pointer, meaningless cross-vault) while full-vault `dump()` deliberately retains it (same-vault-resumable) — the asymmetry is documented.
- Elevating a record now removes its contribution from **eager** derived outputs — materialized-view rows, rollup values, and `withDerivation` outputs (#722). These are computed from a source record and written to output collections at tier 0, holding the source's plaintext; `elevate()` previously left them, so any tier-0 caller could read an elevated record's derived plaintext there. On a tier move, the record's eager derived outputs are recomputed from the tier-aware cache — which excludes elevated records — so a record-grain view row is deleted and an aggregate/rollup drops the elevated contribution. `demote()` (and `putAtTier()` back to tier 0) restore it: the change is fully reversible. Recompute reuses the same fanout `forget()` uses and reads only the tier-gated cache, so it never re-materializes the elevated plaintext.

  Scope and known residuals (all shared with `forget()`'s fanout, tracked separately): this covers **eager** materialized views; a **lazy or manual** MV keeps its stale persisted output row until its next refresh, so a cold-session tier-0 read can still serve the pre-elevation row (#736). A rollup contribution baked into a **frozen** period is not recomputed (freeze law). For **aggregate** views and rollups, the value changes observably when a contributor is elevated (a tier-0 observer can infer that a record with roughly that contribution was elevated) — an accepted property, since `_tier` is already store-visible metadata. A tier move on a collection with no derivations does no extra work (the record decode is gated on the presence of a derivation/materialized-view source).

- Tiers × external-projection guards (#748). `adoptExternal()`/`setExternalMeta()` now require the slot to be a declared `blobFields[slot].external` field (`ValidationError`) — they previously bypassed both `put()`'s declaration gate and the construction-time tiers mandate. Declaring `tiers` together with an external blob field marked `public: true` is now refused at construction (`UnsupportedTierCompositionError`): the object key is deterministic and the bytes world-readable by design, so elevation can never make that content invisible — use a presigned/private external field or a non-tiered collection. Private/presigned external fields on tiered collections are unaffected. Extraction hardening: `reKeyClosure`/`reKeyBlobs` carry defense-in-depth canaries (`PartitionExtractionError`) refusing any elevated envelope reaching a partition, and a regression test pins that elevated records are excluded from closure roots and inbound expansion (the outbound-completion gap is tracked as #759).
- `vault.forget()` erasure now covers two residue classes it previously left at rest (#734, #750). (1) The forgotten record's plaintext `_ledger_deltas` rows are purged via the #729 primitive — chain-safe (`verify()` recomputes the tamper-chain from the retained entries, never the delta rows), with the count reported as `ForgetResult.ledgerDeltasPurged` and failures surfaced in `ForgetResult.ledgerDeltaResidue` rather than swallowed. As part of this, forget() without a history strategy now fails FAST with nothing shredded (was: shred everything, then throw on the summary-entry step). (2) `shredAllForRecord` now enumerates the record's published blob versions (`_blob_versions_*`): each version's independent refCount hold is released (crypto-shredding version-held content at refCount 0, retaining shared content for co-owners) and the version rows are deleted; an unreadable version row is reported as blob residue and left in place rather than blind-deleted (which would orphan its refCount hold).
- Elevating a record now re-keys its history snapshots to the tier DEK, so an elevated record's prior versions are no longer decryptable at rest under the collection's tier-0 DEK (#712 — completing the fix whose read-gate shipped earlier). Each `_history` snapshot carries its own tier-0-wrapped key material, which `elevate()` previously left untouched — so any tier-0 holder could recover a prior version's plaintext at rest even though `history()`/`getVersion()` returned nothing. `elevate()`, `demote()`, and `putAtTier()` now rewrap every history snapshot's key from the record's current-tier DEK to its new-tier DEK (via the enclave's `rewrapEnvelope`, reusing the vetted `rewrapBodyToDek`); `demote()` restores tier-0 readability. This is defense-in-depth beneath the read-gate: the ciphertext is protected even if the gate is bypassed. A record elevated before this release keeps tier-0-wrapped history until its next tier move, handled by a tier-0 fallback in the rewrap.

  **Whole-branch review fixes (same PR):**

  - **`putAtTier` now also asserts access to the record's EXISTING tier**, not just the target tier. Previously, a caller cleared only for the target tier could `putAtTier` over a record parked at a tier they'd never been granted; the history-rewrap's from-tier `getDEK` would then silently mint a fresh tier DEK into their keyring — a non-cleared caller creating tier key material. `putAtTier` over a record whose current tier you don't hold is now refused (`TierNotGrantedError`) instead of silently minting — this is an intended, correct behavior change (you can't move a record you can't see); owner/admin/custodian are unaffected (they may still mint).
  - **`syncHistory` now runs LAST** in `elevate`/`demote`/`putAtTier` (after indexes/cache/search are synced), so a `syncHistory` failure strands only its own `_history` artifact instead of leaving a moved-tier live record with unsynced cache/indexes/search on the error path.
  - **`rewrapHistory` gained a toDek-first idempotency skip**: before rewrapping an entry, it checks whether the entry is already wrapped under `toDek` and skips it if so. This makes same-target retries and demote-after-crash fully self-healing. **Residual limitation (accepted, fail-closed):** a crash that strands entries mid-loop under an _intermediate_ tier — i.e. some entries already moved to `toDek` from THIS call, then a later, different tier move targets yet another key — can still leave those entries permanently un-rewrappable (unreadable under `fromDek`, the tier-0 fallback, or the new call's `toDek`, since the original `toDek` is a third key nothing probes for). There is no recovery API for this window; it is availability-only (the ciphertext is never exposed under the wrong key) and considered acceptable given how narrow the trigger is (a crash exactly between two back-to-back tier moves on the same record).

- Elevating a record now purges its tier-0-era plaintext audit deltas from the ledger (#729). The audit ledger is a flat, vault-wide, tamper-evident hash-chained log; a record's reverse-JSON-Patch deltas (the exact fields that changed at each tier-0-era put) were stored in `_ledger_deltas` under a shared ledger key that `elevate()` never touched, so any tier-0 caller could reconstruct an elevated record's prior plaintext at rest. `elevate()` (and `putAtTier()` above tier 0) now delete the record's delta rows. This is chain-safe — `verify()` recomputes the tamper-chain from the ledger entries (which retain the `deltaHash`), never from the deleted delta rows, so the chain stays valid and the audit record that a change occurred (op/version/timestamp/actor) is preserved; only the change's plaintext content is removed. Two consequences by design: it is irreversible (`demote()` does not restore delta reconstruction), and the retained entry metadata still reveals that the record was mutated. `forget()` has the same unaddressed gap for its erasure path (#734, a follow-up reusing this purge).
- `listPage`/`scan`/`aggregate` skip elevated records (#706, completing the tier-0 read-surface invisibility law of #691/#701): no more elevated plaintext in page items from the elevating session (the warm-CEK-cache leak was audit-free), no more cold-session `InvalidKeyError` bricking every scan over a collection containing one elevated record, and the opportunistic page-fill can no longer poison the eager cache/indexes with elevated plaintext. Lazy `count()` now counts only live tier-0 envelopes (envelope inspection, no decryption) — parity with eager count, which also stops counting delete-markers left by sync.
- Milestone-34 batch D — read-gate, race, and write-ring completeness (#730, #725, #720, #718, #708). Time-machine reads (`vault.at(ts)`) now honor the tier invisibility law: an elevated record's history returns `null`/is omitted instead of an opaque decrypt error plus an id-existence reveal, and per-record-CEK snapshots decrypt correctly. Persisted full-text-index saves are epoch-guarded — a stale save is skipped before its write, a purge landing mid-save is undone by a compensating remove, and a failed compensation is retried stickily by every subsequent store operation rather than swallowed — closing the debounced-flush race that could briefly re-persist an elevated or forgotten record's text at rest (both the elevate and forget entry points are test-locked; #764 tracks stuck-compensation ergonomics). Lazy `putAtTier` resolves the prior record through a tier-gated decode, so dropping an indexed field clears its sidecar exactly like `put()` does. The write ring now covers machinery paths: internal derivation/MV cleanup deletes SKIP elevated records (tier-0 machinery treats them as nonexistent — no tier-signal erasure), and a coordinated schema cutover REFUSES loudly (`TierWriteRefusedError`) while any record is elevated, instead of silently demoting it — demote first, then cut over. Housekeeping: the tier-composition guard now lives in the tier domain (`with-audit/tiers`).
- MV/derivation erasure candor (#761, #762). Fixes a data-loss bug: the eager
  materialized-view executor's `onEmpty: 'delete'` tombstone diff listed every
  id in the output collection with no ownership filter, so a same-collection
  partition MV (`output: { collection: <source>, partition }`) wiped OTHER
  untouched user source rows on every refresh — including an ordinary
  `delete()`. The diff is now scoped to rows the MV itself stamped via
  `_materializedFrom.mvName`, the same discipline `invalidateMVAtRest` already
  used.

  Also fixes `vault.forget()` never reaching a same-collection MV — the
  partition-disjoint same-collection edge was dropped from the derived-artifact
  graph, so `forgetDerivedFanout`'s MV arm never fired for it, leaving the
  forgotten subject's contribution in the MV's output row at rest. The MV arm
  now runs unconditionally (self-guarding, O(1) no-op when the collection has
  no MV).

  Candor improvements: `ForgetResult.derivedRecordsErased` now counts lazy/manual
  MV purges (`invalidateMVAtRest`), not just the eager executor's tombstone leg;
  a `#718`-skipped elevated record (internal cleanup over an elevated row) no
  longer over-counts as erased in completeness-tracking callers.

- Derived-output tier/erasure completeness (#736, #737, #740). Invalidating a lazy or manual materialized view from `forget()` or a tier move now DELETES the MV's persisted output rows at rest (previously the pre-elevation/pre-forget plaintext row survived until an in-session refresh — and a cold session served it as fresh), and for lazy MVs persists the stale mark in the reserved `_mv_stale` collection so a cold session recomputes on first read instead of serving an empty view; a manual MV serves empty until `vault.refreshView()` (erasure wins over manual staleness). Ordinary source writes keep the cheap in-memory-only stale path. The tier-move pre-move decode gate is now source-grained (#737) — a tiered collection with no derivations of its own no longer decodes on elevate/demote when an unrelated derivation exists in the vault. And `tiers` on an `encrypted: false` collection is now refused at construction (`UnsupportedTierCompositionError`, #740) — per-record clearance IS per-tier encryption; a plaintext collection cannot honor it.
- Write-path prior reads and history reads treat elevated records as missing (#707, #712 read-gate), and lazy `count()` batches via `adapter.listPage` when the store provides it (#713).

  Write hooks, subsystem gate handlers, and the `i18nProvenance` audit accessor no longer receive an elevated record's plaintext when a tier-0 write touches it (previously the elevating session leaked it through the warm CEK cache while a cold session threw `InvalidKeyError`); the gate-prior read's swallowing `try/catch` is replaced by an explicit pre-decrypt check, so a genuine decrypt failure now fails loudly instead of silently presenting the record as absent. `history()`/`getVersion()` no longer return an elevated record's prior-version plaintext, and CRDT `getRaw()` returns `null` for an elevated record instead of throwing — history snapshots keep tier-0-wrapped keys and carry no tier of their own, so these doors gate on the live record's tier.

  Known limitations, tracked: the history read-gate can still be bypassed by a tier-0 `delete()` (which erases the elevation signal, #716) or by a `put()` (which silently demotes the record, #715); an elevated record's prior versions also remain decryptable at rest until the history keys are rewrapped on elevation (#712).

- Complete the elevated-record invisibility story on tier-0 surfaces (#701, #702; extends #691). Eager cold-session hydration and the vault-snapshot hydration path skip elevated envelopes instead of throwing — a single elevated record no longer bricks the whole collection; lazy cache-miss reads return `null` in both sessions (previously the elevating session leaked tier plaintext through the warm CEK cache while cold sessions threw); `reveal()` on an elevated record throws the domain not-found error instead of a raw crypto error (no elevation disclosure). `putAtTier` now keeps the record cache coherent like `elevate`/`demote`: evict above tier 0, canonical re-seed at tier 0.
- Declaring `blobFields` on a `tiers`-enabled collection is now refused at registration with `UnsupportedTierCompositionError` (#724). An elevated record's blob content is not yet tier-aware — the blob chunks use a vault-shared key that tier moves don't re-key, and `collection.blob(id)` isn't tier-gated, so the content stays readable at rest and through the blob API even when `get()` correctly returns null. Until a blob tier handler ships, the composition is refused rather than left to leak silently (a forward-compatible "not yet supported" wall, mirroring `unique` + `tiers`). Note: the guard catches the declared-`blobFields` case; ad-hoc `collection.blob(id)` use on a tiered collection without declared fields is tracked separately in #724. The already-supported tier compositions — field indexes, full-text/vector search, and history — are unaffected.
- Tier-0 read paths treat elevated records as missing instead of throwing on tier-wrapped key material (#691). `verify`/`verifyGroup` return the padded `{ok:false}` verdict (no elevation oracle, C4 pad path identical to a missing record), `findByDigest` drops the elevated hit without aborting the scan, and `findByDet`/`queryByDet` skip elevated envelopes — deterministically, regardless of CEK-cache state, closing the elevating-session leak that bypassed the cross-tier audit trail. Tier moves now maintain the record cache (`elevate`/`demote` evict after the write lands; demote-to-tier-0 re-seeds, so demoted records stay plain-readable), and `elevate`/`demote` on a deleted/tombstoned id throw the domain not-found error instead of `TamperedError`.
- Elevating a record now removes it from tier-0 indexes (#709). Previously its persisted index side-cars (`_idx/<field>/<recordId>`) survived the tier move holding the indexed field's **plaintext value**, always encrypted under the collection's tier-0 DEK whatever the record's own tier — so elevating a record never hid what it was indexed by, and any tier-0 caller could read the value back. `elevate()` (and `putAtTier()` above tier 0) now purge the record's side-cars and drop its in-memory index entries; `demote()` and a tier-0 `putAtTier()` rebuild them from the record. This applies to `elevate()` the same fix `forget()` already had via `purgePersistedIndexes`.

  Index rebuild and reconcile now skip elevated records instead of decrypting them: previously the elevating session's warm key cache let the decrypt succeed and **minted a fresh tier-0 side-car** from the elevated record's plaintext (reconcile would even re-create one that had been deleted), while a cold session threw and bricked the whole operation.

  A tier-0 `putAtTier()` also refreshes the record's index entries, fixing a stale-entry false positive: a query on the record's **old** field value could return it, because an index hit is not re-verified against the record.

  Intended consequence: an elevated record is not present in any **secondary (field) index**, so it is not findable by structured index-driven queries — including from a session that holds its tier DEK. `getAtTier()` / `listAtTier()` remain the tier-aware read surfaces. Unique indexes were already refused on tiered collections, and are unaffected.

  This covers field indexes only. The **search** subsystem is not yet tier-aware: full-text (`retrieve()`) and vector (`similarTo()`) indexes still retain an elevated record's derived plaintext and can still surface it (#721), and materialized-view / rollup outputs derived from a record survive its elevation (#722).

- Elevating a record now removes it from full-text and semantic search (#721). Previously the persisted lexical index (`_ftindex`) held each record's **complete verbatim indexed text**, and the embedding sidecar (`_vec/<recordId>`) held its text-invertible vector — both encrypted under the collection's tier-0 DEK whatever the record's own tier, and neither touched by `elevate()`. So elevating a record never hid what it was searchable by: any tier-0 caller could read the verbatim text out of the at-rest `_ftindex` blob, and even a cold `similarTo()` surfaced the elevated record's id and similarity score. `elevate()` (and `putAtTier()` above tier 0) now purge the `_vec` sidecar and delete the stale `_ftindex` blob; `demote()` and a tier-0 `putAtTier()` re-embed and rebuild. As defense against a legacy or failed-purge sidecar, the vector loader also skips `_vec` rows whose owning record is elevated. This applies to `elevate()` the same purge `forget()` already had.

  Intended consequence: an elevated record is not present in any search index, so it is not findable by `retrieve()` or `similarTo()` — including from a session that holds its tier DEK — until it is demoted. `getAtTier()` / `listAtTier()` remain the tier-aware read surfaces.

  With #723's field indexes, this closes the derived-index surface. Materialized-view / rollup outputs derived from a record still survive its elevation (#722), and blob content may (#724, unverified); an elevated record's prior history versions remain decryptable at rest until #712; and a debounced index flush racing the purge can briefly re-persist a stale `_ftindex` blob (#725).

## 0.3.0-pre.12

### Minor Changes

- Satellite collections v1 follow-ups (milestone #22).

  - **#596 (fix):** a satellite fan-out leg whose write throws no longer drops a pre-existing
    dirty entry for the same `(collection, id)` — a data-loss bug where a legitimate, already-queued
    sync write could silently vanish when a _different_ leg of a joined put/pair delete failed.
    `Leg` now tracks a `wrote` flag; dirty-compensation is skipped for a leg that never actually
    wrote. A narrow, pre-existing edge case (a leg whose write lands but throws afterward, during
    derivation/materialized-view dispatch) is out of scope for this fix and tracked separately as #687.
  - **#595 (rename, no behavior change):** the one-satellite-per-base v1 scope guard's refusal id
    moves `R-S1` → `R-S10`, freeing `R-S1` for the design's real fields-overlap routing-ambiguity
    rule (`post-register.ts`), which was always the documented R-S1 but shared the id with the
    scope guard in the shipped v1 error string.
  - **#597 (additive):** persisted satellite pairing markers and classified markers now carry an
    optional `epoch` (ISO-8601, stamped on first persist, stable across every later re-declare/no-op
    fast path — deliberately excluded from marker equality). A latent reuse-staleness guard for
    when a collection name gets freed and reused; the epoch-mismatch _rejection_ itself is deferred
    until a delete-collection API exists — there's nothing to reject against yet.
  - **#599 (new public API):** `Vault.migrateSatellitePerRecordKeys(satelliteName)` unblocks R-S7
    retro-coverage — walks an existing satellite's records via `_applyCutoverTransform`, minting a
    distinct per-record CEK for each, so a satellite declared before forget-coverage was added can
    be migrated into `perRecordKeys` mode instead of being permanently stuck behind R-S7's refusal.
    Resumable (already-migrated records keep their CEK on a re-run); asserts the collection wasn't
    already opened this session without `perRecordKeys` (throws `SatelliteConfigError` otherwise);
    no vault-wide fence/quiesce — run it before the satellite collection serves other traffic.
  - **Bounded #588 consolidation:** `kernel/best-effort-revert.ts` — a shared best-effort-revert
    helper now consumed by both satellite fan-out (`with-shape/satellites/fanout.ts`) and
    `with-commit`'s transaction revert (`with-commit/tx/transaction.ts`), replacing two near-identical
    reverse-iterate/put-or-delete loops with one. Internal-only (not part of any public barrel).
    #588's actual ask — a kernel cross-collection atomic-write primitive — remains descoped/parked
    (closed not-planned): it's adapter-contract-breaking (ripples to every `to-*` store in the
    sibling `noy-db-to` repo plus the `adapter-conformance` harness) and needs its own design spec;
    revisit on a real torn-pair report or when that cross-repo adapter work is independently scheduled.

### Patch Changes

- Milestone #29 sync-engine follow-ups.

  - **#653** — Partial sync (`pull`/`push({ collections })`) now auto-includes the reserved `_dict_*` dictionaries a named collection's lookup fields depend on (mirrors the satellite-pair expansion), so labels and membership no longer go stale on partially-synced instances.
  - **#606** — A per-collection marker-id set skips the redundant, usually-null `adapter.get` on every synced-eager insert that #589's re-create version-continuity gate previously forced.
  - **#693** — Under multi-tab coordination sharing one store, the re-create gate falls back to the pre-#606 unconditional store read (the marker-id set is per-instance and can't see a peer tab's out-of-band delete-marker until the relay lands) — closing a data-loss window.
  - **#658** — Sync-applied deletes now heal materialized-view rows and array-shape derivation outputs, matching the local-delete boundary (previously the sync-delete wave was rollup-only).

- Milestone #33 via follow-ups — two internal correctness fixes.

  - **#678** — `ViaGraph.assertAcyclic()`'s ref-edge filter now keys on the edge itself, not the target. Previously it re-derefed the target's `_in` entry for `kind`, which a later `registerDerived` call could have overwritten (e.g. a dual-role target registered computed-then-ref, #631's exempt composition order) — silently excluding a genuine computed edge from the cycle-detection DFS and hiding a real derivation cycle. `_out` edges now carry their own `kind` at registration; the filter and `referencingEdgesOf` both read it edge-local. Latent regression guard — not reachable in production today (`assertAcyclic()` runs once at `openVault()`, before `_in`/`_out` is populated).
  - **#677** — Lazy-mode `PersistedCollectionIndex` now canonicalizes money index keys at every bucket-mutation site (`ingest`/`upsert`/`remove`) and canonicalizes the `==`/`in` probe value before lookup, mirroring eager mode's #672 fix. A lazy-mode mixed-era (pre-money-declaration) record now agrees with the fallback scan the same way an eager one does. The end-to-end gap this fix did NOT close — `LazyQuery.where()` never built a `clause.via`, so `lazyQuery().where(moneyField, ...).toArray()` returned empty at `scale > 0`, and lazy money range clauses dispatched through `lookupRange` with no scan fallback — was tracked in #684 and is CLOSED in this same release (see the via-port lazy/index follow-ups entry).

- Via-port follow-ups — lazy/index correctness.

  - **#684** — Lazy queries are now Via-aware end-to-end. `LazyQuery.where()` builds a `clause.via` and the lazy post-filter runs against the RAW stored record (mirroring eager: filter stored-form, decode survivors on output), fixing money (and any decode-transforming via) lazy queries that previously returned empty at `scale > 0` under every query spelling. Money range clauses enumerate the field index and post-filter via-aware (closing the no-scan-fallback hole); `==`/`in` prefer `clause.via.indexValue`, and the `queryable: 'none'` posture guard + multi-currency `==`/`in` now match eager. The `LazyQuerySource` shape on the `@noy-db/hub/indexing` subpath changed (a raw-fetch seam added) — pre-1.0, no external implementer exists. Lazy `orderBy` ordering parity for money is a separate, still-open item (#695).
  - **#695** — Lazy `orderBy` on a money field is now Via-aware: `toArray()` sorts the RAW survivors via `ViaPipeline.compareForOrder` (scaled BigInt compare, mirroring eager) and decodes only the returned page, so money orders numerically instead of lexicographically (`'10.00'` no longer sorts before `'2.00'`).
  - **#696** — The lazy composite-index `==` fast path is skipped when a covered clause is Via-covered (money), falling through to the already-Via-aware single-field path — a money field in a composite index no longer misses (returned `[]`).
  - **#698** — Lazy now decomposes a composite index into its component single-field indexes on declare (matching eager), so a composite-ONLY declaration serves single-field queries and the #696 fall-through instead of throwing `IndexRequiredError`. (Adds per-component single-field side-cars, the same tradeoff eager makes.)
  - **#686** — Late-attaching `money()` (a second `vault.collection()` call) onto an already-built EAGER index now re-canonicalizes the existing buckets, so rows indexed before the money declaration are no longer silently under-returned by canonical `==`/`in` probes until the next rebuild.
  - **#687** — Documented (as an accepted known limitation) the narrow satellites fan-out post-`onDirty`-dispatch-throw orphaned-dirty-entry hazard (harm: one self-healing sync-push cycle), and hardened the pair-delete revert test with a direct dirty-log assertion.

## 0.3.0-pre.11

### Minor Changes

- Credential broker (#479, slices 1+2): passphrase-bound, rolling, non-extractable store-auth.

  Slice 1 (adapter seam): `StoreCredentials`/`StoreCredentialSource` on `@noy-db/hub`'s `/to` port
  (additive, golden-bumped) and a `credentials?: StoreCredentialSource` option on `@noy-db/as-aws-s3`
  (`asAwsS3({ credentials })`), wired as a functional AWS SDK credential provider so
  `memoizeIdentityProvider` re-invokes it at each credential's own expiry.

  Slice 2 (service): new opt-in `@noy-db/hub/broker` (`withBroker()`, `vault.broker()`) — enrol a
  per-vault `_broker` seed (CAS create-if-absent, owner/admin-gated, KEK required only on first
  enrolment), then mint short-lived cloud credentials via a challenge/response HMAC proof
  (HKDF-derived, non-extractable `['sign']` key) against a broker host, with a single-flight
  per-profile refresh cache and a quiesce-then-swap `rotate()`. Ships `kernel/enclave/broker/proof.ts`
  (the proof crypto: `deriveBrokerProofBits`/`deriveBrokerProofKey`/`computeBrokerProof`/
  `issueChallenge`/`verifyBrokerProof`), the `_broker` reserved-collection guard + grant-exclusion
  (rides the already-shipped secret-bearing-reserved-collection guard), the three new error classes
  (`BrokerNotEnabledError`, `BrokerEnrolmentError`, `BrokerProofError`), and a `docs/subsystems/broker.md`
  service page with the threat-model candor table and a reference Lambda/STS broker host documenting
  the four mandated host obligations (KMS-wrap registered proof keys at rest, atomic burn-on-presentation
  challenge consumption, SHOULD rate-limit `/credentials`, accept old+new registration on rotate).
  SERVICES.md gains the Cluster G row.

  Bundle impact: 0 bytes when not opted in (`NO_BROKER` stub + dynamic-import seam).

  Deferred: slice 3 (sealed-to-instance credential delivery + non-extractable instance keypair) is
  not part of this release — see the spec's OQ4. `noy-db-to`'s `to-aws-dynamo`/`to-aws-s3` adoption
  (the `credentials` option + the required hub peer-floor bump) is a separate, manually-gated
  follow-up in that repo once this hub minor is published.

- Opt-in `scopedPurge` forget-strategy knob (#633). `withForgetCascade({ scopedPurge: true })` gates
  `vault.forget()`'s two vault-level purges — the `_sealed_cek` host-delivery envelope purge and the
  blob crypto-shred scan — on a per-collection via-declaration signal (`classifiedFields` for the
  sealed-CEK arm, `blobFields` for the blob arm) instead of running them unconditionally over every
  forgotten ref. Default (`scopedPurge` absent/false) stays fully unconditional — byte-identical to
  today's behavior — because a declaration is a necessary-but-not-sufficient proxy:
  `sealRecordToHost()` and `.blob(id)` both work on collections that never declared anything, so
  scoping by default would silently narrow the erasure promise.

  When scoped, an undeclared collection's purge is never silently skipped: `ForgetResult` gains a new
  additive field, `scopedPurgeResidue: readonly { reason, collection, count }[]`, with reasons
  `'skipped-undeclared-sealed-cek'` and `'skipped-undeclared-blob-scan'` — always empty under the
  unconditional default. The blob arm's scoped skip is also a perf win: an undeclared collection's
  scan is skipped entirely, with no `_blob_slots_<collection>` `list()` call at all. The knob rides
  `ForgetStrategy` the same way `subjects` does — set once per `createNoydb()` instance, threaded
  identically into every `Vault` opened from it.

  **Footgun:** a bare `sensitive: [...]` collection with no `classifiedFields` binding counts as
  UNDECLARED for the sealed-CEK arm — under `scopedPurge: true` its sealed-CEK envelopes are
  skipped-and-reported, not purged, even if `sealRecordToHost()` was called on it.

- Milestone #26 — docs/release infra + a CRDT build-warning fix + a delete-conflict caveat.

  - **#660 (hub minor trigger): DTS build memory.** The hub's declaration build blew past 8GB peak
    RSS (measured ~4.9GB steady-state, up to ~9GB peak footprint), forcing a
    `--max-old-space-size=12288` cap in both CI workflows and the package's own `build` script.
    Replaced tsup's `dts: true` (rollup-plugin-dts bundling) with a single plain
    `tsc --emitDeclarationOnly` pass (`packages/hub/tsconfig.dts.json`), wrapped in an RSS guard
    (`packages/hub/scripts/build.mjs`). Peak RSS dropped ~4.9GB → ~410-435MB (~91% reduction);
    `.github/workflows/ci.yml` / `release.yml` `NODE_OPTIONS` dropped 12288 → 4096.
    **Shipped `.d.ts` layout changed**: instead of tsup's flat bundled-per-subpath files, `dist/**`
    now mirrors `src/`'s directory tree 1:1 (e.g. `dist/with-commit/history/index.d.ts` instead of
    `dist/history/index.d.ts`), so the file count went from 54 to 398. All 41 `package.json`
    `exports[...].types` targets were retargeted accordingly. The public API, types, and import
    specifiers are unchanged — every subpath still resolves the same way through `exports` — but the
    on-disk layout behind that map is different, which is why this is a **minor**, not a patch, per
    pre-1.0 convention for consumer-visible packaging changes. A build-time guard now also verifies
    every `exports` target (`types`/`import`/`default`) actually resolves to a file in `dist/` after
    build, catching a stale/typo'd subpath before it ships.
  - **#667**: fixed a Rollup dts circular-dependency warning between `kernel/types.ts` and
    `with-commit/crdt/strategy.ts` (`CrdtStrategy` re-export cycle). Hoisted `LwwMapState`/
    `RgaState`/`YjsState` into `kernel/types.ts` alongside the other CRDT types, and redirected the
    `CrdtStrategy` type import in `vault.ts`/`collection.ts`/`collection-config.ts` from the indirect
    `with-commit/crdt/strategy.js` re-export to the direct `kernel/types.js` origin. No runtime
    behavior change; no public API change.
  - **#600**: `release.yml`'s `publish` job now opens a `noy-db-docs` issue (`continue-on-error`,
    via a `DOCS_SYNC_TOKEN` PAT) on every successful publish, carrying the version/tag, npm
    dist-tag, run link, and the list of published `@noy-db/*` packages — so the docs repo's doc-sync
    has a trigger instead of relying on someone noticing a new release.
  - **#607**: added a JSDoc caveat to `ConflictPolicy<T>` (`kernel/types.ts`) — and mirrored in
    `docs/subsystems/via.md` — documenting that `'last-writer-wins'`/`'first-writer-wins'`/`'manual'`
    compare raw envelopes, so an edit _can_ beat a delete marker, whereas a custom-fn resolver and
    the CRDT modes `'lww-map'`/`'rga'` decrypt both sides first and unconditionally let a
    shred/tombstone win before the merge function ever runs (`'yjs'` is the one CRDT-mode exception:
    it never decrypts and falls back to a plain higher-`_v` compare, so an edit can win there too).
    Doc-only; no behavior change.
  - **#624**: taxonomy-convergence analysis for the `noy-db-docs` migration (PR #498) — a gap
    analysis (9 verified divergences between `SERVICES.md`/`packages/hub/src/**` and
    `noy-db-docs`'s `features.yaml`/taxonomy), a `feature-schema.json`/`features.yaml` proposal,
    two new ADRs (`docs/adr/0001-minimal-kernel-core.md`, `docs/adr/0002-placement-is-not-opt-in.md`
    — the first ADRs in this repo), and an 18-step migration checklist. Analysis/docs only; nothing
    in `packages/**` changed.

## 0.3.0-pre.10

### Minor Changes

- Retire the `/adapter`, `/kernel`, and `/describe` deprecated subpath aliases (legacy retirement, phase 1). This is a coordinated removal, not a deprecation: all known consumers were verified migrated before the aliases were pulled. `noy-db-to`'s stores bind `@noy-db/hub/to` (0 remaining `/adapter` references); `klum-db`'s lobby binds `@noy-db/hub/cargo` (0 remaining `/kernel` references); `@noy-db/ui`/`@noy-db/ui-nuxt` bind `@noy-db/hub/ui` (0 remaining `/describe` references). In-repo consumers (`to-memory`, `to-file`, `to-browser-idb`, `by-peer`, `by-tabs`, the `test-adapter-conformance` harness) were migrated in the same commit — `/adapter` → `/to`, `/kernel` → `/cargo`.

  `/adapter` and `/describe`'s backing `src/legacy/*.ts` files are deleted outright — nothing referenced them internally. `src/legacy/kernel.ts` survives on disk (unpublished): `@noy-db/hub/cargo` re-exports its runtime-helper/error-class/type surface as its internal floor (`export * from '../legacy/kernel.js'`), so the file stays as an implementation detail of `/cargo`, not as a published subpath — the `./kernel` entry is gone from both `tsup.config.ts` and the `package.json` exports map.

  `/bundle` is untouched and stays published — klum-db's interchange still binds it; its migration to `/pod` + `/cargo` is tracked as phase 2/3. Old published `@noy-db/hub` versions keep their `/adapter`, `/kernel`, `/describe` aliases; this only shapes the next release.

  Removed the now-redundant golden freeze tests for the retired aliases (`adapter-surface-golden.test.ts`, `adapter-seam.test.ts`, `kernel-surface-golden.test.ts`, `kernel-surface.test.ts`, and their baseline JSON fixtures). `kernel-api-surface-golden.test.ts` (the `Noydb`/`Vault`/`Collection` prototype freeze) and `cargo-surface-golden.test.ts` are untouched — the latter still reads `src/legacy/kernel.ts` directly as part of its own mechanism, which is exactly why that file had to stay.

- Milestone #31 via backlog closure — six issues (#666, #664, #639, #665, #661, #625), one branch.

  - **#666 — `Collection._setVia(pipeline)` writer seam.** Internal refactor: the untyped
    `coll as { via; codec: { setVia } }` cast `applyTaintOverlay` used to reassign a collection's
    compiled `ViaPipeline` is replaced by a typed method. No observable behavior change; it exists
    to give #664's late-attach machinery a sound way to rebuild the pipeline from outside
    `collection.ts`.

  - **#664 — late-attach (reconcile) parity for `i18nFields`/`dictKeyFields`/`lookupFields`.** A
    SECOND-OR-LATER `vault.collection(name, {...})` call against an already-open collection always
    supported `moneyFields`/`computed`/`fieldMeta`/`meta`/`classifiedFields`; these three families
    were silently ignored on that path with no error. Now they attach: enum/static-tier lookup
    fields attach cleanly (self-contained, no vault registry touch); reserved-tier (`dict()`) attach
    additionally wires the same vault registries fresh construction populates (sync + reference-graph
    both see the field immediately). **Matrix-tier lookup fields (`backing: 'collection'`) REFUSE to
    late-attach** with a `ValidationError` naming the field/dimension/remedy unless the backing
    collection is already open, this vault session, in eager (prefetch-enabled) mode — this is a
    deliberate scope limit, not a bug: a lazy or not-yet-open backing dimension fails LOUD at
    declare time instead of surfacing a confusing error the first time a query touches the field.
    The pre-existing declare-time collision guard (two via families claiming the same field) now
    also runs on every late-attach call, both within one call's own incoming fields and against the
    collection's already-declared fields. Three known late-attach residuals, documented, not fixed
    in this pass: `describeAsync({resolveDictLabels:true})`, `describe()`'s legacy top-level field
    list, and join-side `presentForJoin` dressing — each reads a `Collection` field captured once at
    fresh construction, not re-derived by a later reconcile call.

  - **#639 — mutual/rotating rollup cycles now refused at declare time.** Two or more `withRollup()`
    strategies whose targets mutually depend on each other used to be silently declarable — the
    cycle was invisible to the dependency graph's cycle check because a rollup's target is a field
    the graph only ever writes into, never reads from. `ViaGraph.assertAcyclic()`'s traversal now
    additionally treats a real-field write as also being a write to its owning collection, closing
    the gap. Fires at `Noydb.openVault()` (every derivation/MV strategy validates at vault open), and
    throws `DerivationCycleError` — the same class every other declare-time cycle already throws.
    Deliberately scoped to rollup-shaped cycles only; no runtime depth/reentrancy guard was added
    (a declare-time sentinel fix, not a cycle breaker).

  - **#665 — computed-first present order; `<field>Label`/`<field>Formatted` dressing now sees a
    virtual computed field's output.** Before this fix, `computed`'s `present()` hook ran LAST, so
    i18n/lookup's dressing hooks ran before a `mode: 'virtual'` computed field's value existed —
    dressing was always a no-op for a composed field. `ViaPipeline._presentOrder` reorders the
    PRESENT phase only (every other phase keeps the existing money-first compile order) so computed
    runs before i18n/lookup. **Money is explicitly carved OUT of the generic reorder and kept in its
    original present position** (a three-way partition: money, then computed, then everything else)
    — money's `present()` DECODES its input as a stored scaled-int, unlike i18n/lookup which only
    ADD a dressing key; running money after a virtual computed on the same field would misread the
    computed output's raw major-unit number as a scaled-int and corrupt the value, not just leave it
    undressed. **Two tradeoffs, pinned as tests, not follow-ups:** (1) a virtual computed field can
    no longer read another field's dressing output (`<field>Label`/`Formatted`) — that composition
    direction was never in this fix's scope and silently regresses if anyone relied on it; (2)
    chained virtual computeds stay declaration-order-sensitive (a later-declared virtual field can
    read an earlier-declared one's output; the reverse falls back to the reader's sentinel) — this
    was already true before #665 and is unrelated to the present-order fix, just documented
    alongside it. **Money-decorating-a-virtual-computed-field's-own-output stays an explicit,
    out-of-scope KNOWN LIMITATION** — closing it needs a quantize-the-computed-output decision, not
    an ordering fix; filed as a wrap-up follow-up.

  - **#661 — bare-array lookup fields gain element-wise support.** A plain field whose own value is
    an array (distinct from the pre-existing `[].`-wildcard multi-value path) had ZERO enforcement —
    `getAtPath` resolved it to one opaque value, so both the altKey-normalizing `ingest` hook and the
    closed-vocabulary `enforceWrite` hook silently skipped it; any value, known or not, passed
    `put()` under `vocabulary: 'closed'`. Both hooks now handle this shape element-wise, reusing the
    same canonical core the scalar and `[].`-wildcard paths already use — including at a dotted,
    non-wildcard path (`'meta.tags'`), which works with no dedicated code since the underlying path
    helpers already resolve dotted paths generically.

  - **#625 — `ViaBinding.indexProbe` restores the index-accelerated fast path for fixed-mode money
    `where()`.** A new, optional hook lets a binding hand the query builder a STORED-form operand for
    a direct index-bucket lookup on `==`/`in`; without it (multi-currency money, every other
    operator), the query builder falls back to a full scan, unchanged. This restores a fast path
    phase A lost for money fields specifically. **Honest mixed-era caveat**: the fast path is
    byte-exact for every record written through the money write path (which always produces a
    canonical scaled-integer digit string); a legacy record whose stored value predates the field's
    `money()` declaration may hold a non-canonical scaled string (e.g. `'0100'` instead of `'100'`)
    — the index buckets it under that raw string and a canonical `==`/`in` probe misses it, while
    the fallback scan (which re-parses via `BigInt`) still matches it correctly. The indexed fast
    path therefore returns the canonical subset of matches, not literally every stored byte
    sequence; a re-`put()` of a legacy record canonicalizes it going forward. A money-aware
    index-key canonicalization would close this generally — filed as a wrap-up follow-up, not
    implemented here.

  **Additive surface, no breaking change:** `ViaBinding.indexProbe?(op, payload): unknown | undefined`
  (kernel/via.ts) is a new optional hook — a type-level addition every existing binding is free to
  leave unimplemented (falls back to a scan, unchanged behavior). Verified no `**/*golden*` file
  changed anywhere on this branch (`git diff a2c80969..HEAD -- '**/golden*'` — empty), so no frozen
  public-surface snapshot needed regenerating for any of the six issues above.

  See [`docs/subsystems/via.md`](../docs/subsystems/via.md) (new "Milestone #31" section),
  [`docs/subsystems/via-lookup.md`](../docs/subsystems/via-lookup.md) (late-attach + bare-array
  sections), [`docs/subsystems/via-computed.md`](../docs/subsystems/via-computed.md) (present-order
  section), and [`docs/subsystems/via-money.md`](../docs/subsystems/via-money.md) (indexing section)
  for the full story, every example traced to a shipped test.

- Milestone #32 via follow-ups — four issues closed.

  - **#670** — `LookupHandle.rename()` publishes the new key to the sync cache before rewriting referencing records, so renaming a key on a `vocabulary: 'closed'` field no longer self-refuses with `UnknownLookupKeyError`; mid-rename, both the old and new keys are legitimately members.
  - **#672** — Money-aware eager-index key canonicalization now runs at every bucket-mutation site (build/rebuild-on-hydrate, `put()`, `delete()`), via a new `ViaBinding.canonicalizeIndexKey` hook. A mixed-era (pre-money-declaration) legacy value's index fast path now agrees with the fallback scan instead of stranding it under its raw, non-canonical key. Boundary: lazy-mode (`prefetch: false`) collections keep their own raw-bucketing `PersistedCollectionIndex` side-car, unaffected — tracked separately.
  - **#669** — Money now dresses a virtual computed field's own output (`via(computed(fn, {mode:'virtual'}), money(...))` on the same field) as MAJOR UNITS: the fn's return value is quantized to the currency scale (per the descriptor's declared rounding) and presented exactly like a stored money field — decimal string, `<field>Formatted`, `<field>Number` — via a new `ViaBinding.presentLate` hook. Unparseable/absent output is left raw, no throw. A taint-redacted virtual field's `Formatted`/`Number` companions are stripped along with the base field.
  - **#671** — Five late-attach (reconcile) residuals fixed: (1) `getDictionary`/`resolveDictLabels` now resolves a late-attached dict field's labels, (2) `describe()`'s legacy top-level field list now includes late-attached fields, (3) `presentForJoin` now dresses late-attached i18n/lookup fields through the join path, (4) a money- or classified-only late-attach no longer silently drops an already-materialized taint overlay, (5) `ViaGraph.assertAcyclic()` no longer false-positives on legitimate mutual-FK `lookup`/`ref` edges between two collections. Items 1-3 ride a new `Collection._reconcileReadState` writer seam.

- Via consolidation (milestone #30): four latent gaps surfaced by the phase A–D whole-branch
  reviews — #642, #651, #654, #640 — plus riders on #644 (items 1+3) and #646 (fixture discipline).
  No shipped consumer uses any of the affected surfaces yet (pre-1.0), so none of this carries a
  migration story.

  - **#642 — formula outputs derived from a classified-bearing collection are now sealed at rest,
    non-exportable, and query-refused by default (BEHAVIOR CHANGE, the #636-principle completion).**
    #636/#638 closed the leak for a `computed` field's own declared `deps`; a with-formula edge
    (derivation/rollup/MV) still folded its posture from its source's whole-record `'*'` node, which
    never carried a registered posture and always fell back to max-permissive — so a derive/rollup/MV
    `fn` (which receives DECRYPTED records by design) that copied a classified field's plaintext
    landed it UNSEALED in the output: exportable, queryable, synced. Both target shapes are now
    covered — **rollup targets** (a real field on the parent) inherit the fold automatically through
    the existing field-specific taint overlay; **derivation/MV/overlay output collections** (`'*'`
    targets) gain a collection-level default posture that seals every non-`_`-prefixed field of the
    output record. The fold is axis-scoped, not a blanket clamp: only `encryptedAtRest`/`exportable`/
    `forgettable` fold from a classified source; `queryable` is left at the base posture and is never
    pulled down by a blob/money/i18n-only source, and a `ref` edge's `'*'` source is excluded from the
    fold entirely (kept at identity, so a lookup-referencing field never seals just because its
    backing dimension happens to have a classified column — the countries-matrix recipe stays
    byte-identical). **No migration**: pre-1.0, no shipped consumer reads a formula output today, so
    there is nothing to migrate — a deliberate, ratified security-correct default. Explicit
    per-declaration declassification is deferred to phase E, not built here. **KNOWN LIMIT**: the MV
    leg is currently theoretical for classified sources — all three MV refresh modes pre-open their
    source collection at `openVault`, and the pre-existing classified retro-declare guard then refuses
    classifying it there, so the fold applies mechanically but is structurally unreachable today.
    Landing this exposed
    three genuine, pre-existing latent bugs in the at-rest cache layer — all three gated on a
    collection's _local_ `sensitiveFields` being non-empty, which was always true historically because
    a sealed field always co-occurred with a locally-declared classified field until a
    taint-only-sealed collection (zero local `sensitiveFields`, sealed entirely via the graph fold)
    became reachable: `RecordCodec.toCacheRecord` (a write-then-immediate-`get()` returned cached
    plaintext instead of a `SealedHandle`), `Collection.resolvePriorValues`, and the `_getStoredRecord`
    lazy-mode branch (both of the latter, left unfixed, broke the self-write cycle-termination guard
    for a rollup patching its own parent — an **infinite write loop**, not a wrong-value bug).
    `resolvePriorValues` and the `_getStoredRecord` lazy branch are now gated on
    `sensitiveFields.size > 0 || via?.hasAtRestHooks === true`; `toCacheRecord`'s equivalent stale gate
    was removed outright — the envelope's own `_sealed` presence fully determines whether wrapping is
    needed.
  - **#651 — one canonical key-resolution core; matrix direct-read `present()` dressing now works for
    a non-default `key`.** A matrix lookup declared with `key !== 'id'` (e.g. `lookup('countries', {
key: 'iso2' })`) previously resolved its DIRECT (non-join) `<field>Label` read by the backing
    collection's PUT-id, not `descriptor.key` — silently omitting the label for exactly the canonical
    recipe this feature exists for. `coerceLookupKey`/`resolveBackingRowKey`/`matchesReferencingValue`
    are now the one shared key-resolution core all six call sites converge on (snapshot rows, altKey
    index, membership check, compare-key resolution, the restrict/propagation match predicate, and
    `getLookupBacking`'s direct-read closure) — ending a bare-`String()`-vs-guarded-coercion drift
    between them. Two poisoning classes close as a result: a backing row missing its `descriptor.key`
    field no longer enters the snapshot/altIndex under the literal string `"undefined"` (previously a
    closed-vocabulary field could wrongly accept `"undefined"` as a valid key); and a nullified or
    never-set referencing field no longer bare-`String()`-coerces to the literal `"null"`/`"undefined"`
    and spuriously matches a dimension whose canonical key genuinely is that string. An altKey
    candidate row VALUE may now be a string or a number — both normalize through the same core
    (deliberate uniformity, not a new capability anyone asked for), and the ownership-uniqueness
    collision check still fires across the numeric/string boundary (a numeric `1` and a string `'1'`
    on two different rows still throw `ValidationError`).
  - **#654 — an unresolvable restrict edge now REFUSES instead of silently letting the delete through;
    ordinary-delete propagation residue-reports instead of silently dropping.** A `restrict`-mode
    lookup edge whose compare-key can't be resolved (a corrupted backing row — the `key` field missing
    or non-scalar) used to `continue` past the check entirely, deleting/forgetting the row with no
    proof references don't exist. It now throws the new `RestrictRefUnresolvableError` (root-exported,
    `{ dimension, key, referencing }`), the same "cannot prove no references ⇒ refuse" reasoning
    `DictKeyInUseError` already applies when references ARE provably present. The `cascade`/`nullify`
    ordinary-delete propagation path's twin failure (previously a bare `continue`, no report channel
    at all) now proceeds but reports the skipped edge on a new `lookup:propagation-residue` event
    (`{ vault, dimension, key, residue }`) — the ordinary-delete counterpart of the pre-existing
    `forget()`-path `ForgetResult.lookupReferencesResidue` channel, which is unaffected. A resolvable
    edge behaves exactly as before in every mode; this is a corruption-class-rarity refinement, not a
    change to the common path.
  - **#640 — sync-applied deletes now recompute rollup parents.** Previously, only a _local_ delete
    triggered `dispatchRollupsOnDelete`; a remotely-deleted rollup child pulled over sync left its
    parent aggregate stale indefinitely. The sync-apply choke point now classifies each applied
    envelope as a put or a delete and threads deleted ids, batched and per-parent-deduped, through the
    same dispatch wave `pull()`/`push()`/cutover/restore already run — routed to the rollup-recompute
    trio only, never `dispatchDerivations`/MV-on-delete, mirroring the existing local-delete dispatch
    boundary. **KNOWN LIMIT, stated honestly**: the deleted child's rollup-parent intents are resolved
    from a synchronous pre-invalidation cache peek with no extra I/O; if that peek misses — a cold or
    evicted child (lazy-mode LRU eviction before the sync-apply lands) **or** an un-hydrated eager
    collection whose first sync operation for that child is itself a delete — the miss is silent and
    freshness-only: that one child's contribution to the parent goes uncounted until the next sibling
    write recomputes the parent from scratch. Correctness elsewhere is unaffected (the recompute always
    reads the remaining children from the store, so nothing double-counts). Riders: `push()`/`pull()`
    now flush the graph batch in a `finally` around `persistMeta()`, so a throw there no longer leaves
    a stale open batch silently dropping the next wave's touches (#644 item 1); both the puts and
    deletes legs of the dispatch wave now additionally emit a structured `'derivation:wave-error'`
    event (`{ collection, id, error }`) alongside the pre-existing `console.warn`, so a sync that
    completed with a failed per-id recompute is programmatically discoverable, not just logged (#644
    item 3).

  **Additive surfaces** (non-breaking): `RestrictRefUnresolvableError` (root-exported, alongside
  `DictKeyInUseError`); the kernel event map gains `'lookup:propagation-residue'` and
  `'derivation:wave-error'`.

  See [`docs/subsystems/via.md`](../docs/subsystems/via.md) (Phase C section — the #642
  formula-output-posture and #640 sync-delete-rollup subsections) and
  [`docs/subsystems/via-lookup.md`](../docs/subsystems/via-lookup.md) (the #651 key-resolution/altKey
  notes and the #654 restrict/propagation policy section) for the full story, every example traced to
  its shipped test.

### Patch Changes

- Fix three `describe()` fidelity gaps (#657):

  - A field declared only via `blobFields` was invisible in `describe()` — or, with a `fieldMeta` entry, appeared as `type:'unknown', widget:'text', editable:true`, actively wrong for binary content. The `'blob'` binding's `describeFragment()` is now consumed (mirroring the existing `'lookup'` consumer), so a blobFields field always appears with `type:'blob'`, `widget:'file'`, `editable:false`, and a `blob: { retainDays, ..., queryable:'none' }` block.
  - Async `describe({}).constraints` no longer leaks zod's `.int()` ±`Number.MAX_SAFE_INTEGER` safe-integer sentinel as `minimum`/`maximum` — those are JS-representability facts, not authored validation intent. An authored bound on a non-`.int()` field is untouched.
  - The static tier of `lookup()`/`dict()` (table-backed, no declared `keys`) now emits `lookup.keys` from the table's own key set, matching the `DescribedField.lookup` docblock's promise. Reserved/matrix tiers are unaffected.

  - Note: `toJSONSchema()` currently degrades the new `type: 'blob'` to JSON-Schema `type: 'string'` with no marker — a describe()-only fidelity pass; the JSON-Schema story is a separate follow-up.

- Via hardening round 2 (milestone #30 closure batch): nine small, independent hardening fixes on
  top of the merged via-consolidation pass, plus a build-script rider. No shipped consumer uses any
  of the affected surfaces yet (pre-1.0).

  - **#632** — the static-import scanner (`scripts/check-architecture.mjs`) now also catches
    side-effect imports (`import './x.js'`) and default imports (`import x from './x.js'`), not just
    named/namespace imports. Both new forms are proven by a synthetic-violation canary; the guard
    stays green on the real tree.
  - **#645** — the reconcile computed-deps validator's "known fields" universe now unions
    `ViaGraph`'s own field memory with the current call's options-derived set. A two-call scenario
    (classified field declared in call 1, a computed field's `deps` naming it in call 2) no longer
    spuriously refuses with "does not name a declared field".
  - **#631** — a declare-time cross-binding guard refuses two different binding families (e.g.
    `moneyFields` + `blobFields`) claiming the same field name. The exemption set is earned, not
    assumed: `{computed,money}`, `{computed,i18n}`, and `{computed,lookup}` compositions are proven
    legal by dedicated pins, and the guard is tightened to exactly-two-claimants. Classified/blob
    collisions always refuse. The guard is construction-time; the late-attach reconcile path remains
    narrower (a colliding re-open still half-applies as before — tracked follow-up).
  - **#652** — lookup ingest now normalizes an array-valued (`[].`-wildcard) field element-wise,
    matching `enforceWrite`'s existing all-elements semantics, instead of bailing on
    `values.length !== 1`. Single-value behavior is unchanged. (Bare-array — non-`[].`-wildcard —
    shape is a separate, still-open gap tracked by #661.)
  - **#635** — an elevated-tier (`tier > 0`) read now processes `_sealed` slots through the same
    `applySealedSlots` codec helper `decryptRecord` already uses, instead of falling back to raw
    plaintext-shaped JSON. Tier-0 and tier>0 reads now share one contract. (The write-side
    elevate/demote gap is separate and tracked by #662.)
  - **#627** — `viaFields` sugar (e.g. `viaFields: { price: money('EUR') }`) now participates in the
    late-attach reconcile path the same way the raw `moneyFields` sugar key already did — driven off
    the merged `mergeViaFields` view, not the raw sugar key alone. A colliding late-attach
    declaration now refuses loudly instead of silently no-op'ing.
  - **#634** — `exportRedact`'s `(coll as any).via` reach-in is replaced by a typed internal `_via`
    accessor; no behavior change, just removes the any-cast.
  - **#641** — lazy materialized-view resolve-on-read now respects the frozen-output rule in both
    strict and non-strict modes: a read whose MV output row falls in a frozen period returns the
    historical row, skips the write, and emits `derivation:skipped-frozen` — it no longer lets a
    `PeriodClosedError` escape through a read path.
  - **#646** — the two remaining vacuous two-instance sync pins (`mutation-choke-point.test.ts`'s
    MV sync-apply pin, `sync-dispatch.test.ts`'s id-threaded-decrypt pin) are retrofitted to
    db2-only strategy registration, so a passing assertion can only be satisfied by the puller's own
    wave-driven dispatch, not a shared-store write riding along from the local writer. Adds the two
    net-new tests the issue's mutation-testing pass flagged as missing: cm23 (a virtual computed
    field's structural absence from the sync payload, proven end-to-end over a real push()/pull()
    cycle) and cm15 (the reconcile cross-read taint assertion, replayed against a fresh session so
    the read is envelope-empirical rather than served from the writer's own warm cache).

  Rider: the hub package's `build` script now carries the DTS worker's heap flag via `execArgv`
  instead of requiring it in the caller's environment — plain `pnpm build` works with no env setup.
  (#660 tracks the underlying type-surface fix that makes the larger heap necessary in the first
  place.)

## 0.3.0-pre.9

### Minor Changes

- The Via port (#629, phase B): classified fields and blobs join phase A's money/i18n as
  kernel-orchestrated via-features, and every binding's declared `ViaPosture` — `encryptedAtRest`,
  `queryable`, `exportable`, `forgettable` — is now an **enforced** contract instead of
  documentation. `via-classified` (`shape/via-classified/`) seals `'recoverable'` fields at rest,
  enforces preset validation and `storage: 'never'` rejection before a write reaches the store, and
  participates in erasure; `via-blob` (`shape/via-blob/`) is a deliberately thin declaration +
  posture binding — blob content crypto stays service-side (`with-shape/blobs/`), never routed
  through the kernel's field-feature pipeline. Query, export, and forget all now consult posture
  generically (no per-feature brand checks): the query DSL refuses a `queryable: 'none'` field
  (new `FieldNotQueryableError` for `blobFields` — classified's own `det-exact` query behavior is
  unchanged, a byte-for-byte parity pin); `Vault.exportStream()`/`exportJSON()` deliberately redact
  an `exportable: false` field to the literal `'[sealed]'` on the record itself, ahead of the
  pre-existing `SealedHandle.toJSON()` accident that produced the same string as a side effect
  (both layers now verified independently); `vault.forget()` consults `forgettable` and folds each
  sealed-posture binding's `erase()` hook into its report, with parity-pinned shred/residue counts.
  New kernel machinery, `ViaCryptoCtx` (`sealedSlots` + `reservedEnvelopes`, both in
  `kernel/enclave/record-keys/sealed-slots.ts`), gives via-features a scoped, key-free door into
  per-record/per-collection crypto — the first consumer is `via-i18n`'s dictionary handle, which
  this phase reroutes off a direct `kernel/enclave` import onto `reservedEnvelopes('_dict_')`,
  **retiring the one remaining `via-enclave-isolation` grandfather** (that allowlist is now empty;
  `via-layering`'s allowlist is unchanged, still exactly `kernel/query/join.ts` → #626).

  **Downstream export output change:** the default (non-`redact`-option) export of a classified
  field via `@noy-db/as-csv`/`@noy-db/as-sql`/`@noy-db/as-xml` changes bytes — pre-#629 these
  satellites saw a live `SealedHandle` object and fell through to `JSON.stringify`-shaped output
  (`"""[sealed]"""` in a CSV cell; a `jsonb` SQL column with literal `'"[sealed]"'`); post-#629 they
  see the plain string `'[sealed]'` directly (a bare `[sealed]` CSV cell; a `text` SQL column with
  literal `'[sealed]'`). The new output is the intended one — the old bytes were an accidental echo
  of a live, `.reveal()`-capable handle reaching an export stream, which this phase's deliberate
  redaction closes.

  **Two erase-hook code paths ship real and unit-tested but stay production-dormant by design:**
  the sealed-CEK `_sealed_cek/*` host-delivery envelope purge (`via-classified`) and the blob-shred
  purge (`via-blob`) are both proven, by their respective pre-existing forget/erasure suites, to be
  vault-level operations unconditional on any given collection declaring `classifiedFields`/
  `blobFields` — routing either exclusively through its via `erase()` hook would silently regress
  collections that don't declare the field but still exercise `.blob()`/`sealRecordToHost()`.
  `vault.forget()` keeps calling both directly; the via bindings' `erase()` hooks carry only the
  classification/participation they legitimately own (classified's `_sealed`-slot shred/residue
  accounting, which IS live and wired). Making the purge scoping collection-declaration-aware is a
  future product decision, not a gap in this phase.

- The Via port (#638, phase C): a per-vault dependency graph (`ViaGraph`, `kernel/via-graph.ts`)
  now connects every derivation, rollup, materialized view, and `computed` field to the sources it
  reads, and enforces four structural fixes that were previously either silently wrong or a design
  gap:

  - **#636 — derived fields now inherit their strictest source's security posture.** A
    `computed` field whose `deps` include a classified source used to silently copy that source's
    plaintext (or a derivative of it) into an ordinary, unredacted field — the taint algebra
    (`foldPosture`) now folds `encryptedAtRest`/`queryable`/`exportable`/`forgettable` from every
    source, and a materialized field folding to `encryptedAtRest: 'sealed'` is actually sealed at
    rest (the same `ctx.sealedSlots` capability `via-classified` uses); a virtual field (never
    stored) is redacted on every read instead. **BEHAVIOR CHANGE, pre-1.0, deliberate security
    fix:** any existing `computed`-from-classified configuration now inherits the classified
    posture where it previously did not — such a field's `get()`/`list()`/export/query behavior
    changes from plaintext to sealed/redacted/refused after upgrading.
  - **#621 — sync-applied, cutover, and restore writes now dispatch derivations.** Previously only
    a local `put()` triggered a collection's derivations/rollups/materialized views; a write
    applied by `pull()`/`push()`/schema cutover/restore silently skipped dispatch entirely. A
    batched, per-target-deduped wave now runs once at the end of a sync session (and around
    cutover/restore) — N synced children of one rollup parent recompute the parent exactly once,
    not N times; a collection with no dependents in the graph is skipped with zero decrypt cost
    (unchanged for money/i18n-only collections).
  - **#622 — `vault.forget()` now fans out to derived residue.** Forgetting a record used to leave
    its derived copies and aggregate contributions behind. Record-grain derived artifacts (MV
    rows, array-shape derivation rows, same-id record-shape derivation copies) are now erased;
    aggregate-grain rollups are recomputed without the forgotten contribution in open periods, or
    skip + audit in frozen ones — the subject's own record is still unconditionally shredded
    either way.
  - **#637 — a frozen-period derivation output now skips + audits instead of failing the source
    write.** A derivation/rollup/MV output landing in a closed period used to throw
    `PeriodClosedError` straight through the _legal_ write that triggered the recompute (live
    local-write dispatch, `deriveAll()`, `refreshView()`, and — after the #621 fix above — the
    sync dispatch wave too). It now skips the write (the historical output stands) and emits a
    new `'derivation:skipped-frozen'` event, plus a `'lifecycle'` audit-ledger entry when
    `withHistory()` is active. In the sync dispatch wave specifically, one frozen (or otherwise
    failing) target in a batch no longer aborts the whole `pull()`/`push()` or starves a co-batched
    healthy target.

  **The declare-time typo guard (closes the #636 "typo reopening"):** on a collection that also
  declares classified fields, a `computed` entry with no declared `deps` — or with a `deps` entry
  naming an unknown field — now throws `ValidationError` at construction (an opaque function could
  otherwise silently copy a classified field's plaintext with no way for the graph to know). On a
  non-classified collection, `deps` may still name any field, including a plain field with no via
  feature declared on it at all — there is no schema-introspection API to validate against, and an
  unregistered dep folds to the default (untainted) posture, which is safe. **KNOWN LIMIT** (pinned,
  not silently left): the guard only checks that a `deps` entry names _some_ known field, not that
  it names the field the function actually reads — `deps: ['amount']` on a function that actually
  reads `ssn` still passes construction and still leaks, because the graph edge folds from
  `amount`'s posture, not `ssn`'s. Closing this fully needs runtime read-tracking or a
  schema-introspection capability outside this phase's scope. See
  [`docs/subsystems/via-computed.md`](../docs/subsystems/via-computed.md) for the declaration-order
  asymmetry this guard has (a single call combining a `storage: 'never'` classified field with a
  depsless `computed` field is refused; the identical pairing split across two separate
  `vault.collection()` calls is accepted, by design — a `never`-storage value cannot structurally
  reach a computed field's output) and its reconcile-path scope limit (a `deps` entry naming a
  classified field declared in an _earlier_, separate call currently over-refuses; the workaround is
  to declare both together in one call).

  **`computed(fn, { deps, mode })` ships as a full via-feature**, composable through `via(...)`
  (`via(computed(fn, { deps: [...], mode: 'virtual' }))`) and through an extended `computed: {
field: { fn, deps, mode } }` sugar form — both additive. `mode: 'materialized'` (the default) is
  byte-for-byte the prior eager write-time compute. `mode: 'virtual'` is new: the field is computed
  fresh on every read, never stored (absent from `_data`), and unconditionally
  `queryable: 'none'`. **Composition semantics are pinned for both modes** — `computed` always
  compiles last in the via-binding stack, so `via(computed(...), money(...))` on the _same_ field
  behaves differently per mode: in `mode: 'virtual'`, money's `present()` runs before the computed
  value exists, so the raw computed number survives unformatted; in `mode: 'materialized'`
  (default), the computed value is merged into the record before `encodeWrite`, so money's own
  encode/decode/present hooks format it normally, exactly like a plain money field. The formerly
  `@internal` `computedDeps` staging option (an interim seam from earlier in this phase, explicitly
  documented as "do not depend on this shape") is **removed** — folded into each `computed` entry's
  own `{ fn, deps?, mode? }` shape.

  **Additive surfaces** (non-breaking): `vault.deriveAll()`'s result gains a `skippedFrozen` counter,
  distinct from `derived` (a frozen-skip is not counted as a successful write); `ForgetResult` gains
  `derivedRecordsErased: number`, `derivedAggregatesRecomputed: number`, and
  `derivedResidueFrozen: readonly string[]` (all pre-existing `ForgetResult` fields are byte-shape
  unchanged); the kernel event map gains `'derivation:skipped-frozen'`
  (`db.on('derivation:skipped-frozen', handler)`).

  See [`docs/subsystems/via.md`](../docs/subsystems/via.md) (Phase C section) and
  [`docs/subsystems/via-computed.md`](../docs/subsystems/via-computed.md) for the full story,
  including every example above traced to its shipped test.

- The Via port (#650, phase D): a new `'lookup'` via-feature — `lookup()` / `enum()` / `dict()` —
  collapses the legacy `dictKey()`/`staticDict()` code-field pattern and a first-class
  reference-collection pattern into **one** binding with three backing tiers: `enum` (inline keys,
  no store), `dict` (a reserved `_dict_<name>` micro-collection — the native spelling of `dict()`,
  what `dictKey()` compiles onto), and `matrix` (a first-class collection like `countries` — the
  native spelling of `lookup()`'s default `backing: 'collection'`, what `staticDict()`'s table-based
  sibling `lookup(name, { backing: 'static', table })` also compiles onto for its own tier).

  **`dictKey()`/`staticDict()` are now aliases**, not deprecated spellings — internally they build
  the equivalent `LookupDescriptor` shape and validate against it, but they still compile onto the
  **`'i18n'`** via-binding, not the new `'lookup'` one. Their stored envelopes, the
  `type`/`widget`/`dict` slice of `describe()` output, and `.join()` dressing stay byte-identical to
  their native equivalent (`packages/hub/__tests__/via/lookup-alias-parity.test.ts`), but they do
  **not** gain the new `.lookup` describe() block below (only a native `lookup()`/`enum()`/`dict()`
  field produces one). Existing code using either sugar continues to work unchanged.

  **New capability, additive:**

  - `altKeys` — declare candidate values (e.g. an ISO3 code, a phone call-prefix) that normalize to
    the canonical key on `ingest`, sync and pure, from an already-materialized backing snapshot (no
    store read per `put()`).
  - `vocabulary: 'closed'` — write-time membership refusal (`UnknownLookupKeyError`) against the
    backing dimension's **actual current rows**, checked live, not a hardcoded universe. `'open'`
    (the `dictKey()`/`dict()` default) is unaffected. The dict tier's closed membership specifically
    is declared `keys` **union** the reserved dictionary's live rows (a declared key is known even
    before any row for it exists; a live row for an undeclared key is known too) — pinned by
    `lookup-vocabulary.test.ts:96`. Matrix tier has no declared key list at all — membership is
    purely the backing collection's live rows.
  - `sortBy` / `orderBy(field, dir, { by: 'label' })` — exact ordering by the resolved label, either
    fixed (`compareForOrder`, needs a declared `displayLocale`) or per-call (`{ by: 'label' }`,
    resolves at the query's own locale — a genuinely different sort order per call, not cached).

  **BEHAVIOR CHANGES (deliberate, pre-1.0, `@next` only):**

  - **#649 — closed-vocabulary membership is now real.** The `dictKey()` doc comment always claimed
    that a declared key set was enforced on `put()`; it never actually was (the runtime `keys` array
    was silently dropped at registration). `dictKey()` itself is UNCHANGED (still open — closing
    this for the alias was explicitly out of scope, to avoid silently breaking existing dictKey
    collections). The fix landed on the native `lookup()`/`enum()`/`dict()` spellings' own
    `vocabulary: 'closed'` opt-in only.
  - **#648 — `restrict` is the default reference semantics for a declared lookup field, and it is
    now enforced.** Deleting (or `forget()`-ing) a backing dictionary/collection row that a declared
    lookup field still references now throws `DictKeyInUseError` naming the referencing collection
    and count, refusing the delete before any mutation. `DictKeyInUseError` was declared, exported,
    and documented since before this phase, but its throw site was an empty comment block — this is
    its first-ever implementation. `cascade` (tombstones/deletes the referencing records) and
    `nullify` (nulls the referencing field via an ordinary `put()`) are opt-in per declaration
    (`onDelete`), propagating additively through both plain deletes and `forget()`
    (`ForgetResult.lookupReferencesCascaded`/`lookupReferencesNullified`/`lookupReferencesResidue`,
    new additive fields — `lookupReferencesResidue` reports any `cascade`/`nullify` propagation
    skipped because a reference's compare-key couldn't be resolved even from the live pre-shred
    backing row, always empty in the ordinary case, never silent when non-empty — every pre-existing
    `ForgetResult` field is unchanged). **A plain dictionary delete with no declared
    lookup-referencing field is completely unaffected** — this only fires for dimensions a
    `lookupFields`/`via(lookup(...))` declaration actually points at.
  - **Matrix-tier `sortBy` was silently inert through Task 6; it is now functional.** `sortBy` was
    accepted at declare time on a matrix-tier (`backing: 'collection'`) lookup field since it
    shipped, but `compareForOrder` had no route for that tier — a plain `orderBy()` on such a field
    silently fell back to raw stored-code order, no warning, no error. This task wires the matrix
    branch through the same sync snapshot `presentForJoin` already reads (`registry.ts`'s
    `buildLookupSnapshotRows`, keyed by `descriptor.key`), so a `sortBy` + `displayLocale`-declared
    matrix field's plain `orderBy()` now genuinely sorts by its resolved label, same as the reserved
    tier already did. Reserved-tier `sortBy` is unaffected.
  - **#647 — reserved (`_dict_*`) collections now participate in sync.** Before this phase,
    `vault.dictionary()` writes bypassed the mutation choke point entirely (raw adapter I/O, no
    dirty-log entry) and `SyncEngine.pull()` skipped every `_`-prefixed collection by the store
    contract — dictionaries never crossed `push()`/`pull()`, only backup/bundle export. Reserved
    lookup writes now dirty-log and dispatch like any other write, and `pull()` additionally
    enumerates an explicit reserved-lookup prefix registry through the ordinary apply path.
    **Deletes travel as version-ordered delete-markers**, the same #589 law every ordinary
    collection's sync-safe delete already follows — a deleted dictionary key can no longer be
    silently resurrected by a stale peer's next push.

  **#626 retired**: `kernel/query/join.ts` no longer imports `shape/via-i18n/core.js` — it calls a
  sync `presentForJoin` hook the `Collection` builds from its own i18n + lookup bindings instead
  (now covering the matrix tier too, not just reserved). The `via-layering` architecture guard's
  allowlist (`VIA_SHAPE_ALLOWLIST`) is EMPTY, proven to still fire on a synthetic violation. The
  sibling `via-enclave-isolation` guard's allowlist (`VIA_ENCLAVE_ALLOWLIST`) has also been empty
  since phase B and gains the same synthetic-fire proof (both in `via-guards-empty.test.ts`).

  **`describe()` gains a normalized `lookup` block**, sourced from `ViaBinding.describeFragment()` —
  declared since phase A, unconsumed until now. Present alongside (not replacing) the pre-existing
  `dict` block, which stays byte-stable for the `dictKey()`/`staticDict()` alias. Carries
  `dimension`/`backing`/`vocabulary`/`key`/`altKeys`/`present`/`sortBy`/`onDelete`, and the
  statically-known closed-vocabulary key set where one exists.

  **Removed**: `vault.applyLocale()` — a full parallel i18n+dict+static label-resolution path with
  zero production callers (superseded by `via.present`, orphaned since the phase A/C cutover).
  Dead public API; no behavior change for any caller (there were none).

  See [`docs/subsystems/via.md`](../docs/subsystems/via.md) (Phase D section) and
  [`docs/subsystems/via-lookup.md`](../docs/subsystems/via-lookup.md) for the full story — the
  canonical countries-matrix example, every capability traced to its shipped test.

- The Via port (#623, phase A): a kernel-owned field-feature SPI. Everything a field can be is now a **via-feature** — a per-field declaration plugging into one phased pipeline (write: ingest → encode; read: present) with a brand-keyed binder registry generalizing the #553 declaration-links-engine pattern. **money and i18n are fully retrofitted** behind the port: the kernel imports nothing from the feature layer (closes #612), enforced by two new architecture rules (`via-layering`, `via-enclave-isolation`) with exactly two documented grandfathers (`kernel/query/join.ts` → #626; `via-i18n/dictionary.ts` → phase-B ViaCryptoCtx). New public surface (additive): `via(...)` composer + the `viaFields` collection option — existing spellings (`moneyFields`, `i18nFields`, `dictKeyFields`) are preserved as sugar compiling to identical bindings (byte-identical stored envelopes, identical `describe()`). Also: an origin-tagged mutation choke point lands with strict behavior parity (the socket phase C plugs the dependency graph into — #621/#622); generic path utilities moved to `kernel/paths`; `I18nStrategy`/`NO_I18N`/dict predicates moved to the kernel port (`port/with/i18n-strategy`). Folder moves: `with-shape/money` → `shape/via-money`, `with-shape/i18n` → `shape/via-i18n` (subpath exports unchanged). Kernel net effect: collection.ts −232 lines (first ratchet-down since Phase 5); 20 money call sites + 10 i18n value bindings + 7 type inversions collapse to one grandfathered import. Upgrade note: materialized views with money `where()` clauses re-materialize once after upgrade (query-hash format changed; self-healing). Behavior is otherwise unchanged — the full money/i18n suites pass unmodified.

## 0.3.0-pre.8

### Minor Changes

- Period-driven cold archival (#613, #604 Spec 3). New `vault.archivePeriod(name)` relocates a closed period's in-window records (`_ts < periodExclusiveUpperBound(endDate)`) from the hot store to a configured cold tier, driving `routeStore`'s existing hot→cold migration + cold read-through. Non-destructive (reads still resolve), idempotent, gated only on a `closed` period, and records a `_period_archives/<name>` companion + ledger entry parallel to `freezePeriod` (the chained `_periods` record stays byte-immutable). Requires a `routeStore` with a cold route (`age: { cold }`); throws otherwise.

  Supporting additions: `routeStore.compact(vault, { before })` accepts an explicit cutoff (and `AgeRoute.coldAfterDays` is now optional — `age: { cold }` alone = period-driven archival only); `StoreCapabilities.coldArchival` advertises a cold-capable router.

  Note: `routeStore` now surfaces its primary store's `capabilities` (previously it exposed none), layering `coldArchival` on top. A consequence is that CAS-gated features (e.g. gap-free `sequence().next()`) are now permitted on a routeStore-backed vault when the primary store reports `casAtomic` — previously they refused on any routeStore. A router without its own cold route never advertises `coldArchival`, even when nested over a cold-capable primary.

- Period freeze (#604). `vault.freezePeriod(name)` physically reclaims the space held by a closed accounting period's delete markers — it purges the delete markers whose write-time falls within the period (via the operator-asserted safe-point the closed period provides), records a `_period_freezes/<name>` companion + a tamper-evident ledger entry, and leaves the hash-chained period record byte-immutable. Terminal and idempotent; requires `withPeriods()`. Forget-tombstones, history, and live records are untouched. Closes the `_purgeDeleteMarkers` audit-emission deferred from #589.
- Single-vault target-purge (#615, scoped base of #611). New `vault.purgePeriodTargets(name)` sweeps delete markers (`_ts < periodExclusiveUpperBound(endDate)`) off the vault's **push-only** sync targets (`backup`/`archive` roles) for a period that is already **closed and frozen** locally — reclaiming remote marker space that `freezePeriod`'s local purge can't reach. Records a `_period_target_purges/<name>` companion + ledger entry (mirroring freeze/archive; the chained `_periods` record stays byte-immutable), idempotent, gated on frozen-first. `sync-peer` targets are deliberately skipped (purging their markers could re-open the resurrection window — the deferred half of #611). A vault with no push-only targets writes no companion and is re-runnable. Single-vault only; fleet-wide purge remains klum's concern over `@noy-db/hub/cargo`. `surface: api` — rides the existing store contract (`loadAll`/`delete`), no adapter change.

### Patch Changes

- Never pull from a `backup`/`archive` sync target (#616). `Noydb.sync()` now calls the primary engine push-only when the primary's role isn't `sync-peer`, and `Noydb.pull()` is a no-op (empty result) for a non-`sync-peer` primary — so a backup/archive-only config (where the sink was elected as the primary) is no longer pulled from. This applies the role→direction policy the secondary fan-out already used to the primary too, making the code match `sync()`'s existing "backup/archive do push-only" contract. `surface: internal` — no public API change; an explicitly constructed `SyncEngine.pull()` still pulls.

## 0.3.0-pre.7

### Minor Changes

- Deletes now converge under sync (#589). `collection.delete()` on a synced vault writes a version-ordered `_del` marker instead of a physical removal, so a delete propagates on pull and offline peers can no longer resurrect deleted records; a legitimate re-create at a higher version still resurrects the id (guaranteed non-resurrection remains `forget()`'s job). A concurrent same-version delete-vs-edit resolves via the collection's conflict resolver, or delete-wins by default. Adds an operator purge seam (`Vault._purgeDeleteMarkers`) for the forthcoming period-close feature (#604). Adds an optional `_del` field to `EncryptedEnvelope` on the `@noy-db/hub/adapter` seam (additive) — every `to-*` store must round-trip it (new adapter-conformance vector); `noy-db-to` stores need a conformance pass. Local-only (non-synced) collections keep physical deletes — no change.

### Patch Changes

- Security (#590): sync now treats crypto-shred tombstones as terminal. `pull()` never overwrites a `forget()` tombstone with a live envelope regardless of `_v` and re-asserts the shred outward; `push()` asserts tombstones unconditionally and never conflict-resolves against one (resolvers are bypassed — an erasure cannot be overruled); `forget()` tombstones now enter the sync dirty log so the shred propagates on push. Suppressed edits are reported via `PushResult.erasures` / `PullResult.erasures` and the new `sync:erasure` event (new `ErasureEnforcement` type). Also fixes #598: every sync-applied local write now refreshes the Collection in-memory caches, so same-session readers see sync results (and never a decrypted residue of a shredded record).

## 0.3.0-pre.6

### Minor Changes

- Satellite collections (#591): off-row storage for heavy fields. Declare `collection(name, { satelliteOf, fields, joined })` to pair a base collection with a satellite holding its heavy/cold fields 1:1 on the record id — base reads never fetch or decrypt the heavy side. Explicit `fields` routing; persisted pairing marker (R-S9 drift refusal); narrow `JoinedHandle` full-record access via `vault.joined()`; existence-authority read filtering (get/list/search/retrieve/similarTo/det-lookups/bulk + bundle export); ordered fan-out writes with hardened best-effort revert; `forget()` fan-out through the full purge suite with residue-classification inheritance; pair-unit sync filters and pair-coupled conflict resolvers. Refusal matrix R-S1–R-S9. v1 scope: one satellite per base, new collections only, `crdt` pair members refused, satellite `query()` refuses loudly. New subpath `@noy-db/hub/satellites` (types). See docs/superpowers/specs/2026-07-05-satellite-collections-design.md.

## 0.3.0-pre.5

### Patch Changes

- Harden the classified R10 config-drift guard against a `_schemas/<collection>`
  lost-update race (#583).

  The persisted `x-classified` marker (R10 trigger signal (b)) shares its
  `_schemas/<collection>` record with the JSON-Schema writer. Both performed a
  get-then-put read-modify-write with **no** version guard, so interleaving their
  load→save windows lost whichever writer put first — dropping the marker (or the
  derived schema body) and transiently disabling R10 signal (b) for the
  first-write window.

  Fix: `savePersistedSchema` now takes an optional `expectedVersion` (the `_v`
  captured at load) and CASes on it via the store's native `put(..., expectedVersion)`
  optimistic-lock, and both writers (`persistSchemaIfNeeded`,
  `persistClassifiedMarker`) retry-on-`ConflictError` — re-reading, re-merging the
  other writer's field, and re-putting. On `casAtomic` stores the marker now
  survives a concurrent schema (re)registration by construction; the R10 read path
  (`classifiedMarkerDigestOnly()`) and the persisted marker format are unchanged.

- Security: reserved secret-collections are no longer readable by granted (sub-admin) principals.

  Secret-bearing reserved collections (`_sync_credentials`, and the pre-reserved
  `_broker` for #479) hold directly-usable secrets (transport OAuth tokens,
  connection strings, API keys) in their record contents. Two seams combined to
  expose them to a granted operator/viewer/client/custodian:

  - `vault.collection('_sync_credentials')` returned a working handle — the
    generic public read path had no guard for secret-bearing reserved names — so
    it decrypted with whatever DEK the caller's keyring held, bypassing the
    owner/admin gate on the dedicated `getCredential` API.
  - `grant()` propagated every `_`-prefixed DEK to every new keyring regardless
    of role, so a freshly-granted sub-admin received the `_sync_credentials` DEK.

  Fix (two layers):

  - `vault.collection()` now rejects secret-bearing reserved names with
    `ReservedCollectionNameError` (mirrors the existing `_dict_*`/`_links_*`
    guards). `_broker` is reserved now to future-proof the credential broker.
  - `grant()` no longer propagates secret-bearing reserved DEKs to sub-admin
    grantees (operator, viewer, client, custodian). Operational reserved DEKs
    (`_ledger`, `_history`, `_sync`) still propagate to every role. Owner/admin —
    the roles the dedicated credential API admits — still receive them, so the
    admin-reads-existing-credential flow is preserved.

## 0.3.0-pre.4

### Minor Changes

- classified: equatable blind index (slice 2b)

  Opt-in equality search over digest-only classified fields. Enabling `equatable: true` on `classified.password()` / `classified.secretAnswer()` (gated behind the collection-level `acknowledgeEquatableRisk: true` door, R8) attaches a store-visible `_bidx` equality tag to each envelope, so equal values produce equal tags and can be looked up with the new `collection.findByDigest(field, candidate)`. The lookup is a single `list + N get` sweep whose matches are confirmed in-hand against `_vdig` (no per-hit store op, no wrong-id return), and it emits exactly one `onAccess('find', '*')` consent op regardless of hit count. `scrubEquatableTags()` is the sole explicit tag drop-path (DEK rotation also drops tags); the `_bidx ⇒ _vdig` invariant holds and monotonic carry-forward preserves coverage on unrelated puts.

  Note: the honest cost band — equal tags leak the equality partition (who-shares-what and how-many, never the value), and a collection-DEK holder can offline-dictionary at the PBKDF2-SHA256 (600K) floor. The door, not the iteration count, is the control for low-entropy fields.

  NON-additive golden: `classifySealedShred` now returns a per-slot `{ field, class }` shape (was parallel arrays) to carry the `_bidx` slot disposition (`live-shreddable` + `dekResidue-in-backups`).

- Archetype-③ schema engines (money, computed, links, schema-update, introspection) are now declaration-gated instead of kernel-resident, so they tree-shake out of bundles that never declare them (#553) — the floor's eagerly-loaded set shrinks by ~14.5 KB min / ~5.2 KB gz. Money links its engine at `money()` declaration time (the sync query DSL is preserved exactly); computed/links/schema-update/introspection load on first use behind dynamic imports. No public API changes; hand-rolled money descriptor objects (not built via `money()`) now fail loud with `MONEY_ENGINE_NOT_LINKED`.
- Track A kernel-shrink tail (#267) — three changes that move optional capability off the always-on floor:

  - **`team` split:** multi-user grant/revoke/rotate move out of the always-on core behind the new `withTeam()` strategy + `@noy-db/hub/team` subpath. A collection that never opts into `withTeam()` no longer carries the grant/revoke/rotate machinery (smaller single-user floor). **Migration:** consumers using grant/revoke/rotate must now pass `teamStrategy: withTeam()` into `createNoydb({…})` — see `MIGRATING.md`.
  - **`lazy` service:** the cache + on-demand fetch path (previously buried inside routing) is promoted to its own opt-in service behind `withLazy()` + `@noy-db/hub/lazy`.
  - **gate prior-read elision (perf):** the gate bus skips its prior-read `adapter.get` + decrypt when no registered handler declares interest in the existing record — a wasted read on every gated put/delete removed on the no-interested-handler path.

### Patch Changes

- classified: C-A / R10 config-drift guard is now a SUPERSET check (covers `_vdig`-only and partial handles)

  The slice-2b config-drift guard (R10) closes the naive-handle plaintext-leak / silent-drop hole on already-shipped stage-2 `_vdig`-only classified collections — not just the new `_bidx` path. It is now broadened from the original naive-only gate (which fired only for a handle with NO `classifiedFields`) to a **superset check**: a handle may write a classified collection only if its declared digest-only set covers every field the collection carries as classified (union of the target `prev`'s `_vdig`/`_bidx` keys and the persisted x-classified marker's declared set). This closes the **partial-handle door** — a handle that declares classified field `Y` but not `X`, writing a record that contains `X`'s value, previously skipped the guard entirely and serialized `X` into `_data` as DEK-recoverable plaintext (a C-A confidentiality leak of a digest-only secret). Such writes now throw `ClassifiedConfigError`.

  MIGRATION NOTE: a write from a handle whose `classifiedFields` do not cover every classified field of the target collection now throws `ClassifiedConfigError` — fail-loud is the point. Re-open such collections with the full `classifiedFields` config (as the correctly-configured handle already does) and the write proceeds normally.

- `openVault(name)` is now single-flight: concurrent opens of the same vault converge on one `Vault` instance. Previously two callers racing past the cache miss each constructed a Vault — and later two Collections with independent DEKs for the same store slice — so a record written through one failed decryption through the other with a spurious `TamperedError` (#564; root cause of the recurring in-pinia CI flake).

## 0.3.0-pre.3

### Minor Changes

- Classified fields (stage 1): behavioral sensitive-field types. `classifiedFields`
  collection option with presets (`classified.creditCard()` composite with
  storage:'never' CVC, `birthDate`, `email`, `phone`), write-time riders +
  validation, sealed-backed storage, `withClassified()`-gated audited
  `collection.reveal()`, `x-classified` in describe()/toJSONSchema(), and
  `applyListProjection()` — consumed by as-csv/as-xlsx `redact` options (#489).
  Note: riders materialize at write time, so date-relative riders (ageBand,
  expiresSoon) are deliberately not offered; birthDate ships a stable `yob` rider.
  The birthDate preset validates real calendar dates (incl. leap years).
  Compile-time S-set query refusal for classified fields is deferred to stage 2 (values are runtime-sealed regardless).
- Classified fields (stage 2): the enclave oracle — verify-without-reveal. `classified.password({ minLength, rotateDays?, notLastN? })` and `classified.secretAnswer()` digest-only presets; `collection.verify(id, field, candidate)` and `verifyGroup(id, answers, { min })` (k-of-n), gated behind `withClassified()`; rotation policy (`notLastN` reuse ring, `rotateDays` → `{ ok, mustRotate }`). New AAD-bound `_vdig` envelope slot: AES-256-GCM, per-record per-write salt, PBKDF2-SHA256 600K digests encrypted at rest so the store can't dictionary-attack low-entropy secrets — rides the CEK (forget() crypto-shreds it, rotation re-encrypts it, the ledger binds it back-compatibly, pods carry ciphertext only). Refusal matrix R1–R6 at both config doors (digest-only requires perRecordKeys; no CRDT×classified; no deterministic/indexed/vector intersection; storage-form exclusivity). All crypto confined to `kernel/enclave/classify/**` (enforced by a new architecture ratchet); verify engine behind a dynamic import (bundle-gated). Deferred to a future slice: the `_bidx` equatable blind index / `findByDigest` (the only store-visible, frequency-leaking surface). Designed through a 3-lens pre-implementation adversarial audit + a final whole-branch security review.
- `collection.describe({})` (async) now surfaces validator constraints on each `DescribedField` (min/max, length bounds, enum, format) derived from the collection's schema, so consumers reading `describe()` see the same constraints the validator enforces.

### Patch Changes

- Two hygiene fixes (#554). **L-1**: the deterministic `_det` index now encrypts under a dedicated HKDF key (salt `noydb-det`) instead of sharing the collection DEK — separating the deterministic-IV regime from the randomized-IV `_data` regime. Existing `_det` stays findable via dual-query and self-heals to the new key on the record's next write; rotation-stable (the key is collection-level). **loadFanoutSidecar**: a corrupt/undecryptable fanout sidecar now surfaces the error instead of being swallowed as "absent" — orphan-row cleanup on an array-derivation shrink is no longer silently skipped.

## 0.3.0-pre.2

### Minor Changes

- describe()-driven layout metadata + history-complete pods (the Item release foundation).

  - **`FieldMeta.group` / `FieldMeta.order`**: card/section grouping and ordering hints flow through `collection.describe()` onto each `DescribedField` (channel > zod `.meta()` > inferred, like every other meta key). Purely descriptive — fields keep their stable alphabetical emission; consumers (the `@noy-db/ui` item family) apply the grouping.
  - **`_history` travels in the `.noydb` pod**: `vault.dump()` now enumerates the full-snapshot version-history collection alongside the ledger/schema/sequence/blob internals, so `collection.history()`, `getVersion()` and `diff()` work on a pod-restored vault. Load-side already restored `_internal` generically.

### Patch Changes

- Updated dependencies
  - @noy-db/attestation@0.3.0-pre.2

## 0.3.0-pre.1

### Minor Changes

- 0.3 line opener — the microkernel reorganization.

  - **Kernel/enclave reorg**: hub source regrouped into `kernel/` (spine + enclave) with every optional service under a `with-*` dimension folder; the vault/collection/noydb god-objects decomposed into focused facades.
  - **Enclave Contract v1**: opaque `EnclaveKey`, protected-body access helpers, `EnclaveNotSupportedError` refusal contract, executable conformance kit, and a golden-frozen enclave barrel (the fork-swap seam).
  - **Family doors**: new subpaths `/to` `/on` `/at` `/in` `/as` `/by` `/with` `/ui`, each with a golden surface. `/to` supersedes `/adapter` (kept as deprecated alias).
  - **`/cargo` orchestration seam** supersedes `/kernel` (kept as deprecated alias) — the canonical binding surface for outward orchestrators.
  - **`withX()` opt-in gating across services (S4)**: attestation, tiers, sealed-record, portability, sequence, custody, search, cargo, and friends are now uniformly tree-shakeable strategy opt-ins; zero-config `createNoydb()` ships with a built-in memory store.
  - **`bundle` → `pod` canonical naming** (deprecated aliases kept); the `with-share` dimension dissolved into `/pod`.
  - **Sensitive-field surface**: `Sealed<V>` access gate, compile-time refusal of sealed fields in `where`/`orderBy`/`scan`/`index`/`groupBy`, typed `aggregate()` builders, money reducers, and the S/Q/M generics on `vault.collection()`.
  - **Security hardening**: `forget()` erases `_sealed_cek` envelopes (H-1/M-1); subject-index ids keyed with an HMAC PRF (M-2); derivations fanout sidecar encrypted (M-3); sealed-record expiry fails closed (M-4); sealed-record revoke softness made explicit with opt-in hard rotate (M-5).
  - **Portability**: `extractPartition` carries the slice's blobs re-keyed under a fresh transfer DEK; blobs travel in `vault.dump()`/`.noydb` pods.
  - **Terminology & docs**: subsystem → service (`SUBSYSTEMS.md` → `SERVICES.md`); the propaedeutic docs layer (guides/showcases/playground/recipes) extracted to the `noy-db-docs` repo.

### Patch Changes

- Updated dependencies
  - @noy-db/attestation@0.3.0-pre.1

## Unreleased

### Internal: microkernel refactor — god-object decomposition (no public API change)

The three always-on hub files were decomposed behind named folder seams, taking the kernel from ~13,525 LOC to ~10,400 (−23%) with the public surface byte-identical (the `/kernel` + `/adapter` golden-surface tests guard it). No behavior change; the full suite stayed green throughout.

- **Optional subsystems** are now grouped into eight `with-*` dimension folders (`with-lookup`/`with-commit`/`with-formula`/`with-shape`/`with-audit`/`with-fork`/`with-share`/`with-party`); each cohesive cluster moved behind a small deps interface with the kernel keeping thin delegators. Shared caches/registries (the per-record CEK `Lru`, eager-index caches, the subsystem bus) stay kernel-resident and pass **by reference**.
- **`collection.ts`** 5774→4300, **`vault.ts`** 4722→3824, **`noydb.ts`** 3110→2274. Examples: envelope/CEK crypto → `record-keys/record-codec.ts`; auth/recovery/enrollment → `with-party/team/`; backup/dump-load → `vault-backup.ts`; tiers/search/index-maintenance → `with-audit/tiers` + `with-lookup/{search,indexing}`; the Collection constructor → a pure `resolveCollectionConfig()` + thin wiring.
- **Additive only at the seams:** new `@noy-db/hub/describe` subpath (the UI contract); `bundle` moved to the `with-share` dimension (subpath unchanged); `vault.dump()`/`.noydb` bundles now include the `_blob_*` collections so blob covers travel sealed inside the artifact; `extractPartition` carries a slice's blobs re-keyed under a fresh transfer DEK (no master-key leak).

Record-scoped sealing (epic [#306](https://github.com/vLannaAi/noy-db/issues/306)) — sealed `sensitive` fields now participate in crypto-shred and tamper-evidence end to end — plus money-typing parity across the aggregate builders.

### Feature: record-scoped sealing — `forget()` erases sealed fields + the ledger attests them ([#306](https://github.com/vLannaAi/noy-db/issues/306))

- **Erasure.** When a collection sets both `sensitive` and `perRecordKeys`, each sealed field's key now derives from the record's per-record CEK (`deriveSealedFieldKeyFromCek`) instead of the collection DEK. `vault.forget()` drops the record's wrapped `_cek`, which now makes `_sealed` cryptographically unrecoverable — the same erasure guarantee `_data` already had. `ForgetResult` gains a **`sealedFieldsShredded`** count.
- **No-migration dual-read.** Reads try the CEK-derived key first and fall back to the collection-DEK key, so records sealed before this change stay readable with no migration step; they upgrade to CEK-derivation on their next `put()`. `rotateRecordCek` re-encrypts `_sealed` under the new CEK rather than carrying it forward.
- **Ledger integrity.** The history ledger's `payloadHash` now binds `_sealed`, so `vault.verifyBackupIntegrity()` detects tampering or erasure of a sealed value. Backward-compatible: a record with no sealed fields hashes exactly as before (`sha256(_data)`), so existing ledgers and non-sealed backups verify byte-identically. `_cek` is intentionally **not** bound (a tampered wrapped-CEK self-detects, and `rotateRecordCek` rewrites it with no ledger entry).
- **Boundary.** A backup captured _before_ `forget()` that retained both `_sealed` and `_cek` remains recoverable by a collection-DEK holder — the same caveat `_data` carries.

### Feature: money-field typing across all aggregate builders ([#306](https://github.com/vLannaAi/noy-db/issues/306))

- `scan().aggregate(b => …)` and `query().groupBy(...).aggregate(b => …)` now auto-type `b.sum`/`min`/`max` over a declared `moneyFields` member as **`MoneyString`**, matching `Query.aggregate` — completing the opt-in money-field (`M`) type matrix across `Query`, `ScanBuilder`, and `GroupedQuery`/`GroupedQueryN`. Type-only (phantom generic defaulting to `never`), so collections that don't opt in stay `number`.

## 0.2.0-pre.31

### Patch Changes

- Extract the 16 non-essential `to-*` storage adapters to the separate `noy-db-to` repo (essentials `to-memory`/`to-file`/`to-browser-idb`/`to-meter`/`to-probe` stay). Extend `@noy-db/hub/adapter` with the bundle-store contract for the extracted backends to bind against, and re-private the `test-adapter-conformance` kit (workspace-only, never published).

## 0.2.0-pre.12

Multi-vault federation (epic [#271](https://github.com/vLannaAi/noy-db/issues/271)) + fiscal-grade field, lifecycle & numbering primitives (m17 clusters A–D).

### Feature: multi-vault federation — `VaultGroup` ([#271](https://github.com/vLannaAi/noy-db/issues/271))

- **`db.openVaultGroup(...)`** routes a logical collection transparently across many physical vaults (shards). `ShardedCollection` / `ShardedQuery` fan out reads with skipped-shard reporting (`SkippedVault`, including a `'no-grant'` reason for shards you can't decrypt). ([#292](https://github.com/vLannaAi/noy-db/issues/292))
- **Cross-vault live + distributed aggregate** — `ShardedQuery.live()` / `.aggregate()` / `.groupBy().aggregate()` give reactive snapshots and a single **central reduce** over the union of all shards, so `avg`/`mean` are exact (never avg-of-avgs). Federation ships as a **lazy chunk** (dynamic import; type-only entry exports), so it stays out of the core bundle until used. ([#319](https://github.com/vLannaAi/noy-db/issues/319))
- **Key-custody-neutral fan-out** — `queryAcross` no longer assumes a single custody model; shards you lack a grant to are skipped, not failed. New optional **`Reducer.merge(a, b)`** combines partial results computed in parallel across shards. ([#312](https://github.com/vLannaAi/noy-db/issues/312))

### Feature: `money()` — currency-safe decimal field ([#300](https://github.com/vLannaAi/noy-db/issues/300))

- Schema-layer descriptor (sibling of `i18nText()` / `dictKey()`) for exact decimal money, stored as a scaled-integer **digit string** — exact past `Number.MAX_SAFE_INTEGER`. ISO-4217 default scales; 7 rounding modes (excess precision rejected by default). Multi-currency mode carries the currency per record. `sum` / `min` / `max` run in **BigInt** with incremental `remove()` (exact under live aggregation / MV maintenance); `avg` over a money field throws **`MoneyUnsupportedError`** rather than returning a lossy figure.
- Money errors (`MoneyPrecisionError` / `MoneyCurrencyError` / `MoneyUnsupportedError`) now extend **`NoydbError`** (codes `MONEY_PRECISION` / `MONEY_CURRENCY` / `MONEY_UNSUPPORTED`), so they're caught by the documented `catch (e) { if (e instanceof NoydbError) }` convention.

### Feature: computed scalar fields ([#302](https://github.com/vLannaAi/noy-db/issues/302))

- **`computed: { … }`** declares schema-owned scalar fields derived on write — pure and synchronous, run **first** in the write pipeline in declaration order (a later field can read an earlier one). The result is **materialized**: stored, queryable, and `aggregate(sum())`-able. A computed field overwrites any user-supplied value of the same name; a throwing function rejects the write with **`ComputedFieldError`** (extends `NoydbError`). Composes with `money()`, and `immutableGuard`-frozen fields are skipped so computed values may still be recomputed.

### Feature: immutable collections / WORM ([#301](https://github.com/vLannaAi/noy-db/issues/301))

- **`immutableGuard({ collection, after })`** — declarative write-once-after-condition sugar over the existing `guards` machinery (block-on-`check`/`onDelete` + ledgered admin `amendment`). `after(record)` is evaluated on the existing record, so inserts and the transition write are allowed; everything after is blocked with `RecordLockedError`. `appendOnly: true` = immutable from creation. The audited `amendment` transaction is the only override.

### Feature: blob retention, legal-hold & record archival ([#311](https://github.com/vLannaAi/noy-db/issues/311), [#307](https://github.com/vLannaAi/noy-db/issues/307))

- Blob `vault.compact()` gains **`legalHold`** (never evict while held) and **`retainUntil`** (period-bound retention floor); an unparseable `retainUntil` **fails closed** (record retained). ([#311](https://github.com/vLannaAi/noy-db/issues/311))
- **`withArchive`** relocates sealed records to a cold store at the envelope level (no re-encryption): `vault.archive()` / `vault.listArchived()` / `vault.restore()`. Archival bypasses guards and a `legalHold` predicate blocks it entirely; archived records read `null` from the primary store until restored. ([#307](https://github.com/vLannaAi/noy-db/issues/307))

### Feature: atomic gap-free sequences ([#303](https://github.com/vLannaAi/noy-db/issues/303))

- **`vault.sequence(name).next()`** — gap-free, exactly-once numbering (invoice / DDT numbers) over an optimistic compare-and-swap counter; `peek()` reads the current value without allocating. Independent per name and concurrency-safe (jittered CAS retry; `SequenceContentionError` past the retry budget). **Online-only by design** — `next()` throws `SequenceOfflineError` unless the store advertises `capabilities.casAtomic`. Counters survive `dump()` / `load()` backup round-trips (`_sequences` is preserved in backups). Ships with a forget-cascade design spec ([#304](https://github.com/vLannaAi/noy-db/issues/304)).

## 0.2.0-pre.11

### Security: `openVault` no longer self-provisions into another principal's vault ([#313](https://github.com/vLannaAi/noy-db/issues/313))

- Opening a vault you hold **no grant** to that is **already held by other principals** now fails closed with `NoAccessError` and writes **nothing** — previously it silently minted a fresh owner keyring (new DEKs) into that vault and then read zero records. Genuinely-new vaults (no `_keyring/*`) still open-or-create exactly as before.
- New opt-in **`openVault({ create: false })`** (and `queryAcross({ create: false })`) forces strict open-existing: a missing grant throws `NoAccessError` instead of creating.
- The gate sits **before** managed-passphrase secret resolution, so managed (KMS-sealed) mode also writes nothing on the fail-closed path. The `getKeyring` callback path and `onInvalidKey: 'reset'` are unchanged.

## 0.2.0-pre.10

Adopter-reported correctness + introspection batch.

### Fix: unique indexes are now enforced ([#293](https://github.com/vLannaAi/noy-db/issues/293))

- `{ fields: [...], unique: true }` on a collection index is **enforced at write time** — single-field **and** composite. A duplicate of an existing non-null value is rejected with the new **`UniqueConstraintError`** (carrying `collection` / `recordId` / `fields` / `conflictingId`). Previously `unique: true` was silently dropped — the input `IndexDef` didn't even carry the flag — a data-integrity footgun.
- **Null-tolerant** (SQL NULL-distinct): the constraint applies only when every constrained field is non-null; duplicate `null`/`undefined` values coexist.
- Enforcement covers `put` / `putMany` / `delete`, the atomic-rollback path, and the hydration rebuild (uniqueness holds against records written in a prior session).
- **Eager mode only.** Declaring `unique` on a lazy (`prefetch:false`), CRDT, or tiered collection now **fails loud** at registration with the new **`UnsupportedIndexOptionError`** (those write paths bypass the check, so silent acceptance is refused).

### Fix: `dumpSchema()` completeness ([#294](https://github.com/vLannaAi/noy-db/issues/294), [#295](https://github.com/vLannaAi/noy-db/issues/295))

- Surfaces fields for **`z.discriminatedUnion`** schemas — the union of member fields (required only when required in _all_ members), with the discriminator's literal set. Previously returned `fields: {}`. ([#294](https://github.com/vLannaAi/noy-db/issues/294))
- Populates the **`derivations`** and **`overlayViews`** maps (both registries gained an `all()`); derivations are keyed by **output collection**, so multiple derivations sharing one source no longer collide. ([#295](https://github.com/vLannaAi/noy-db/issues/295))
- Materialized-view `aggregate` ops now render as **`sum(field)`** / **`count`** instead of `"[object Object]"` (reducers carry `op`/`field` metadata). ([#295](https://github.com/vLannaAi/noy-db/issues/295))

### Feature: omit rows from a materialized view ([#297](https://github.com/vLannaAi/noy-db/issues/297))

- A `unionSources` `map` callback may return **`null`/`undefined`** to omit a source record from the view — no more sentinel rows. (Derivation `derive` omission was already supported at runtime via `optional` outputs.)

### Feature: discriminated-union narrowing helper ([#296](https://github.com/vLannaAi/noy-db/issues/296))

- New **`isDiscriminant(record, key, value)`** type-guard narrows a `Collection<Union>` read by its discriminant without `as unknown as` casts. See `docs/core/06-query-basics.md`.

## 0.2.0-pre.9

### Feature: automatic snapshot cadence ([#272](https://github.com/vLannaAi/noy-db/issues/272))

- `withSnapshots({ snapshotPolicy })` — opt-in automatic whole-vault snapshots on a `debounce`/`interval` cadence (default `manual`). Auto-snapshots write a single rolling `<vault>__auto` key, decoupled from the immutable on-demand pool and **exempt from retention** so the timer never evicts labeled checkpoints (and on-demand `snapshot()` preserves the rolling slot). Driven off `onAfterWrite`; flushes on tab-hide/exit; torn down by `db.close()`.
- `SnapshotMeta.auto` flags the rolling snapshot; it lists first and restores like any checkpoint.

## 0.2.0-pre.8

### Feature: i18n multilingual-field hardening ([#284](https://github.com/vLannaAi/noy-db/pull/284))

Opt-in extensions to `i18nText`/`dictKey` — every existing field behaves exactly as before (zero breaking change).

- **Per-layer `onMissing` policy** (`'substitute' | 'null' | 'throw'`, scalar or per-layer map) + declared **`substitute`** preference chain on `i18nText`. Default `'throw'` preserves today's behavior; the `read` layer (`get`/`list`) is wired (guard/mv/derivation/join/export tracked in [#285](https://github.com/vLannaAi/noy-db/issues/285)).
- **Per-locale script enforcement** (`script: 'auto' | {locale: Script[]}`, `onScriptViolation: 'reject'|'filter'|'warn'`) with **asymmetric Latin tolerance** — non-Latin locales also allow Latin (embedded brand/building names), Latin locales reject other scripts; `Common`/`Inherited`/`Mark` always allowed. New `ScriptViolationError`. ([#283](https://github.com/vLannaAi/noy-db/issues/283))
- **dictKey parity**: `onMissing`/`substitute` on labels; array-of-keys → `[{key,label}]` pair objects; **wildcard-path `contacts[].title`** → per-element `<leaf>Label`. ([#282](https://github.com/vLannaAi/noy-db/issues/282))
- **`I18nMap<Langs, Required>`** type helper — infers `Partial` vs full map shape from the `required` mode so absent optional locales are `string | undefined` at compile time.

## 0.2.0-pre.7

### Feature: cross-join query primitive ([#277](https://github.com/vLannaAi/noy-db/pull/277))

- Added **`.crossJoin(target, { as })`** to `Query<T>` — expresses cartesian-product relations between two vault collections, composing with `.where()`, `.wherePredicate()`, `.groupBy()`, and `.aggregate()`.
- Supports a **lateral** form (`on:` callback) that filters or supplies the right-hand rows per left row.
- Guarded by a **cost ceiling**: `CrossJoinTooLargeError` aborts before materializing a product larger than the configured limit; `CrossJoinSourceUnknownError` surfaces an unresolved target. Dim 11 v3.

### Feature: vault snapshots — checkpoint/restore ([#279](https://github.com/vLannaAi/noy-db/pull/279))

- Added opt-in **`withSnapshots()`** strategy (`@noy-db/hub/snapshots`) exposing `db.snapshot()`, `db.listSnapshots()`, and `db.restoreSnapshot()`.
- Snapshots are full encrypted `.noydb` bundles backed by any `NoydbBundleStore`; a sidecar `${vaultId}__index` blob holds `SnapshotMeta[]` for listing without downloading snapshot blobs.
- **Declarative retention** enforcement and **`ledgerHead` tamper-detection** on restore. Zero footprint when omitted (the `NO_SNAPSHOTS` stub throws on all methods).

### Fix: de-flaked cross-tab conflict test (#228c)

- `tab-write-propagation` conflict test now polls for emitted conflicts instead of waiting a fixed number of `settle()` ticks — removes a timing race that intermittently failed on contended CI runners. Test-only change.

## 0.2.0-pre.6

### Fix: nested i18nField paths not resolved on read ([#273](https://github.com/vLannaAi/noy-db/issues/273))

- `applyI18nLocale` now traverses **dot-notation paths** (`address.lineOne`) and **array-wildcard paths** (`contacts[].title`) when resolving i18nText fields on read. Previously only top-level keys resolved; nested paths returned the raw `{ [locale]: string }` map.
- `enforceI18nOnPut` (required-translation validation) updated to the same path-aware traversal so nested required fields are validated on `put()`, not silently skipped.
- Auto-translate (`autoTranslate: true`) updated to traverse dot paths; array-wildcard paths are silently skipped (unsupported for auto-translate).

## 0.2.0-pre.5

### Track A — kernel shrink ([#262](https://github.com/vLannaAi/noy-db/pull/262))

- Introduced **`SubsystemBus`**, an internal observe/gate bus that decouples the kernel from its subsystems. Gate points (`beforePut`/`beforeDelete`, throw-to-abort) and observe points — including a new `afterDelete` that completes observe-bus symmetry — now flow through the bus instead of bespoke per-subsystem wiring.
- Migrated **periods** and **guards** enforcement onto the gate bus.
- Added a **kernel-surface CI gate** (`check-architecture.mjs`) that locks in the reduced kernel surface so it can't silently re-grow.
- Internal architecture shrink only — no public API change.

## 0.2.0-pre.4

Version-only lockstep bump; no source changes since pre.3.

## 0.2.0-pre.3

The **same-device multi-tab coordination** line ([#228](https://github.com/vLannaAi/noy-db/issues/228)). Additive over pre.2: one opt-in entry point, `db.enableTabCoordination()`, gives a vault open in multiple browser tabs primary/secondary election, live cross-tab write propagation, and concurrent-write conflict detection. Browser-only (Web Locks + BroadcastChannel, same-origin); a graceful no-op everywhere else.

### Presence + tab roles ([#251](https://github.com/vLannaAi/noy-db/pull/251))

- `db.enableTabCoordination(opts?)` elects one **primary** tab via an exclusive Web Lock; the rest are **secondary** and re-elect when the primary closes. A presence heartbeat over `BroadcastChannel` publishes active tabs.
- New surface: `db.tabRole`, `db.activeTabs()`, `db.onTabRoleChange(fn)`, `db.onActiveTabsChange(fn)`. Idempotent enable; torn down on `close()`.

### Cross-tab write propagation ([#252](https://github.com/vLannaAi/noy-db/pull/252))

- A write committed in one tab refreshes that document in every other tab that has the collection loaded — no reload. **Ciphertext-blind:** only `{ vault, collection, docId, action }` cross the channel; receivers re-read the shared encrypted store and decrypt locally.
- Role-agnostic; applied remote writes never re-persist or re-fire write hooks (no loop). Opt out with `enableTabCoordination({ propagateWrites: false })`.

### Cross-tab write conflict detection ([#253](https://github.com/vLannaAi/noy-db/pull/253))

- Concurrent same-document writes are detected via a per-document own-write version ledger. `db.onWriteConflict(fn)` (and the `write:conflict` event) emit a `WriteConflict { vault, collection, docId, local, remote, base, localVersion, remoteVersion, baseVersion }` — decrypted records; `base` is the common ancestor from history, or `null` when history is unavailable.
- The hub converges the cache to the store's authoritative value but **never auto-resolves** — reconciliation is left to the application.

### Write hooks

- `WriteEvent` now carries `vault`, `baseVersion`, and `version` (the version fields are sourced from the write basis, matching the version actually written). Backward-compatible additions for `onBeforeWrite` / `onAfterWrite` consumers.

## 0.2.0-pre.2

The **transferable bundles + document attestation** line. Additive over pre.1: a new vault-coupled attestation subsystem, the transferable-partition bundle ceremony, and recipient-target sealing — plus a signer-hardening fix.

### Document attestation — issue + revocation side ([#236](https://github.com/vLannaAi/noy-db/issues/236), [#238](https://github.com/vLannaAi/noy-db/issues/238))

- New `@noy-db/hub/attestation` subpath. Declare `collection(name, { attestation: { fields } })`, then `vault.issueAttestation(collection, id)` mints a signed-QR commitment (`{ docId, qr, keyId, publicKeyB64 }`) and writes an encrypted `_attestations/<docId>` index (field paths + source version only — never field values). Owner-only.
- `vault.getDocumentSigningPublicKey()` publishes the firm's Ed25519 public key for offline verification.
- Whole-doc revocation: `vault.revokeAttestation(docId)` / `unrevokeAttestation` track an encrypted `_attestations/_revoked` set; `publishRevocationList()` signs it with the firm key (same `keyId` as issued docs).
- Pairs with the pure, hub-free `@noy-db/attestation` verifier core.

### Signer hardening ([#242](https://github.com/vLannaAi/noy-db/issues/242))

- `getDocumentSigningPublicKey` now reads an existing key for any DEK-holder but **only the owner may mint a missing one** (a non-owner read on a fresh vault raises `AttestationError` instead of silently minting the firm's identity key).
- Concurrent first-mints **converge**: the loser of the `put(expectedVersion:0)` race re-reads and returns the winning keypair rather than surfacing a raw `ConflictError`.

### Transferable partition bundles ([#225](https://github.com/vLannaAi/noy-db/issues/225))

- `extractPartition(vault, opts)` projects a seed-predicate FK-closure (`walkClosure`, auto-derived from the `RefRegistry`) into a re-keyed bundle sealed under a one-time transfer key; `adoptPartition` + `createOwnerOnAdoptedPartition` complete the recipient-side ceremony under a new owner. Optional `carrySchemas` / `carryLedger`.

### Recipient-target bundle sealing ([#234](https://github.com/vLannaAi/noy-db/issues/234))

- Final slice of recipient-target sealed delivery — a bundle can be sealed so only the intended recipient can open it.

## 0.2.0-pre.1

The **`at-*` family graduation** line. Minor bump (`0.1 → 0.2`) because it carries a **breaking change** (#211). The `at-*` sealing-key family — debuted in pre.16 — is now first-class: a cloud-KMS provider trio ships, bundle auto-unlock generalizes beyond passphrases, hub is decoupled from the Shamir plugin, and the family is registered in the catalog.

### ⚠️ Breaking — hub ↔ on-shamir decouple ([#211](https://github.com/vLannaAi/noy-db/issues/211))

- `@noy-db/hub` **no longer re-exports** the Shamir share codecs (`encodeShareBase32` / `decodeShareBase32`) — import them from `@noy-db/on-shamir` instead.
- Shamir recovery now requires an **injected provider**: `createNoydb({ shamirRecovery: shamirRecoveryProvider() })` (from `@noy-db/on-shamir`). Managed-passphrase mode mandates strong recovery, so managed-mode vaults now also need this provider.
- hub holds no static import of on-shamir — the layering inversion + build-cycle risk are gone. See `MIGRATING.md`.

### Bundle auto-unlock generalized ([#215](https://github.com/vLannaAi/noy-db/issues/215))

- New `autoCredentials` / `sealedCredentials` on `writeNoydbBundle`, carrying `{ kind: 'passphrase' | 'password' | 'pin', value }` — a delivered bundle one-click-unlocks whatever tier the user enrolled.
- `autoPassphrases` / `sealedPassphrases` remain as **deprecated sugar** (`kind: 'passphrase'`). On read, `autoUnlock.perUser[user]` is now `{ kind, value }`; dispatch login by `kind` (PIN is a prefill, not an enrollment). WebAuthn is rejected (hardware-bound). Pre-0.2 bundles read back unchanged.

### `at-*` cloud-KMS provider trio (new packages)

- `@noy-db/at-aws-kms` ([#188](https://github.com/vLannaAi/noy-db/issues/188)), `@noy-db/at-gcp-kms` ([#189](https://github.com/vLannaAi/noy-db/issues/189)), `@noy-db/at-azure-keyvault` ([#190](https://github.com/vLannaAi/noy-db/issues/190)) — `SealingKeyProvider`s backed by cloud KMS encrypt/decrypt. Ambient credentials only.

### Catalog

- `at-*` registered in `features.yaml` (new `sealers:` section) + `docs/packages/at-hosts.md` ([#214](https://github.com/vLannaAi/noy-db/issues/214)). The README now names the **two trust boundaries**: zero-knowledge (`to-*`/`by-*`) vs trusted-compute (`at-*`, which _can_ decrypt the scoped slice it unseals).

## 0.1.0-pre.16

The **sealing dimension foundation** + the **`at-*` sealing-key provider family debut**. Where every prior tier protected the vault with something the user _knows_ or _has_ (passphrase, WebAuthn, PIN), `at-*` providers seal it with a key drawn from the _environment_ — an env var, an OS keychain — for unattended / managed-host scenarios. Shipped alongside managed-passphrase mode, the recovery-profile dispatch groundwork, and the persisted-schema introspection trio.

This release also lands a build fix: `main` had been red since [#196](https://github.com/vLannaAi/noy-db/issues/196) — see "Build" below.

### Sealing dimension + managed-passphrase mode ([#14](https://github.com/vLannaAi/noy-db/issues/14) slice 1, [#186](https://github.com/vLannaAi/noy-db/issues/186))

- New `SealingKeyProvider` contract + sealed envelope. A provider supplies a sealing key from outside the user's head; the vault's wrap material is sealed under it for hands-off unlock.
- `@noy-db/at-env` ([#187](https://github.com/vLannaAi/noy-db/issues/187)) and `@noy-db/at-macos-keychain` ([#191](https://github.com/vLannaAi/noy-db/issues/191)) are the first two providers — the `at-*` family debut. Cloud/OS providers (AWS/GCP/Azure KMS, wincred, libsecret, WebAuthn-PRF) are tracked under the [at-\* sealing key providers](https://github.com/vLannaAi/noy-db/milestone/9) milestone.
- Managed-passphrase mode mandates **at least one strong recovery profile** and disables the rotate-passphrase gate ([#195](https://github.com/vLannaAi/noy-db/issues/195)); `recoverManagedPassphrase` added.

### Recovery + rotation

- `db.rotateRecovery()` — gated, deliberate paper-code regeneration ([#121](https://github.com/vLannaAi/noy-db/issues/121), [#185](https://github.com/vLannaAi/noy-db/issues/185)).
- Shamir recovery-profile dispatch ([#196](https://github.com/vLannaAi/noy-db/issues/196) slice 1) — the recovery path can route to a `shamir` profile.

### Bundles + derivations (slice 1s)

- Sealed bundle delivery: `autoPassphrases` + `sealedPassphrases` on `writeNoydbBundle` ([#197](https://github.com/vLannaAi/noy-db/issues/197) slice 1).
- Variable-N derivations — `shape: 'array'` ([#200](https://github.com/vLannaAi/noy-db/issues/200) slice 1).

> **Public-API surface lock.** `autoPassphrases`, `sealedPassphrases`, `recoverManagedPassphrase`, `rotateRecovery`, and the `managedPassphrase` option are exported public API as of this release — future slices of #196/#197/#200/#14 must extend, not rename, them.

### Schema introspection trio

- Persisted JSON Schema — opt-in encrypted `_schemas/<col>` envelope ([#174](https://github.com/vLannaAi/noy-db/issues/174)).
- `vault.dumpSchema()` introspection primitive ([#175](https://github.com/vLannaAi/noy-db/issues/175)).
- `noydb describe` CLI — bundle → YAML/JSON audit ([#176](https://github.com/vLannaAi/noy-db/issues/176), in `@noy-db/cli`).

### Fixes

- `Collection._doDelete` now dispatches eager MV refresh ([#181](https://github.com/vLannaAi/noy-db/issues/181), [#183](https://github.com/vLannaAi/noy-db/issues/183)).
- Ledger entries can be tagged `import:<format>` via `collection.put({ reason })` ([#1](https://github.com/vLannaAi/noy-db/issues/1), [#184](https://github.com/vLannaAi/noy-db/issues/184)).

### Build

- Removed `@noy-db/on-shamir`'s spurious `peer`+`dev` dependencies on `@noy-db/hub`. #196 made hub import on-shamir's secret-sharing engine at runtime; combined with on-shamir's (never-imported) hub deps, turbo saw a `hub ↔ on-shamir` build cycle and **`main` failed CI from #196 through #197**. on-shamir is a self-contained primitive _consumed by_ hub, so its hub deps were dead metadata. Properly decoupling hub from the on-shamir package (via injected provider) is tracked in [#211](https://github.com/vLannaAi/noy-db/issues/211) (deferred).

## 0.1.0-pre.15

A small fast-follow to pre.14's Dim 14 v2: extends `withMaterializedView` along two consumer-driven axes ([#165](https://github.com/vLannaAi/noy-db/issues/165) + [#166](https://github.com/vLannaAi/noy-db/issues/166)), folds in a pre.14 type-only cleanup ([#131](https://github.com/vLannaAi/noy-db/issues/131)), and resolves two niwat-review follow-ups ([#169](https://github.com/vLannaAi/noy-db/issues/169) + [#170](https://github.com/vLannaAi/noy-db/issues/170)). 5 issues closed, 1 PR merged ([#167](https://github.com/vLannaAi/noy-db/pull/167)), 28 new hub tests, 1601 hub tests on the tip.

### Multi-key `groupBy` ([#166](https://github.com/vLannaAi/noy-db/issues/166))

- `Query<T>.groupBy(...fields)` is now variadic with a back-compatible single-arg overload (TypeScript prefers the single-field overload via declaration order, so existing call sites keep their narrowed return type).
- Result rows carry every grouped field in **declaration order**, followed by reducer outputs. `groupBy('clientId', 'period')` produces `{ clientId, period, ...aggregates }`.
- New internal `canonicalGroupKey(fields, row)` helper — sorts field names lexicographically before serialising, so the bucket dedup key is invariant under field-argument order (`groupBy('a','b')` and `groupBy('b','a')` produce the same buckets). The helper is reused by the UNION MV dedup path.
- `GroupedQueryBase` shared abstract class holds the constructor + protected fields; `GroupedQuery<T, F>` and `GroupedQueryN<T, F>` override only `aggregate()` for the appropriate return-type generic. Eliminates the drift risk of parallel near-identical wrappers.
- Cardinality warning now lists every grouped field name (`[a, b, c]`); `GroupCardinalityError` at 100k distinct tuples; thresholds unchanged.
- MV strategies can use multi-key `groupBy` inside `query()` callbacks unchanged — dependency analyzer correctly walks the multi-key plan node.

### UNION materialised views ([#165](https://github.com/vLannaAi/noy-db/issues/165))

`withMaterializedView` gained a new top-level mode: `unionSources: [{ collection, map }, ...]` reads from multiple sibling collections in one declaration. Per-source `map` is the schema-unification boundary — sibling collections with different schemas project to a single MV row shape (the strategy's `TRow` type parameter). Declarative `groupBy: string | ReadonlyArray<string>` + `aggregate` fields then run on the concatenated stream.

Registration validation (new `MaterializedViewConfigError`):

- Mutually exclusive with `query` — strategy uses one or the other
- `unionSources.length >= 2` required
- Distinct collection names across arms required
- Empty `groupBy: []` rejected
- `aggregate` without `groupBy` rejected ([#169](https://github.com/vLannaAi/noy-db/issues/169))
- `predicates` rejected on UNION mode for now ([#170](https://github.com/vLannaAi/noy-db/issues/170)) — per-arm predicate semantics is a deferred feature

Executor path: reads each arm, runs per-source `map`, concatenates, then dispatches by shape (no groupBy → return as-is; groupBy without aggregate → dedupe via `canonicalGroupKey`, first row wins per composite key; groupBy + aggregate → delegate to `groupAndReduce`). Source-write hook fires on every arm via the existing dependency reverse-index — `Collection.put` is unchanged.

`summarizeUnionPlan` hashes arm collection names in **declaration order** (semantically meaningful for the dedup-only path — first-seen row per composite key wins, and reordering arms must trigger a refresh). `groupBy` fields and `aggregate` keys are still sorted (genuinely commutative). Two regression tests pin the asymmetry. (niwat review, [#167](https://github.com/vLannaAi/noy-db/pull/167) — first finding addressed in `6be47a2`.)

`maxRows`, `onEmpty`, `strict` semantics inherited unchanged. Composes with multi-key groupBy: the niwat canonical monthly-VAT shape — `union(taxReceipts, creditNotes).groupBy('clientId', 'period').sum('vat')` — is the combined test fixture.

### `GuardStrategyHandle` variance cleanup ([#131](https://github.com/vLannaAi/noy-db/issues/131))

`GuardStrategyHandle<T>` is invariant in `T` because `T` appears in callback positions on the spec (`check(incoming: T, ctx)`, `invariant(changes: ReadonlyArray<GuardChange<T>>, ctx)`). Pre.14 worked around it with `GuardStrategyHandle<any>` + two `eslint-disable @typescript-eslint/no-explicit-any` annotations on public-API fields.

The fix: a sealed internal `GuardStrategyHandleAny` existential interface (`{ __noydb_strategy: 'guard'; spec: GuardStrategy<any> }`) as the array element type. Both `Handle<Invoice>` and `Handle<Disbursement>` structurally widen to this erased form. Three call sites updated:

- `NoydbOptions.guardStrategies` at `packages/hub/src/types.ts:1751–1752`
- `Vault` constructor option at `packages/hub/src/vault.ts:374–375`
- `_initGuards()` internal at `packages/hub/src/vault.ts:1410–1411` (bonus third site beyond the issue's two)

The single `any` retained inside the existential body is the established named-existential pattern — `any` is now contained behind a private named boundary instead of leaking from public-API field positions. Type-only refactor; no behaviour change; guards test suite (48 tests) and showcase 79 unchanged.

### Niwat-review follow-ups

`5b385e7` adds two registration guards from the niwat review of [#167](https://github.com/vLannaAi/noy-db/pull/167):

- [#169](https://github.com/vLannaAi/noy-db/issues/169) — UNION MV with `aggregate` requires `groupBy` (else the executor silently dropped the reducer)
- [#170](https://github.com/vLannaAi/noy-db/issues/170) — `predicates` not supported on UNION MVs (predicate hashes weren't folded into `summarizeUnionPlan` and `.wherePredicate` never fired in the executor)

Both fail-fast at registration with `MaterializedViewConfigError`, same pattern as the existing empty-`groupBy` and arm-distinct-collection guards.

### Known follow-up

`Collection._doDelete` does NOT call `dispatchMaterializedViews` (only the two `put` code paths at `packages/hub/src/collection.ts:1283` and `:1399` do). Deleting a source row never triggers an eager MV refresh; tombstoning fires only when a subsequent `put` on the same source re-runs the executor, or when `vault.refreshView()` is called manually. Affects all MVs with `onEmpty: 'delete'` (the default) — not just UNION-form. The tombstone test in `packages/hub/__tests__/materialized-views/union.test.ts` lands in manual-refresh form (proves the executor + `listOutputIds` are correct) and is paired with an `it.todo` at line 333 pinning the auto-dispatch gap for a future PR.

### Showcases + docs

- [`85-with-multikey-groupby`](https://github.com/vLannaAi/noy-db/blob/main/showcases/src/85-with-multikey-groupby.showcase.test.ts) — variadic groupBy walkthrough, declaration-order assertions, niwat per-(client, period) shape
- [`86-with-union-mv`](https://github.com/vLannaAi/noy-db/blob/main/showcases/src/86-with-union-mv.showcase.test.ts) — UNION MV walkthrough with the monthly-VAT example
- `docs/services/aggregate.md` — new "Multi-key groupBy" section
- `docs/services/derivations.md` — "Multi-key groupBy in MV queries" + "UNION sources" sections
- `features.yaml` — new invariants under `aggregate` and `materialized-views`; new showcase entries cross-linked from both

## 0.1.0-pre.14

Two related strands shipped together: **Guards/Derivations v1.5** fast-follows from the pre.11 surface, then **Dim 14 v2 — `withMaterializedView`** built on top. 12 issues closed across 7 merged PRs; ~3000 LOC added across `src/`; 1573 hub tests pass on the tip.

### Guards/Derivations v1.5 ([#148](https://github.com/vLannaAi/noy-db/pull/148))

Four fast-follow refinements that landed first to give the MV v2 work a hardened `ReadOnlyVaultFacade` foundation:

- **`withGuard.onDelete`** ([#145](https://github.com/vLannaAi/noy-db/issues/145)) — guards can now reject deletes based on record state. Mirrors the `check` hook's shape but fires on `Collection.delete`. Used by the v2 MV tombstoning path: a `receipts.onDelete: throw` rule no longer deadlocks the system's own housekeeping deletes (see § Tombstone bypass below).
- **`withDerivation` optional outputs** ([#144](https://github.com/vLannaAi/noy-db/issues/144)) — declare an output as `optional: true` and return `null` to skip emission. If a prior derivation emitted at this id, it's tombstoned via `Collection._internalDelete` (system-internal bypass of user `onDelete` guards). Returning `null` for a non-optional output still throws `DerivationOutputShapeError`.
- **`derive(source, ctx)` gets the `ReadOnlyVaultFacade`** ([#147](https://github.com/vLannaAi/noy-db/issues/147)) — same facade guards have. `ctx.vault.collection<T>('siblings').get(id)` works inside `derive`. Strategy hash incorporates `derive.toString()` so the function body pins inputs; sibling reads must be deterministic given the same source row (consumer responsibility).
- **`.query()` on `ReadOnlyVaultFacade`** ([#146](https://github.com/vLannaAi/noy-db/issues/146)) — aggregating checks can now express set-level invariants (`vault.collection('invoices').query().where(...).count()`) inside guard `check` callbacks. Closes the "I can't enforce 'no two open invoices for the same client' without sweeping list()s" gap.

### Dim 14 v2 — `withMaterializedView` ([#149](https://github.com/vLannaAi/noy-db/issues/142) spec + [#143](https://github.com/vLannaAi/noy-db/issues/143) implementation epic)

Query-level materialized views. Where `withDerivation` v1 projects one source row into N typed outputs, `withMaterializedView` materializes the result of an entire `Query<T>` — filter, groupBy, aggregate, join — into a queryable collection kept fresh on source writes. Six sub-issues across foundation, lifecycles, correctness, predicates, overlays, and showcases:

- **Foundation** ([#150](https://github.com/vLannaAi/noy-db/issues/150), PR [#156](https://github.com/vLannaAi/noy-db/pull/156)) — `withMaterializedView({ name, query, rowKey, refresh })` factory; `MaterializedViewRegistry`; `MaterializedViewExecutor`; `Collection.put` source-write hook for eager refresh. `_materializedFrom` payload metadata (lives inside encrypted `_data`, opaque to the store — matches `_derivedFrom` precedent). `MaterializedViewCycleError` + `MaterializedViewSourceUnknownError`. New `@noy-db/hub/materialized-views` subpath.
- **Lazy + manual lifecycles** ([#151](https://github.com/vLannaAi/noy-db/issues/151), PR [#157](https://github.com/vLannaAi/noy-db/pull/157)) — `refresh: 'lazy'` marks the MV stale on source writes; the next read of the MV output collection resolves on demand. `refresh: 'manual'` opts out of the source-write hook entirely; `vault.refreshView(name)` is the only refresh path. Returns `{ written, deleted, failed }` — niwat-review caught the original "deleted: 0 hardcode" pre-merge.
- **Correctness — partition / onEmpty / ceiling / strict / aggregate** ([#152](https://github.com/vLannaAi/noy-db/issues/152), PR [#158](https://github.com/vLannaAi/noy-db/pull/158)) — five strategy fields:
  - `output.partition: { field, value }` — same-collection edges are allowed when a where-clause provably excludes `partition.value` (`==` against a different value, `!=` against the value, `in` lists that exclude it). Cycle detector resolves these as non-cycles.
  - `onEmpty: 'delete' | 'keep'` (default `'delete'`) — when a key that previously emitted rows yields zero rows, tombstone via `Collection._internalDelete`. User `onDelete` guards on the output collection are bypassed for housekeeping (the composition fix that makes #145 + MV refresh coherent).
  - `maxRows` (default `100_000`) — row-count ceiling; throws `MaterializedViewTooLargeError` **before** any writes (clean rollback).
  - `strict: true` re-throws row-write failures → composes with `withTransactions` to roll back the source-write atomically via `revertExecuted` (the orphan-window fix from pre.12 #133).
  - **Aggregate / groupBy queries** — executor branches on the terminal shape (`Query<T>.toArray()` / `Aggregation.run()` / `GroupedAggregation.run()`). `groupBy().aggregate()` closes over its source so the dep analyzer can't introspect; aggregate MVs require explicit `sources?: string[]`.
- **Declared deterministic predicates** ([#153](https://github.com/vLannaAi/noy-db/issues/153), PR [#159](https://github.com/vLannaAi/noy-db/pull/159)) — `MaterializedViewStrategy.predicates: { [name]: { hash, fn } }` registers named functions callable from inside the MV's `query()` callback via `.wherePredicate(name, ctx?)`. The predicate's `hash` **and** a canonical-JSON hash of the `ctx` argument both fold into `queryHash` — bumping `hash` or changing `ctx` forces refresh. Canonical use: `isOverdue` against an `asOf` date that moves externally. Niwat-review caught the original "predicates dropped through chain methods" pre-merge: every chain operator (`where`, `or`, `and`, `filter`, `orderBy`, `limit`, `offset`, `join`) now threads the predicates map.
- **Overlay views — `withOverlayedView`** ([#154](https://github.com/vLannaAi/noy-db/issues/154), PR [#160](https://github.com/vLannaAi/noy-db/pull/160)) — read-shadow primitive. Declares a virtual collection that merges a `base` (typically an MV output) with a user-writable `overlay` via a single-field shadow predicate (`overlay[shadowField] === shadowValue`). Writes through the virtual proxy route to the overlay. Constraints: `base` must be concrete (no overlay-on-overlay stacking — v3 non-goal); `overlay` must not be an MV output; virtual name must not collide with concrete collections or MV outputs. Four error classes (`OverlayBaseIsVirtualError`, `OverlayCollectionUnavailableError`, `OverlayNameCollisionError`, `OverlayIdMismatchError`).
- **Showcases + reader-facing docs** ([#155](https://github.com/vLannaAi/noy-db/issues/155), PR [#161](https://github.com/vLannaAi/noy-db/pull/161)) — four new showcases (`81-with-mv-eager`, `82-with-mv-lazy`, `83-with-overlay`, `84-with-mv-predicates`) totaling 19 tests; `docs/services/derivations.md` extended with Materialized Views + Overlay views sections; `features.yaml` entries for `materialized-views` and `overlay-views`.

### Composition story

The pre.14 release closes the loop on the write-path primitive composition:

- **Guards** ([#123](https://github.com/vLannaAi/noy-db/issues/123), pre.11) — block writes before encryption.
- **Derivations** ([#129](https://github.com/vLannaAi/noy-db/issues/129), pre.11) — eager / lazy record-level projections, post-write.
- **`withGuard.onDelete`** ([#145](https://github.com/vLannaAi/noy-db/issues/145), pre.14) — symmetric delete-side gate.
- **Materialized views** ([#143](https://github.com/vLannaAi/noy-db/issues/143), pre.14) — query-level derivations; same encryption / opacity guarantees.
- **Overlay views** ([#154](https://github.com/vLannaAi/noy-db/issues/154), pre.14) — operator-editable override layer over MV outputs.

The `Collection._internalDelete` housekeeping bypass (introduced in #148 for #144's tombstoning) is the load-bearing primitive that keeps `withGuard.onDelete: throw` rules coherent with system-driven tombstones from optional derivations and MV `onEmpty: 'delete'` flows.

### Process notes for niwat integration

- All five MV PRs (#156–#160) plus #161 passed niwat-review with "No issues found" verdicts after pre-merge fixes. The niwat-review pattern that worked: surface composition issues (e.g. "list/query/scan don't trigger lazy resolve", "chain methods drop predicates map") before the PR landed on main.
- Stacked-PR rebase pattern documented in [project memory](https://github.com/vLannaAi/noy-db/blob/main/) after this cycle: when squash-merging a stack of N PRs, the canonical recovery for the (N+1)th descendant is `reset --hard origin/main && cherry-pick <descendant-only-commits>` rather than re-rebasing the original branch. Re-rebasing leaks conflict markers when the parent's content has been merged with reviewer-fix tweaks.

### Files of interest

- `packages/hub/src/materialized-views/{executor,registry,stale,dependency-analyzer,query-hash,with-materialized-view}.ts`
- `packages/hub/src/overlay-views/{registry,virtual-collection,with-overlayed-view,types}.ts`
- `packages/hub/src/query/builder.ts` (predicates threading + `serializeClause` for `wherePredicate`)
- `showcases/src/8{1,2,3,4}-*.showcase.test.ts`
- `docs/services/derivations.md` (extended)
- `docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md` (the spec)

## 0.1.0-pre.12

Three follow-ups from pre.11's guards + derivation work: bundle regression plugged ([#130](https://github.com/vLannaAi/noy-db/issues/130)), strict-mode multi-output orphan window closed ([#133](https://github.com/vLannaAi/noy-db/issues/133)), and user-list visibility flags shipped ([#122](https://github.com/vLannaAi/noy-db/issues/122)). Plus [#132](https://github.com/vLannaAi/noy-db/issues/132) closed as superseded by #130.

### Bundle regression fix (#130)

Root cause: `Vault` and `Collection` had **static value imports** of `GuardRegistry`, `DerivationRegistry`, `ReadOnlyVaultFacade`, `GuardExecutor`, and `DerivationExecutor` — forcing the classes into `dist/index.js` even when consumers only imported `createNoydb`. Verified by inspecting the generated dist artefacts: the 5 class names all appeared in the floor bundle's top-level imports.

- **Fix** — converted all 5 to type-only imports + lazy `await import(...)` at construction / dispatch time. Mirrors the deferred-load approach already used by some other subsystems.
- **Bundle measurement** — floor dropped from **45,238 gz → 39,524 gz (−12.6%)**. Not all the way to the v0.25 baseline because of intervening features unrelated to the regression — the baseline has been reset on a methodology that now uses `splitting: true` (matches what real consumer bundlers emit).
- **Leak canaries** — 5 new symbol-presence assertions added to `check-bundle.mjs`, plus a new `eagerImports` field that catches splitting-aware regressions. The prior leak would have silently passed CI without these.
- PR [#138](https://github.com/vLannaAi/noy-db/pull/138), follow-up fixups in commit `03544b3` per code review.

### Strict-mode derivation orphan (#133)

When a strict-mode derivation produced multiple outputs and a later strategy threw, the first M outputs were already written via the `dispatchDerivations` `Collection.put` recursion. Those nested writes were **not** visible to the outer transaction's revert plan, so `revertExecuted` rolled back the source but left orphans on disk.

- **Fix** — `Noydb` now tracks the active transaction context (set by `runTransaction` at Phase 2 start, cleared in `finally`). `Collection.dispatchDerivations` checks the active context and registers each derived put as a side-effect op in `ctx._executed` before the write fires. `revertExecuted` already walks `_executed` in reverse — side-effect entries get reverted naturally.
- **Adjacent site fixed in flight** — same treatment applied to `Collection.putManyAtomic`, which has its own bespoke commit loop and would have had the identical orphan window otherwise (caught in code review).
- **Reproduction scope** — the orphan was only reproducible with **two strategies on the same source**; single-strategy multi-output never partially writes because `DerivationExecutor.run` validates all output shapes upfront before any persistence call.
- PR [#139](https://github.com/vLannaAi/noy-db/pull/139).

### User-list visibility flags (#122)

Two new visibility controls on top of the per-vault user envelope (pre.6 work):

- **Per-user `hidden` flag** — stored at `_meta/visibility/<keyringId>` (sidecar, plaintext bypass — mirrors `_meta/policy` and `_meta/handle`). Set via `vault.user.setMyVisibility({ hidden: true })` (own-only). `listUsersWithEnvelopes` filters hidden envelopes by default; admin / owner callers pass `{ includeHidden: true }` to see them.
- **Vault-level `directory.enabled` flag** — stored at `_meta/directory`. Toggled via `Noydb.setDirectoryEnabled(vault, enabled)` (owner-only). When false, `listUsersWithEnvelopes` throws the new `DirectoryDisabledError` for non-admin / non-owner callers.
- **Breaking API change** — `listUsersWithEnvelopes` gained a required `callerRole: Role` parameter. Consumers using the function directly must update; the hub-internal wrappers source `callerRole` from the unlocked keyring (signed-by-construction, no bypass). Documented as a minor-version surface change.
- **Design adaptation** — the issue proposed adding `hidden` to `PublicUserEnvelope.data`, but `UserEnvelope.data: T` is opaque-to-hub by contract (apps own the schema). Used the sidecar pattern instead, preserving the existing invariant.
- **New error** — `DirectoryDisabledError`, exported from `@noy-db/hub` and the `team/` subpath barrel for `instanceof` checks.
- **Honest caveat documented** — visibility is a **UX flag, not a privacy guarantee**. The keyring count and envelope ciphertext are still observable to anyone with store-read access; hidden hides only the joined plaintext from the directory enumeration.
- **Lifecycle** — `revoke()` also deletes the visibility sidecar (commit `6f5543c`, caught by code review). Without this, a re-granted same-userId would silently inherit the old flag.
- PR [#140](https://github.com/vLannaAi/noy-db/pull/140), follow-up fixup `6f5543c`.

### Closed without code (#132)

The original premise — "pre-hash the `withDerivation` handle so `register()` becomes sync so the `Vault` constructor can own derivation init" — was broken by #130. To plug the bundle regression, `DerivationRegistry` is now dynamically imported via `await import(...)` — the constructor can no longer reference `new DerivationRegistry()` directly. Pre-hashing alone has independent minor value (debugging) but doesn't move the needle on the original goal (plugging the `Noydb.vault()` sync fallback accessor gap). Closed with rationale; revisit if anyone hits the fallback gap in practice.

### Test count growth

1485 → **1494** hub tests (9 new across the three fixes / features). 124 test files total.

### Known follow-ups (pre.13 milestone)

- Remaining real-provider showcase batch (Apple / Google / LINE): [#64](https://github.com/vLannaAi/noy-db/issues/64), [#65](https://github.com/vLannaAi/noy-db/issues/65), [#73](https://github.com/vLannaAi/noy-db/issues/73), [#74](https://github.com/vLannaAi/noy-db/issues/74), [#75](https://github.com/vLannaAi/noy-db/issues/75), [#76](https://github.com/vLannaAi/noy-db/issues/76).

### Issues closed

#122, #130, #132, #133

## 0.1.0-pre.11

Two new subsystems land in the same release: **`withGuard`** (record lock + field freeze + role-gated amendment invariant) and **`withDerivation`** (deterministic derived data, Dim 14 v1). Closes the pre.11 milestone — 8 substantive issues, 2 PRs, plus 4 reviewer-caught side-fixes and 2 tier-2 auth showcases.

### Guards subsystem (#123 epic)

`withGuard` plumbs a uniform three-axis guard primitive — record-level lock, field-level freeze, and role-gated amendment invariant — into the `Collection.put` / `.delete` write path. Strategies register against (collection, fieldOrLock) pairs; the executor runs synchronously inside the put pipeline with full plaintext access. Cross-collection invariants get a `ReadOnlyVaultFacade` so the strategy can read sibling collections without re-entering the write lock.

- **`withGuard` factory + `GuardStrategy` types** ([#123](https://github.com/vLannaAi/noy-db/issues/123)) — `withGuard(spec)` returns a strategy handle; the spec declares `collection`, `kind: 'lock' | 'freeze' | 'invariant'`, target field(s) or lock condition, and an optional `amendable` clause (role list + invariant predicate). New `@noy-db/hub/guards` subpath barrel (sibling of `@noy-db/hub/periods` in the `time-and-audit` cluster).
- **`GuardRegistry` + `GuardExecutor`** ([#124](https://github.com/vLannaAi/noy-db/issues/124)) — registration at vault open, dispatch on every put/delete, frozen-field diff (`fieldChanged(prev, next, path)` deep-equality with array-aware semantics), amendment change collection, invariant runner. Strategies that throw are surfaced as one of the four typed errors below.
- **`LedgerEntry` extension with `op: 'amendment'` + audit-aware skip** ([#125](https://github.com/vLannaAi/noy-db/issues/125)) — every successful amendment writes an extra ledger entry carrying the changed-fields diff + invocation factors. `verifyBackupIntegrity` and `reconstructAtVersion` skip `op: 'amendment'` entries when reconstructing the canonical record stream (these are audit overlays, not state transitions). **Side-fix during review**: pre-fix, both helpers would have falsely failed integrity on any vault with amendment entries — the bug existed in latent form because no amendment entries existed yet. Fixed in this release before any user could hit it.
- **`Collection.put` / `.delete` guard hook + `ReadOnlyVaultFacade`** ([#126](https://github.com/vLannaAi/noy-db/issues/126)) — guard executor runs after permission check, before encryption + ledger commit. `ReadOnlyVaultFacade` exposes a frozen vault snapshot to amendment invariants so cross-collection rules (e.g. "amendment of `invoices` requires open `period` in `periods`") can read sibling state. **Side-fix during review**: the initial PR stubbed the facade as `null` / `[]`, blinding cross-collection reads; caught in code review and replaced with a real read-only proxy over the in-memory plaintext layer.
- **Four error classes** ([#127](https://github.com/vLannaAi/noy-db/issues/127)) — `RecordLockedError`, `FieldFrozenError`, `InvariantError`, `AmendmentForbiddenError`. All carry `collection`, `id`, and rule context; `InvariantError` and `AmendmentForbiddenError` additionally carry the changed-fields list and the invariant's name. Exported from the `@noy-db/hub/guards` subpath barrel + root for `instanceof` checks.
- **Showcase 79 — accounting end-to-end** ([#128](https://github.com/vLannaAi/noy-db/issues/128)) — invoice lock after issue, frozen `amount` / `clientId` post-finalization, period-aware amendment invariant requiring open accounting period + audit-trail role. Full round-trip including ledger replay verification.
- **Side-fix during review** — cache-invalidation in `putManyAtomic` revert path. The transaction-revert pass touched the canonical record but not the cached plaintext, leaving a stale entry. Caught while verifying guard rollback semantics; fix benefits any future `putManyAtomic` revert scenario.

### Derivations subsystem (#129 epic, Dim 14 v1)

`withDerivation` plumbs deterministic derived data — every put on the source collection eagerly recomputes outputs and stamps `_derivedFrom` metadata on each output record. Lazy lifecycle (stale tracking + on-read resolution in `Collection.get`) provides the read-path resolution when the source mutates outside a put (sync replay, batch import).

- **`withDerivation` factory + types** — `DerivationStrategy`, `OutputSpec`, `DerivedFromMeta`. New `@noy-db/hub/derivations` subpath barrel (sibling of `@noy-db/hub/tx` in the `write-and-mutate` cluster).
- **`DerivationRegistry` with DFS cycle detection** — runs at vault open. Builds a strategy DAG; rejects open with `DerivationCycleError` if the cycle wouldn't terminate (carries the offending strategy chain). Max-depth ceiling enforced via `DerivationDepthError`.
- **`DerivationExecutor`** — runs `derive(record)` on plaintext under the same in-memory snapshot the put sees, validates output shape against the registered `OutputSpec` (`DerivationOutputShapeError`), rejects unknown output collections (`DerivationOutputUnknownError`), stamps `_derivedFrom: { source, sourceId, sourceVersion, strategyHash }` on each output record.
- **`computeStrategyHash`** — SHA-256 over `source-collection-name + sorted(output-keys) + derive.toString()`. Stable across runs; lets the lazy path detect drift when the strategy redeploys against existing output records.
- **Four error classes** — `DerivationCycleError`, `DerivationDepthError`, `DerivationOutputUnknownError`, `DerivationOutputShapeError`. Exported from the `@noy-db/hub/derivations` subpath barrel + root.
- **Eager dispatch in `Collection.put`** — after store + ledger commit, the registry's `derivationSource(collection, id)` callback fires, executor walks the strategies, writes outputs. Strict mode rethrows; soft mode marks stale.
- **Lazy lifecycle** — stale tracking via `WeakMap<DerivationRegistry, Set<string>>`. `Collection.get` checks staleness, resolves on read, writes-through. Bulk recompute via `vault.deriveAll(collection)` for cold-cache scenarios.
- **Side-fix during review** — `runTransaction` revert-plan reorder. Pre-fix, `executed.push(...)` ran AFTER the put/delete call, so a mid-put throw (including strict-mode derivation failures) bypassed rollback registration and corrupted the transaction's exit state. Now `executed.push(...)` runs BEFORE the call. The fix benefits any future mid-`Collection.put` throw scenario, not just derivation strict-mode.
- **Showcase 80 — PDF source → meta + text outputs** — round-trip exercising eager + lazy paths, cycle-detection at open, strategy-hash drift recognition.

### Tier-2 auth showcase coverage (#77, #78)

Closes the two `priority: high` real-provider gaps from the 2026-05-09 audit — the only tier-2 packages that hold wrap-key material on their own (`on-password` derives a wrap-DEKs key via PBKDF2; `on-webauthn` releases a PRF fragment to wrap KEK).

- **Showcase 71 — `on-password` tier-2 capability matrix** ([#78](https://github.com/vLannaAi/noy-db/issues/78)) — 16 scenarios pinning the `kek: null` keyring security contract: cold-start unlock via `(vault, userId, password)` triple; capability matrix on tier-1-gated ops (✅ read/write/query, ❌ enrollAuthenticator/rotatePassphrase/grant); re-elevation back to tier 1 restores full capability; password-vs-phrase policy split (password strength is `PasswordPolicy`, phrase strength is `PassphrasePolicy` — they cannot bleed); `@noy-db/on-threat` lockout integration; username-binding regression (slot id `password:<userId>` prevents cross-user replay). Uses `@vitest-environment node` to dodge happy-dom's partial `subtle.exportKey` polyfill.
- **Showcase 72 — `on-webauthn` Playwright virtual authenticator** ([#77](https://github.com/vLannaAi/noy-db/issues/77)) — gated behind `NOYDB_SHOWCASE_WEBAUTHN_VIRTUAL=1` + one-shot `pnpm exec playwright install chromium`. Drives a real Chromium CDP virtual authenticator with PRF support; covers register + assert + PRF determinism (same salt → same fragment) + salt sensitivity (different salt → different fragment) + cross-device rejection (different credential id → assert fails).

### Known follow-ups (pre.12 milestone)

- **[#130](https://github.com/vLannaAi/noy-db/issues/130) — bundle-size regression (~30–48% gz)** introduced by the guards `index.ts` re-export. Under investigation; likely a subpath-barrel-only fix once we trace the exact transitive pull.
- **[#131](https://github.com/vLannaAi/noy-db/issues/131) — `GuardStrategyHandle<any>` type variance refactor** (backlog) — the registry currently widens to `any` at the dispatch boundary; can tighten with a discriminated-union handle once the public surface settles.
- **[#132](https://github.com/vLannaAi/noy-db/issues/132) — `withDerivation` pre-hashed register** — make the factory hash the strategy at construction time so `register()` becomes sync. Plugs the `Noydb.vault()` fallback gap where async-register currently forces a single-tick boundary at vault open.
- **[#133](https://github.com/vLannaAi/noy-db/issues/133) — strict-mode multi-output orphan window** — if a strict-mode derivation produces N outputs and output K throws shape validation, outputs 0..K-1 are already written. Fix is a two-pass write (validate all → commit all) but needs design for the cycle-aware case.

### Issues closed

#77, #78, #123, #124, #125, #126, #127, #128, #129

## 0.1.0-pre.10

### Audit-and-cleanup batch

A 2026-05-09 deep-review of the pre.9 surface (security + API consistency) filed 15 issues; iterative code review of the resulting fixes filed 4 more; one in-flight symmetry close. **20 PRs land in this release**, addressing 18 issues.

#### Security (P0)

- **STRICT_POLICY enroll-user / revoke-user gates are no longer dead-coded** ([#79](https://github.com/vLannaAi/noy-db/issues/79)) — `db.grant` and `db.revoke` now invoke `checkGate('enroll-user', factors)` and `checkGate('revoke-user', factors)` on top of the legacy `checkPolicyOperation`. Adds optional `factors?: FactorProofBundle` parameter to both methods. **Behavior change for STRICT_POLICY consumers**: grants and revokes without a factor proof now correctly throw `PolicyDeniedError` (the documented contract). PERSONAL_POLICY (default) is unchanged — its gates are `minTier: 1` with no factor requirement.

- **`db.changeSecret` validates passphrase strength by default** ([#80](https://github.com/vLannaAi/noy-db/issues/80)) — `assertStrongPassphrase` fires unconditionally unless `allowWeakPassphrase: true` is passed. Pre-fix, `changeSecret` was opt-in (`validate: true`) and the public `db.changeSecret` never opted in — bypassable from the consumer surface even after pre.5 #7 shipped phrase strength validation. **Breaking change**: existing consumers passing weak passphrases through `db.changeSecret` will throw `WeakPassphraseError`. Pass `{ allowWeakPassphrase: true }` to preserve old behavior; for fresh code, use `db.rotatePassphrase` which has the same validation contract end-to-end. The `db.changeSecret` signature gains an optional options argument: `changeSecret(vault, newPassphrase, options?: PassphrasePolicy & { allowWeakPassphrase? })`.

- **`grant()` rejects when caller's kek is null** ([#81](https://github.com/vLannaAi/noy-db/issues/81)) — closes the tier-2 capability matrix violation. Pre-fix, `grant()` iterated `callerKeyring.deks` and wrapped under the new user's `newKek` without ever reading `callerKeyring.kek`, so a tier-2 wrap-DEKs session (`@noy-db/on-password`) or tier-3 PIN-resume session (`@noy-db/on-pin`) could create new user keyrings. The documented contract (per `auth-landscape.md`) is that those tiers cannot perform privileged admin operations. Now mirrors `persistKeyring`'s null-`kek` guard at the head of `grant()`. Same fix applied to `buildRecipientKeyringFile` ([#112](https://github.com/vLannaAi/noy-db/issues/112), bundle-recipient mint) — adjacent site flagged by code review of the original fix.

- **`onInvalidKey: 'reset'` no longer destroys valid keyrings on partial corruption** ([#82](https://github.com/vLannaAi/noy-db/issues/82)) — the audit's highest-impact P0 (silent data loss). Pre-fix, `loadKeyring` walked the wrapped-DEK set in a bare `for...of`; the first corrupted byte killed the load with `InvalidKeyError`, and `onInvalidKey: 'reset'` (#6, pre.7) destroyed the keyring even when the KEK was correct. Now each DEK unwraps independently — mixed success ⇒ corruption (new `KeyringCorruptError`, reset does NOT fire); all-fail ⇒ wrong key (reset fires as documented). New `KeyringCorruptError` class carries `failedCollections: readonly string[]` and `intactCount: number` for targeted recovery UI. Exported from `@noy-db/hub` for `instanceof` checks. `listAccessibleVaults` updated to skip `KeyringCorruptError` like the other expected-failure modes (single corrupt vault no longer poisons the enumeration).

- **Passphrase canary closes the single-DEK + all-DEKs-corrupt ambiguity from #82** ([#113](https://github.com/vLannaAi/noy-db/issues/113)) — additive `KeyringFile.canary?: string` field. The canary is a fixed 256-bit AES-GCM key wrapped under the keyring's KEK with AES-KW. AES-KW is deterministic, so each write site mints fresh on persist without round-tripping a `canary` field through `UnlockedKeyring`. `loadKeyring` verifies the canary first; combined with each-DEK try/catch, this distinguishes wrong-passphrase from corruption even when ALL DEKs (including a single-DEK keyring's sole DEK) are corrupted. Pre-#113 keyrings without the field load via the legacy multi-DEK heuristic from #99 — backward compatible, no migration required.

#### Atomicity / contract holes (P1)

- **`rotatePassphrase` slot ceremony validates `wrapKind`** ([#83](https://github.com/vLannaAi/noy-db/issues/83)) — extends pre.8 #29's anti-slot-swap guard with a third equality check on `wrapKind` alongside `id` and `method`. Closes the hole where a buggy or hostile ceremony could change the slot's session-tier contract under cover of rotation: `'kek' → 'deks'` downgrade silently produces `kek: null` at unlock; `'deks' → 'kek'` upgrade bricks the slot via an AES-KW failure.

- **`recoverPassphrase` burns the paper recovery code BEFORE rewriting the keyring** ([#84](https://github.com/vLannaAi/noy-db/issues/84)) — atomicity reordering. Pre-fix, a store error after the keyring write left the user on the new passphrase but the consumed paper code remained valid (anyone with the same paper sheet could reuse it — security regression). Post-fix, the failure mode flips from security to usability: code burned + keyring not rewritten ⇒ user keeps old passphrase, loses one code (recoverable via admin / another code).

- **`UpdateUserOptions.displayName` accepts `null` to clear the field** ([#85](https://github.com/vLannaAi/noy-db/issues/85)) — aligns `db.updateUser` with the `null`-as-clear convention pre.9 #57 shipped for `UserApi.updateMe`. Type widens from `string | undefined` to `string | null | undefined`. `null` clears (stored as the empty string; UI consumers typically render the empty case by falling back to the user id). `permissions` stays full-replacement at the map level (documented invariant).

- **`RecoverPassphraseInput.recoveryProof` TS-narrowed to `'paper'`** ([#86](https://github.com/vLannaAi/noy-db/issues/86)) — matches `db.enrollRecovery`'s TS-narrow discipline. Pre-fix, the type accepted a 4-variant union (`paper | shamir | multi-channel | admin-mediated`) and three of the four threw `RecoveryProfileNotImplementedError` at runtime. The runtime guard remains — `as unknown as RecoveryProof` bypasses the type but still hits the error. **Breaking-but-narrowing**: a consumer with `recoveryProof` typed as the wide union (e.g. ferrying through helper code) will get a TS error after this lands.

#### DX / surface coherence (P2)

- **`docs/services/plaintext-bypass.md` invariant catalog** ([#87](https://github.com/vLannaAi/noy-db/issues/87)) — every collection that stores JSON in cleartext (`_keyring/<userId>`, `_meta/policy`, `_meta/recovery-paper`, `_meta/handle`, `_meta/public-envelope`, `_meta/invite-audit-<id>`, `_meta/sync-credentials`, ledger, consent, blob index) listed with rationale, plus a threat-model surface ("what an attacker with store-only access can learn"), plus an explicit checklist for adding or removing a bypass.

- **`db.getKeyring()` returns a defensive copy** ([#88](https://github.com/vLannaAi/noy-db/issues/88), [#114](https://github.com/vLannaAi/noy-db/issues/114)) — pre-fix, the returned `UnlockedKeyring`'s `deks` Map (typed `readonly`, but the Map itself isn't) was the live cached reference. A consumer calling `.deks.set()` corrupted the hub's internal state. Now returns a defensive shallow copy with fresh `Map`, fresh `authenticators` array, and per-element clones of `meta`. Hub-internal callers use a new `private getKeyringInternal` that returns the live ref so mutations from `ensureCollectionDEK` still land on the cache. CryptoKey handles inside `deks` stay shared (opaque references; encrypt/decrypt opaque). 14 internal call sites switched.

- **`FactorProofBundle` unifies the gate-method param shape** ([#89](https://github.com/vLannaAi/noy-db/issues/89)) — same shape `{ factors?, sharedDevice? }` was inlined at 12 sites with the parameter name alternating `factors` / `presented`. Now exported as a named type from `@noy-db/hub` (re-exported from the `policy` subpath); param name converges to `factors` everywhere.

- **Subpath barrels (`team/`, `i18n/`, `query/`, `session/`, `bundle/`, `store/`) populated** ([#90](https://github.com/vLannaAi/noy-db/issues/90)) — pre-fix, `@noy-db/hub/team` exported only `UnlockedKeyring` + sync helpers; the rest of the team API (rotate/recover, authenticator family, paper recovery primitives, magic-link grant, peer-recover, listUsers) was reachable only through the root barrel. Per-domain errors (`SessionExpiredError`, `JoinTooLargeError`, `BundleIntegrityError`, `StoreCapabilityError`, the i18n trio) couldn't be `instanceof`-checked from a subpath import. All subpaths now own their domain's full export set.

- **`KeyringAuthenticator` variant types re-exported from index.ts** ([#91](https://github.com/vLannaAi/noy-db/issues/91)) — `KeyringAuthenticatorWrappingKEK`, `KeyringAuthenticatorWrappingDEKs`, `EnrollAuthenticatorWrappingKEKOptions`, `EnrollAuthenticatorWrappingDEKsOptions`. `@noy-db/on-*` package authors writing variant-specific helpers can now name the type directly instead of reconstructing via `Extract<KeyringAuthenticator, { wrapKind: 'deks' }>`.

- **Adapter/Compartment naming residue cleaned up** ([#92](https://github.com/vLannaAi/noy-db/issues/92)) — user-visible strings (`session/dev-unlock.ts`, `collection.ts`), JSDoc in `types.ts`, and three sed-truncation artefacts (`team/index.ts`, `index.ts`, `errors.ts`). The internal `syncAdapter` field name on Collection / Vault / PresenceHandle is intentionally NOT renamed in this release — internal-only but touches multiple constructors and their tests.

- **Leftover `null as unknown as CryptoKey` casts in showcases** ([#93](https://github.com/vLannaAi/noy-db/issues/93)) — pre.8 #41 tightened `UnlockedKeyring.kek` to `CryptoKey | null`. The hub source was correctly migrated; three showcase fixtures (`23-on-webauthn`, `24-on-oidc`, `30-on-pin`) still carried casts. Replaced with literal `null`.

#### Documentation

- **`docs/services/auth-landscape.md` § Package boundaries** ([#43](https://github.com/vLannaAi/noy-db/issues/43)) — names the layering between `@noy-db/hub` (cryptosystem) and the `@noy-db/on-*` packages (user-facing input format) explicitly. Closes #43 as wontfix-by-design — folding `on-recovery` into a `@noy-db/hub/recovery-codes` subpath would anchor Base32 as the canonical format and break consumer swap-ability for no real bundle saving.

#### Issues closed

#43 (wontfix-by-design), #79, #80, #81, #82, #83, #84, #85, #86, #87, #88, #89, #90, #91, #92, #93, #112, #113, #114

## 0.1.0-pre.9

### Consumer-iteration cycle on pre.8 APIs

Closes the 5-issue follow-up batch surfaced after Niwat (first production consumer) shipped pre.8 to production. No new subsystems; surgical extensions to APIs that landed in pre.8.

#### New public APIs

- **`db.updateUser(vault, options, factors?)`** ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — post-grant identity mutation for `role`, `displayName`, and `permissions`. Pure plaintext-header rewrite — no DEK rewrap, no KEK required, no authenticator slots touched. Tier-2 enrollments and recovery codes survive. New `update-user` policy gate (PERSONAL: `minTier: 1`; STRICT: `minTier: 1, factors: ['totp','email-otp']` — admin-shaped, mirrors `enroll-user`/`revoke-user` rather than recovery). Two-sided role-elevation guard mirrors `db.grant`'s hierarchy: BOTH old and new role must satisfy `canUpdateRole(callerRole, _)`, blocking admin self-promote, admin promote-to-owner, admin demote-from-owner, and non-admin self-edit. `permissions` is full-replacement at the map level (consumers wanting partial merge construct `{ ...current, ... }`); top-level fields are partial-merge.

- **`db.updateAuthenticator(vault, slotId, options, factors?)`** ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — meta-only mutation on an existing tier-2 authenticator slot (slot rename, label change). The slot's `id`, `method`, and wrap material (`wrapped_kek` / `wrapped_deks` + `iv`) are immutable through this entry point — anti-slot-swap is **structural**: `UpdateAuthenticatorOptions` only carries `meta`, so the wrap material is unreachable regardless of the gate's settings. New `update-authenticator` policy gate (same shape as enroll/remove). `meta` patch follows #57's null-as-delete semantics at the top level.

- **`UserApi.updateMe<T>(patch)` accepts `null` to clear fields** ([#57](https://github.com/vLannaAi/noy-db/issues/57)) — `null` in the patch deletes the targeted key; `undefined` continues to skip (preserves the pre-feature merge behavior). Matches lodash `_.merge` and Firestore `FieldValue.delete()` semantics. New `DeepPartialOrNull<T>` type exported alongside the existing `DeepPartial<T>` (kept for backward compat); `updateMe<T>`'s patch parameter loosened to `DeepPartialOrNull<T>`. Bug fix found in flight: nested `null` patches against missing source keys now resolve consistently (recurse through synthetic `{}` source) — pre-fix, `{ app: { signature: null } }` against missing `app` produced `{ app: { signature: null } }` instead of `{ app: {} }`.

#### New exported types

- **`UpdateUserOptions`** ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — payload for `db.updateUser`.
- **`UpdateAuthenticatorOptions`** ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — payload for `db.updateAuthenticator`.
- **`DeepPartialOrNull<T>`** ([#57](https://github.com/vLannaAi/noy-db/issues/57)) — recursive partial with `| null` at every level.
- **`SlotRewrapContext`** + **`SlotRewrapCeremony`** ([#56](https://github.com/vLannaAi/noy-db/issues/56)) — previously package-internal, now public so `@noy-db/on-webauthn` (and future on-\* packages) can type their `slotCeremonies` helpers without re-declaring the shapes.

#### Policy DSL extensions

- **`update-user`** built-in gate ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — PERSONAL: `{ minTier: 1 }`; STRICT: `{ minTier: 1, factors: [{ anyOf: ['totp', 'email-otp'] }] }`.
- **`update-authenticator`** built-in gate ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — symmetric with `enroll-authenticator` / `remove-authenticator`. STRICT requires TOTP/email-OTP because a malicious slot rename on a shared workstation can mislead the user about which device a slot corresponds to.

### Issues closed

#54, #55, #56 (hub-side type export), #57

## 0.1.0-pre.8

### Authentication surface — major auth-review batch

Closes the 12-issue auth-review filed at the start of this milestone. Driven by feedback from the first production consumer (Niwat); the pre.8 surface is what they need to drop ~250 LOC of vendored workarounds.

#### New public APIs

- **`db.getKeyring(vault)`** ([#28](https://github.com/vLannaAi/noy-db/issues/28)) — public accessor for the live `UnlockedKeyring`. Required by `@noy-db/on-*` ceremonies that need the DEK set (paper-recovery mint, tier-3 PIN enrol, custom on-\* primitives). Previously private; consumers reached in via `(db as unknown as ...).getKeyring`.

- **`db.recoverUser(vault, options, factors?)`** ([#33](https://github.com/vLannaAi/noy-db/issues/33), [#34](https://github.com/vLannaAi/noy-db/issues/34)) — atomic peer-recovery primitive. Single `store.put` rewraps a target user's keyring under a fresh temp passphrase. Owner→owner natively allowed (closes #33's hard block on the two-co-owner case); gated by new `peer-recover-user` policy gate (`STRICT_POLICY` requires recovery / TOTP / email-OTP / roaming WebAuthn factor proof). No key rotation, identity preserved, tier-2 slots dropped. Closes the partial-failure window of the previous `revoke + grant` compose-from-primitives pattern.

- **`db.recoverPassphrase` auto-rotates remaining recovery codes** ([#36](https://github.com/vLannaAi/noy-db/issues/36)) — defaults to `rotateRemainingCodes: true`. After a successful paper-recovery, the matched code is burned AND the remaining N-1 entries are replaced with N-1 freshly-minted ones. Returns `{ newCodes: readonly string[] }` for the UI to show once. Optional `codeGenerator` callback overrides the default ULID format; `newCodeCount` controls the mint count.

- **`db.rotatePassphrase` preserves tier-2 slots via per-slot ceremonies** ([#29](https://github.com/vLannaAi/noy-db/issues/29)) — opt-in `slotCeremonies?: { [slotId]: SlotRewrapCeremony }`. Each ceremony receives `{ newKek, newDeks, oldSlot }` and returns `EnrollAuthenticatorOptions` with the same `id` + `method` (anti-slot-swap guard). Slots without a ceremony are dropped (pre-pre.8 behavior preserved as default). `enrolled_at` carries through (rotation is rewrapping, not re-enrollment). Closes the "yearly rotation wipes my biometric" UX cliff.

- **Public `mintPaperRecoveryEntry` / `unwrapDeksFromPaperEntry`** ([#39](https://github.com/vLannaAi/noy-db/issues/39)) — native paper-recovery enrollment path. Consumers were inlining ~70 LOC; `db.enrollRecovery` docstring fixed to point here instead of the broken `@noy-db/on-recovery@<=pre.7` example.

- **`mintWrappedDeksBlob` / `unwrapDeksFromBlob` / `WrappedDeksBlob` interface** ([#44](https://github.com/vLannaAi/noy-db/issues/44)) — the canonical wrap-DEKs primitive used by tier-0 (paper recovery) and tier-2 wrap-DEKs (password). `mintPaperRecoveryEntry` and `enrollPasswordAuthenticator` both delegate to this single helper. Tier-3 (`@noy-db/on-pin`) intentionally uses a parallel implementation at 100k PBKDF2 iterations (vs 600k here) because the PIN protection window is short — wire formats are deliberately incompatible.

#### Breaking type changes (pre-1.0; runtime behavior unchanged)

- **`KeyringAuthenticator` is now a discriminated union** ([#26](https://github.com/vLannaAi/noy-db/issues/26)) — `wrapKind: 'kek' | 'deks'` discriminator. WebAuthn / OIDC slots stay wrap-KEK; password slots are wrap-DEKs. Backward-compat: pre-pre.8 slots without `wrapKind` are treated as wrap-KEK at unlock time.

- **`UnlockedKeyring.kek` tightened to `CryptoKey | null`** ([#41](https://github.com/vLannaAi/noy-db/issues/41)) — the runtime always allowed null (tier-3 PIN resume, wrap-DEKs unlock, session restore, dev-unlock); the type now matches reality. Three call sites (`persistKeyring`, `vault.issueDelegation`, delegation-token unwrap) added explicit null-throws with a "re-authenticate at tier 1 first" message. Consumers reading `keyring.kek` directly should add a null-check.

#### Policy DSL extensions

- **`FactorKind` extended** ([#30](https://github.com/vLannaAi/noy-db/issues/30)) — adds `webauthn-platform` (Touch ID / Face ID / Hello), `password` (`@noy-db/on-password` tier-2), `pin` (`@noy-db/on-pin` tier-3). PERSONAL_POLICY rotate-passphrase gate now accepts ALL kinds; STRICT_POLICY peer-recover-user accepts off-device kinds only.

- **`PassphrasePolicy` escape hatches** ([#31](https://github.com/vLannaAi/noy-db/issues/31)) — `pattern?: RegExp` overrides the default lowercase-letters-and-spaces character class; `customValidator?: (phrase) => PassphraseValidationResult` replaces the entire decision tree. Unblocks Thai/EN-mixed phrases (`/^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u`), digit-rich phrases, BIP-39-style domain-specific formats.

#### Documentation + housekeeping

- **`docs/services/auth-landscape.md`** — reference map of every authentication, unlock, and sealing-key primitive commonly adopted in 2026, scored on dimensions that matter for a zero-knowledge offline-first vault. 247 lines covering 12 dimensional sections plus coverage assessment, gaps table, decision rules, and Q&A appendix.

- **on-oidc README + auth-landscape §6 polish** ([#37](https://github.com/vLannaAi/noy-db/issues/37)) — reframes "self-host the key-connector server" from docstring footnote to top-level ⚠️ section. Closes #37 as wontfix: noy-db is offline-first by philosophy and intentionally does not ship server infrastructure for OIDC unlock; consumers without server infrastructure should use `@noy-db/on-webauthn` (platform passkey) instead.

- **Perf-bench DoD test stabilized** — added `{ retry: 2 }` and renamed from "5×" to "materially faster" (assertion is `> 2`). Handles transient parallel-CI noise without lowering the signal-to-noise ratio.

### Issues closed

#26, #28, #29, #30, #31, #33, #34, #36, #37, #38, #39, #41, #44

### Issues filed as follow-ups

- [#43](https://github.com/vLannaAi/noy-db/issues/43) — fold `@noy-db/on-recovery` into `@noy-db/hub/recovery-codes` subpath (deferred, breaking change)
- Earlier follow-ups (#14 managed-passphrase mode, #15 per-keyring policy override) remain in the post-1.0 backlog.

## 0.1.0-pre.7

### Patch Changes

- fix(hub): onInvalidKey: 'reset' — recover a stale keyring when the data store is partially cleared (#6)

  When the IndexedDB data records are cleared via DevTools (or the user's browser evicts storage) while the `_keyring` row survives, and the user's credentials have since changed (e.g. a WebAuthn PRF credential was rotated or synced to a new device), `openVault` now offers an opt-in recovery path instead of throwing `InvalidKeyError`.

  Set `onInvalidKey: 'reset'` in `createNoydb` options to delete the stale keyring and re-initialize the vault from scratch with the current credentials. Default is `'error'` (unchanged — wrong credentials still throw).

## 0.1.0-pre.6

### Features

- **Per-principal user envelope (`vault.user.*`)** ([#18](https://github.com/vLannaAi/noy-db/issues/18), [#19](https://github.com/vLannaAi/noy-db/issues/19), [#20](https://github.com/vLannaAi/noy-db/issues/20), [#22](https://github.com/vLannaAi/noy-db/issues/22), [#23](https://github.com/vLannaAi/noy-db/issues/23), [#24](https://github.com/vLannaAi/noy-db/issues/24), [#25](https://github.com/vLannaAi/noy-db/issues/25)) — every keyring in a vault now gets its own `_users/<keyringId>` envelope, encrypted under a vault-shared `_users` DEK. Hub owns the plumbing (storage, sync, history, lifecycle, encryption, policy gates); apps own the schema. Three method families on `vault.user.*`:

  - **Write-self** — `me() / updateMe(patch) / setMe(payload)`. Always target the writer's own keyringId; the **own-only write rule is structural** (no API method exists to write someone else's envelope). Gated by `edit-own-profile` (default `minTier: 3`).
  - **Read-anyone** — `get(keyringId) / list()`. Gated by `view-team-profiles` (default `minTier: 2`); `enabled: false` is the privacy-strict opt-out (`list()` returns only self).
  - **Reactive** — `subscribe(keyringId, cb) / live(keyringId)`. In-process event emission on local writes.

  New `db.grant({ initialProfile: T })` admin pre-fill at invite time (bootstrap-only — once the user activates, the own-only rule prevents further admin edits). New `listUsersWithEnvelopes()` joined enumeration for admin UIs. `_users` DEK is eager-provisioned at owner creation; cascade-revoke deletes envelopes alongside keyrings; tier-1 rotation re-encrypts envelopes via the existing rotation path. The `UserProfileProvider` interface (managed-mode IdP integration) is documented but not exported in v1; lands post-1.0 alongside managed-passphrase mode (#14).

  See `docs/services/user-envelope.md`, `docs/recipes/user-preferences.md`, `showcases/src/70-user-envelope.showcase.test.ts`, and `showcases/src/recipe-user-preferences.recipe.test.ts`.

- **`db.enrollWebAuthn(vault, ceremony, presented?)`** ([#16](https://github.com/vLannaAi/noy-db/issues/16)) — native WebAuthn enrollment using the **real** internal keyring. Unblocks `vLannaAi/niwat#31`. The ceremony callback receives the live `UnlockedKeyring` so the `wrapped_kek` references the live KEK (not the synthetic-keyring workaround that broke unlock). Hub does not import `@noy-db/on-webauthn` (would invert dep graph); consumers wire the on-webauthn `enrollWebAuthn` function in via the ceremony callback. Companion `db.listWebAuthnSlots(vault)` returns webauthn-method slots only.

- **`db.lockVault(vault)`** ([#17](https://github.com/vLannaAi/noy-db/issues/17)) — soft lock that scrubs `keyringCache`, `vaultCache`, `activeTier`, `syncEngines`, `policyEnforcers` for the vault, but **preserves `quickUnlock`** (PIN resume after lock-screen UX) and `policyCache` (on-disk policy survives lock). Idempotent; the `Noydb` instance remains usable. Unblocks `vLannaAi/niwat#33`.

- **New built-in policy gates** — `edit-own-profile` and `view-team-profiles` registered in `PERSONAL_POLICY` and `STRICT_POLICY`. Apps can tighten (e.g. require TOTP for profile edits) but cannot relax the own-only write rule (structural, not policy-controlled).

### No breaking changes

All additions are additive. Pre-existing vaults work unchanged — the `_users` collection is reserved on grant; envelopes start empty until first `updateMe()`. Pre-existing vaults predating this feature have a documented one-time DEK-rotate workflow when adopting `vault.user.*` for multi-principal reads (see "Edge cases & limits" in `docs/services/user-envelope.md`).

## 0.1.0-pre.4

### Features

- **`NoydbOptions.getKeyring` callback** ([#5](https://github.com/vLannaAi/noy-db/issues/5)) — added an optional `getKeyring?: (vault: string) => Promise<UnlockedKeyring>` callback to `NoydbOptions`. Lets biometric (WebAuthn), OIDC split-key, Shamir, and any other unlock path that produces an `UnlockedKeyring` plug into `createNoydb` directly, without a passphrase bridge. `secret` and `getKeyring` are mutually exclusive; the callback is invoked lazily on the first vault open and the keyring is cached per `(instance, vault)`. Errors propagate from `openVault(name)`. Full backward compatibility — passphrase consumers see no change.

## 0.1.0-pre.1 — Initial pre-release
