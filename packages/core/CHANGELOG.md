# @noy-db/core

## 0.9.0

### Minor Changes

- feat(v0.9): sync v2 — conflict policies, partial sync, transactions, CRDT, presence, @noy-db/yjs

  ### @noy-db/core

  - **#131 `conflictPolicy`** — per-collection conflict resolution: `'last-writer-wins'`, `'first-writer-wins'`, `'manual'`, or a custom merge function. Overrides the db-level `conflict` option.
  - **#132 CRDT mode** — `crdt: 'lww-map' | 'rga' | 'yjs'` on any collection. `collection.getRaw(id)` returns the full `CrdtState`. CRDT conflict resolver auto-merges at the envelope level without the app seeing it.
  - **#133 Partial sync** — `push(comp, { collections })`, `pull(comp, { collections, modifiedSince })`, `sync(comp, { push, pull })`. Adapter may add optional `listSince()` for server-side filtering.
  - **#134 Presence** — `collection.presence<P>()` returns a `PresenceHandle`. `update(payload)` encrypts with an HKDF-derived key (from the collection DEK) and publishes. `subscribe(cb)` delivers decrypted peer snapshots. Real-time via adapter pub/sub; storage-poll fallback for all other adapters.
  - **#135 Sync transactions** — `db.transaction(comp).put(col, id, rec).delete(col, id).commit()`. Two-phase: local writes then `pushFiltered()` for only the transaction records. Returns `{ status, pushed, conflicts }`.

  ### @noy-db/yjs (new package)

  - `yjsCollection(comp, name, { yFields })` — wraps a `crdt: 'yjs'` collection with Y.Doc-aware API
  - `getYDoc(id)` — decode stored base64 update into a Y.Doc with declared fields initialised
  - `putYDoc(id, doc)` — encode Y.Doc state and persist as encrypted envelope
  - `applyUpdate(id, bytes)` — merge a Yjs update into an existing record
  - `yText()`, `yMap()`, `yArray()` field descriptors

## 0.8.0

### Minor Changes

- 29c54c4: Add `dictKey` schema descriptor, `DictionaryHandle`, and `i18nText` schema type (v0.8 #81 #82)

  - `dictKey(name, keys?)` — descriptor for dictionary-backed enum fields, validated on `put()`
  - `DictionaryHandle` — CRUD + `rename()` with cascade-rewrite for `_dict_*` reserved collections
  - `i18nText({ languages, required, autoTranslate? })` — descriptor for multi-language prose fields
  - `validateI18nTextValue` / `resolveI18nText` / `applyI18nLocale` — validation + locale resolution helpers
  - New error classes: `ReservedCollectionNameError`, `DictKeyMissingError`, `DictKeyInUseError`, `MissingTranslationError`, `LocaleNotSpecifiedError`
  - `LocaleReadOptions` interface for `get(id, { locale, fallback? })` and `list({ locale, fallback? })`
  - Compartment gains `dictionary(name, opts?)`, `setLocale()`, `getLocale()`; collection options gain `i18nFields` and `dictKeyFields`

- 29c54c4: v0.8 i18n completion: plaintextTranslator hook (#83), exportStream dictionary snapshot (#84), query DSL dictKey integration (#85).

  - **plaintextTranslator (#83)**: Consumer-supplied async translation function for `i18nText` fields with `autoTranslate: true`. Runs before i18n validation in `put()`. In-process content-hash cache cleared on `close()`. Audit log via `db.translatorAuditLog()` with cache-hit flag. `TranslatorNotConfiguredError` when translator missing.
  - **exportStream dictionary snapshot (#84)**: `exportStream()` attaches a `dictionaries` field to chunks from collections with dictKey fields. Snapshot is captured atomically before the first yield — concurrent mutations do not affect it. `exportJSON()` embeds `_dictionaries` at top level; omits it when `resolveLabels` is set.
  - **Query DSL dictKey integration (#85)**: `query().join(field)` resolves dictKey fields as dict joins, attaching `{ key, ...labels }` under the given alias. `groupBy(field).aggregate(...).runAsync({ locale })` adds `<field>Label` to grouped result rows. Stable keys used for grouping regardless of locale. `DictionaryHandle` maintains a write-through sync cache for O(1) snapshot access inside the query executor.

## 0.7.0

### Minor Changes

- 2d38d62: **Session tokens (#109)** — unlock once with passphrase or biometric, get a
  serialisable `SessionToken` valid for N minutes. The DEK map is encrypted with
  a non-extractable, tab-scoped `AES-256-GCM` session key that lives only in the
  JS module store. Closing the tab destroys the key, revoking the session.

  New exports: `createSession`, `resolveSession`, `revokeSession`,
  `revokeAllSessions`, `isSessionAlive`, `activeSessionCount` and types
  `SessionToken`, `CreateSessionResult`, `CreateSessionOptions`.

  New errors: `SessionExpiredError`, `SessionNotFoundError`.

- 2d38d62: **`_sync_credentials` reserved collection (#110)** — encrypted per-adapter
  OAuth/sync token store. Like `_keyring`, this collection is reserved and
  ACL-gated: only `owner` and `admin` roles can read or write it. Adapters see
  only ciphertext; plaintext tokens never leave core.

  New exports: `putCredential`, `getCredential`, `deleteCredential`,
  `listCredentials`, `credentialStatus`, `SYNC_CREDENTIALS_COLLECTION` and type
  `SyncCredential`.

- 2d38d62: **Magic-link unlock (#113)** — one-shot viewer sessions for client portals.
  The server derives a viewer KEK via `HKDF-SHA256(serverSecret, SHA256(token),
"noydb-magic-link-v1:" + compartment)` and grants it a read-only keyring. The
  link holder calls `deriveMagicLinkKEK` with the same inputs to unlock the same
  viewer session — no passphrase, no biometric.

  Server-side: `createMagicLinkToken` + `deriveMagicLinkKEK` + `grant`.
  Client-side: `deriveMagicLinkKEK` + `buildMagicLinkKeyring`.

  New exports: `deriveMagicLinkKEK`, `createMagicLinkToken`, `isMagicLinkValid`,
  `buildMagicLinkKeyring`, `MAGIC_LINK_DEFAULT_TTL_MS` and types `MagicLinkToken`,
  `CreateMagicLinkOptions`.

- 2d38d62: **Session policies (#114)** — idle/absolute timeouts, sensitive-operation
  re-auth guards, and background-tab locking. Pass a `SessionPolicy` to
  `createNoydb` options; the `PolicyEnforcer` manages timers and fires the
  `onRevoke` callback automatically.

  New `NoydbOptions` field: `sessionPolicy?: SessionPolicy`.

  Policy features:

  - `idleTimeoutMs` / `absoluteTimeoutMs` — two independent timer axes.
  - `requireReAuthFor` — list of operations (`'export'`, `'grant'`, `'revoke'`,
    `'rotate'`, `'changeSecret'`) that throw `SessionPolicyError` unless the
    session was freshly unlocked.
  - `lockOnBackground` — fires `onRevoke` when `document.visibilityState`
    becomes `'hidden'`.

  New exports: `PolicyEnforcer`, `createEnforcer`, `validateSessionPolicy`.
  New types: `SessionPolicy`, `ReAuthOperation`.
  New error: `SessionPolicyError`.

- 2d38d62: **Dev-mode persistent unlock (#119)** — opt-in escape hatch for developer
  inner-loop friction. Hot-reload destroys the session; this module lets
  developers store the keyring payload in `sessionStorage` (default) or
  `localStorage` (`persistAcrossTabs: true`) so the compartment auto-unlocks
  on every page load during development.

  Guardrails enforced unconditionally (cannot be bypassed by the caller):

  1. Throws if `process.env.NODE_ENV === 'production'`.
  2. Throws if `window.location.hostname` is not `localhost` / `127.0.0.1` /
     `::1` / `*.local`.
  3. Requires `acknowledge: 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-SECURITY'`.
  4. Emits an unsuppressable `console.warn` with red styling on first enable.

  `loadDevUnlock`, `clearDevUnlock`, and `isDevUnlockActive` are safe to call
  in production (they return `null`/`false`/no-op without throwing).

  New exports: `enableDevUnlock`, `loadDevUnlock`, `clearDevUnlock`,
  `isDevUnlockActive` and type `DevUnlockOptions`.

## 0.6.0

### Minor Changes

- 755f151: feat(core): aggregation reducers + `.aggregate()` terminal + `.live()` reactive (#97)

  New reducer primitives on the query DSL — `count`, `sum`, `avg`,
  `min`, `max` — plus a `.aggregate()` near-terminal that reduces
  matching records through a named spec and returns a wrapper with
  two terminals of its own:

  ```ts
  // Static one-shot reduction
  const { total, n, meanAmount } = invoices
    .query()
    .where("status", "==", "open")
    .aggregate({
      total: sum("amount"),
      n: count(),
      meanAmount: avg("amount"),
    })
    .run();

  // Reactive primitive — re-runs on source mutations
  const live = invoices
    .query()
    .where("status", "==", "open")
    .aggregate({ total: sum("amount"), n: count() })
    .live();

  live.subscribe(() => renderDashboard(live.value));
  // ... later
  live.stop();
  ```

  **Return type inference:** the spec's shape flows through — a spec
  of `{ total: sum('amount'), n: count() }` produces a result of
  `{ total: number, n: number }`. `avg` / `min` / `max` return
  `number | null` to mark the empty-result case without poisoning
  downstream arithmetic with NaN.

  **Reducer protocol:** each factory produces a
  `{ init, step, remove?, finalize }` object with separate internal
  state (`S`) and user-visible result (`R`) type parameters. This
  is the shape that admits O(1) incremental maintenance for
  sum/count/avg in a future optimization without breaking the
  public API. v0.6 ships naive full re-run on source change;
  incremental delta maintenance is a planned follow-up.

  **`.live()` reactive primitive** — `LiveAggregation<R>`: plain
  object with `value` / `error` fields and a `subscribe(cb)`
  notification channel, frame-agnostic. If a re-run throws, the
  previous successful value is preserved and the error is stored in
  `live.error` so consumers can render an error state without losing
  the last-known-good result. Same error-isolation contract as
  `LiveQuery` (#74). `stop()` is idempotent; subscribe after stop is
  a no-op.

  **#87 constraint #2 (load-bearing seam):** every reducer factory
  accepts an optional `{ seed }` parameter that is plumbed through
  the protocol but unused by the v0.6 executor. When v0.10
  partition-aware aggregation lands, the seed will carry running
  state across partition boundaries without requiring an API break.
  Do not remove — that's the whole point of having it now.

  **Out of scope (separate issues):**

  - `.groupBy(field)` — #98
  - `scan().aggregate()` — #99
  - Incremental delta maintenance for live mode (v2 optimization)
  - Aggregations across joins
  - Per-row callback reducers (`.reduce(fn, init)`)
  - Index-backed aggregation planner
  - Multi-level groupBy

  Tests: 27 new cases covering every reducer factory, combined
  specs, empty-result-set null-on-empty semantics, the #87 seed seam,
  `reduceRecords` pure helper, live-mode initial value, insert /
  update / delete re-fires, min/max O(N) extremum-removal edge case,
  multi-subscriber notifications, individual unsubscribe, idempotent
  `stop()`, subscribe-after-stop no-op, and `.live()` over a
  subscribe-less static source.

  443/443 core tests passing.

- 92f2000: feat(core): Query DSL `.join()` — eager, single-FK, intra-compartment joins (#73)

  Chain `.join(field, { as })` on any `Query` built from `collection.query()`
  to resolve a `ref()`-declared foreign key into an attached right-side record
  under an alias:

  ```ts
  const rows = invoices
    .query()
    .where("status", "==", "open")
    .join<"client", Client>("clientId", { as: "client" })
    .toArray();
  // → [{ id, amount, client: { id, name, ... } }, ...]
  ```

  Two planner strategies, auto-selected:

  - **nested-loop** — right-side source exposes `lookupById` (the common
    path for Collection targets), O(1) per left row.
  - **hash** — materialize the right side into a `Map<id, record>` once,
    probe per left row. Fallback for custom `QuerySource` implementations
    without id-indexed access.

  Manual override for test purposes via `{ strategy: 'hash' | 'nested' }`.

  Hard row ceiling of 50,000 per side (override with `{ maxRows }`), throws
  `JoinTooLargeError` on the tripped side with both row counts. One-shot warning
  at 80% of the ceiling on the existing warn channel. Streaming joins over
  `scan()` that bypass this ceiling are tracked in #76.

  Ref-mode semantics on dangling refs:

  - `strict` → throws `DanglingReferenceError` with `field` / `target` / `refId`
  - `warn` → attaches `null` + one-shot warning per unique dangling pair
  - `cascade` → attaches `null` silently (cascade is a delete-time mode)

  Left-side records with `null`/`undefined` FK values are never dangling —
  they attach `null` regardless of mode, matching the write-time
  `enforceRefsOnPut` policy.

  Same-compartment only — cross-compartment correlation goes through
  `Noydb.queryAcross` (v0.5 #63), not `.join()`. This is an architectural
  invariant, not a limitation we plan to lift.

  **New public API:**

  - `Query.join<As, R>(field, opts)` — chain method on `Query<T>`
  - `JoinTooLargeError` — thrown on row-ceiling overflow
  - `DanglingReferenceError` — thrown on strict-mode dangling ref
  - `JoinLeg`, `JoinContext`, `JoinableSource`, `JoinStrategy` — types
  - `DEFAULT_JOIN_MAX_ROWS`, `applyJoins`, `resetJoinWarnings` — internals
    exported for custom planners and tests

  **v0.6 design-forward partition seams (#87 constraint #1):** every
  `JoinLeg` carries a `partitionScope` field that is always `'all'` in
  v0.6 and never read by the executor. v0.10 partition-aware joins will
  start populating it from `where()` predicates on the partition key
  without changing the planner's external shape — shipping the seam now
  means no API break later.

  **Known v0.6 limitations** (tracked separately):

  - `.join().live()` merged change-stream reactivity — #74
  - `.join().join()` multi-FK chaining — #75
  - Streaming join over `scan()` — #76
  - Sorting by joined fields — not in scope for v1; post-sort in userland

- 36dbdbc: feat(core): `.groupBy(field)` + `.groupBy().aggregate()` (#98)

  New `Query.groupBy(field)` operator that partitions matching records
  into buckets keyed by a field, then terminates with
  `.aggregate(spec)` to compute per-bucket reducers:

  ```ts
  const byClient = invoices
    .query()
    .where("status", "==", "open")
    .groupBy("clientId")
    .aggregate({ total: sum("amount"), n: count() })
    .run();
  // → [ { clientId: 'c1', total: 5250, n: 3 }, … ]
  ```

  Result rows carry the group key under the grouping field name plus
  every reducer output from the spec. Buckets are emitted in
  first-seen insertion order (JS `Map` preserves it natively);
  consumers who want a specific ordering should `.sort()` downstream.

  **Cardinality caps:**

  - One-shot warning at **10_000 distinct groups** (`GROUPBY_WARN_CARDINALITY`)
  - Hard `GroupCardinalityError` at **100_000 distinct groups** (`GROUPBY_MAX_CARDINALITY`)

  The hard cap is fixed in v0.6 — grouping on a high-uniqueness field
  like `id` or `createdAt` is almost always a query mistake rather
  than legitimate use, and a hard error is better than silent OOM.
  Consumers hitting the cap see an actionable message naming the
  field and observed cardinality with guidance to narrow the query
  with `.where()` first. A `{ maxGroups }` override can be added
  later without a break if a real consumer asks.

  **Null / undefined keys:** records with a missing group field get
  their own bucket, separate from records with an explicit `null`
  value. `Map`-based partitioning distinguishes the two — consumers
  who want them merged should coalesce upstream with `.filter()`.

  **Live mode:** `.groupBy().aggregate().live()` returns a
  `LiveAggregation<R[]>` that re-runs the full group-and-reduce
  pipeline on every source change. Reuses the same reactive primitive
  as `.aggregate().live()` (#97) via a new `buildLiveAggregation`
  helper exported from `aggregate.ts`. Same error-isolation and
  idempotent-stop contract. Per-bucket incremental maintenance is a
  future optimization — the reducer protocol's `remove()` hook
  admits it but v0.6 ships naive re-grouping for simplicity.

  **Joins skipped** in grouped pipelines — same rationale as
  `.count()` and `.aggregate()`. Joined fields in v0.6 are
  projection-only, so running a join inside a grouping pipeline would
  be wasteful and could trigger `DanglingReferenceError` in strict
  mode. Grouping by a joined field is explicitly out of scope.

  **New public surface:**

  - `Query.groupBy(field)` chain method
  - `GroupedQuery<T, F>`, `GroupedAggregation<R>` — wrapper classes
  - `groupAndReduce` — pure helper (reused by future `scan().groupBy()`)
  - `GroupCardinalityError` — structured error with `field`,
    `cardinality`, `maxGroups`
  - `GROUPBY_WARN_CARDINALITY`, `GROUPBY_MAX_CARDINALITY` — constants
  - `buildLiveAggregation` — shared live-primitive factory
  - `GroupedRow<F, R>` — result row type
  - `resetGroupByWarnings` — test-only warning dedup reset

  **Type-level stable-key narrowing (v0.8 #85 prep):** v0.6 types
  the group key as `unknown` at the result shape. When `dictKey`
  lands in v0.8, a `groupBy<DictField>()` overload will narrow the
  group key type to the stable dictionary key rather than the
  resolved locale label — preventing the silent bug where grouping
  by a localized label produces different buckets per reader. The
  overload layers on top without an API break.

  **Out of scope (separate issues):**

  - Multi-level groupBy (nested groupings)
  - `.having(predicate)` filtering on grouped results
  - Index-backed aggregation planner
  - Groupings across joins
  - `scan().groupBy().aggregate()` — gated on #99 streaming story
  - Per-bucket incremental delta maintenance for live mode (v2)

  Tests: 20 new cases covering basic bucketing, composition with
  `.where()`, multiple reducers per bucket, insertion-order
  emission, empty result sets, null/undefined key distinction, 10k
  warn threshold with dedup across runs, 100k hard cap with error
  details, the `groupAndReduce` pure helper, and live-mode
  insert/update/delete across bucket creation, mutation, and
  removal.

  463/463 core tests passing (443 from #97 + 20 new for #98).

- f968f83: feat(core): `Query.live()` — reactive primitive with merged join change-streams (#74)

  New terminal `.live()` on `Query<T>` returns a `LiveQuery<T>` — a
  framework-agnostic reactive primitive with `value` / `error` fields
  and a `subscribe(cb)` notification channel:

  ```ts
  const live = invoices
    .query()
    .where("status", "==", "open")
    .join<"client", Client>("clientId", { as: "client" })
    .live();

  console.log(live.value); // current rows with attached clients

  const stop = live.subscribe(() => {
    console.log("updated:", live.value);
  });

  // later...
  stop();
  live.stop();
  ```

  For non-joined queries, `.live()` is a convenience wrapper over the
  existing `.subscribe()` callback shape. For joined queries, the
  `LiveQuery` additionally subscribes to every join target's change
  stream — mutations on a right-side collection (e.g. updating a
  client referenced by an invoice) re-fire the live query and
  re-evaluate every dependent left row. Right-side targets are
  deduped by name, so a chain that joins the same target twice
  (e.g. `.join('billingClientId').join('shippingClientId')`, both →
  `clients`) only subscribes once.

  **Ref-mode behavior on right-side disappearance** — matches the
  eager `.toArray()` contract from #73:

  - `strict` → re-run throws `DanglingReferenceError`. The LiveQuery
    catches the throw, stores it in `live.error`, notifies listeners.
    The throw does NOT propagate out of the source's change handler
    (which would tear down the upstream emitter). Consumers check
    `live.error` after each notification and render an error state.
  - `warn` → joined value flips to `null`; the existing one-shot
    warn dedup keeps repeated re-runs from spamming the console.
  - `cascade` → no special handling; the v0.4 cascade-delete
    mechanism propagates the right-side delete into the left
    collection on the next tick, and the live query naturally
    re-fires with the orphaned left rows gone.

  **Error preservation** — when a re-run throws, `live.value` keeps
  the previous successful snapshot rather than flashing to an empty
  list. UIs typically want to show "last known good + error message"
  rather than "blank screen + error message".

  **New public surface:**

  - `Query.live(): LiveQuery<T>` — terminal method
  - `LiveQuery<T>` interface with `value`, `error`, `subscribe(cb)`,
    `stop()`
  - `LiveUpstream` interface for the upstream subscribe contract
  - `buildLiveQuery(recompute, upstreams)` — exported builder for
    custom planners and tests
  - `JoinableSource.subscribe?` — optional method on the join-source
    interface, populated by `Collection.querySourceForJoin()`

  **v0.6 limitations** (tracked separately):

  - No granular delta updates — the whole query re-runs on every
    upstream change. v2 optimization once the API is stable.
  - No microtask batching — bursty changes produce one re-run per
    change. v2 enhancement.
  - No re-planning under live mutations — the planner picks once at
    subscription time and reuses the same plan.
  - Streaming live joins → tracked under #76.

  Tests: 12 new cases covering initial value, idempotent stop(),
  left-side insert / update / delete re-fire, right-side insert /
  update / delete propagation, cascade-mode right-side delete,
  multi-subscriber notifications, non-joined `.live()` shape, and
  the error-preservation invariant. 455/455 core tests passing.

  Strict-mode dangling at read time is verified by the eager-path
  test in `query-join.test.ts` for the same recompute path the live
  mode uses; the live error path wraps that recompute in try/catch
  and the error-preservation test exercises the same machinery with
  a synthetic throw.

- bd21ad7: feat(core): `.join().join()` multi-FK chaining (#75)

  Multiple `.join()` calls can be chained on the same query, each
  resolving an independent FK declared via `ref()`:

  ```ts
  const rows = invoices
    .query()
    .where("status", "==", "open")
    .join<"client", Client>("clientId", { as: "client" })
    .join<"category", Category>("categoryId", { as: "category" })
    .toArray();
  // → [{ id, amount, client: { ... }, category: { ... } | null }, ...]
  ```

  Each leg picks its own planner strategy independently — a query can
  mix nested-loop and explicit hash join in the same chain. Each leg
  also enforces its own ref-mode behavior independently: a strict join
  on `clientId` and a warn join on `categoryId` in the same query both
  fire correctly without one mode bleeding into the other.

  Per-leg `maxRows` is now enforced against the current left-row count
  on every leg (not just the first), so
  `.join('a', { maxRows: 100_000 }).join('b', { maxRows: 50 })`
  correctly throws on the second leg if the left set exceeds 50. Because
  v0.6 joins are equi-joins on the target's primary key (one-to-one or
  one-to-null), the left row count stays constant across legs — there's
  no cartesian blowup.

  Joins execute in declaration order. Reordering by the planner is out
  of scope for v1.

  **Out of scope (separate issues):**

  - **Self-joins** — same source/target collection. Needs cycle
    detection and alias-collision handling; tracked separately if a
    consumer asks.
  - **Live mode** for chained joins — depends on #74 landing first.
  - **Streaming chained joins** — separate issue under #76.

  Tests: 8 new cases covering 2-join chains across multiple rows with
  mixed FK populations, 3-join shapes, mixed planner strategies in the
  same query, mixed ref modes (strict + warn) firing independently, the
  per-leg left-side ceiling check, and `toPlan()` surfacing every leg
  with its `partitionScope: 'all'` seam (#87 constraint #1).

- d90098a: feat(core+file): `.noydb` container format — magic header + opaque handle + compressed body (#100)

  New `.noydb` binary container format that wraps
  `compartment.dump()` in a thin minimum-disclosure wrapper, plus
  file-adapter helpers for path-based round-trips.

  ```ts
  import { writeNoydbBundle, readNoydbBundle } from "@noy-db/core";
  import { saveBundle, loadBundle } from "@noy-db/file";

  // Core primitives
  const bytes = await writeNoydbBundle(company);
  const { header, dumpJson } = await readNoydbBundle(bytes);

  // File adapter helpers
  const handle = await company.getBundleHandle();
  await saveBundle(`./bundles/${handle}.noydb`, company);
  const result = await loadBundle(`./bundles/${handle}.noydb`);
  ```

  ## Why a binary container at all?

  `compartment.dump()` already produces a JSON string with encrypted
  records inside. Wrapping it again seems redundant — but the wrap
  is what makes the file safe to drop into cloud storage (Drive,
  Dropbox, iCloud) without leaking the compartment name and exporter
  identity through the cloud's metadata API. The minimum-disclosure
  header is the only thing visible without downloading and
  decompressing the body. The dump JSON inside still contains the
  original metadata, but that's only readable by someone who already
  has the file bytes — the same person who could read the encrypted
  records with the right passphrase.

  ## Format byte layout

  ```
  +--------+--------+--------+--------+
  |  N     |  D     |  B     |  1     |  Magic 'NDB1' (4 bytes)
  +--------+--------+--------+--------+
  | flags  | compr  |  header_length (uint32 BE)            |
  +--------+--------+--------+--------+--------+--------+--------+
  | header_length bytes of UTF-8 JSON header                       ...
  +--------+--------+
  | compressed body bytes                                            ...
  ```

  Total fixed prefix: **10 bytes**. Header JSON is variable length;
  body follows immediately after.

  ## Minimum-disclosure header

  Only **four** allowed keys, validated at parse time:

  ```json
  {
    "formatVersion": 1,
    "handle": "01HYABCDEFGHJKMNPQRSTVWXYZ",
    "bodyBytes": 41234567,
    "bodySha256": "abc123..."
  }
  ```

  **Forbidden** (every key produces a parse error):
  `compartment`, `_compartment`, `exporter`, `_exported_by`,
  `timestamp`, `_exported_at`, KDF params, salt fields, any key
  starting with `_`. The validator allowlist is closed —
  forward-compat extension keys require a format version bump.

  ## Compression

  - **Brotli** when the runtime supports `CompressionStream('br')`
    (Node 22+, Chrome 124+, Firefox 122+) — typically 30-50%
    smaller than gzip on JSON payloads
  - **gzip** fallback elsewhere — always available in Node 18+
  - **none** option for round-trip testing or piping into a
    separately compressed transport

  The algorithm is encoded in the format byte at offset 5, so
  readers handle either transparently. The writer feature-detects
  brotli at runtime and falls back automatically when the user
  passes `{ compression: 'auto' }` (the default). Explicit
  `{ compression: 'brotli' }` throws on unsupported runtimes.

  ## Stable opaque handles via ULID

  Every compartment gets a stable 26-character Crockford base32
  ULID via `compartment.getBundleHandle()`. Generated and persisted
  to a reserved `_meta/handle` envelope on first call, returned
  unchanged on subsequent calls. Survives process restarts (the
  envelope is on the adapter, not in memory).

  The handle is the only identifier in the bundle header — it's
  opaque, doesn't leak compartment names, and is the planned
  primary key for the v0.11 cloud bundle adapters (Drive, Dropbox,
  iCloud).

  The ULID timestamp prefix is observable, but it leaks no more
  than the file's own filesystem mtime would. For use cases that
  need timestamp-free handles, a v2 of the format could specify
  "random portion only" without a format break.

  ## Integrity verification

  The header carries `bodyBytes` and `bodySha256` over the
  **compressed** body bytes (not the decompressed dump). This lets
  `readNoydbBundleHeader()` verify integrity without decompressing
  — useful for fast cloud-side validation. Tampering with any byte
  of the body produces `BundleIntegrityError` on the read path.

  A length mismatch fires before the SHA check (cheaper, more
  actionable error message). Decompression failure after the
  integrity hash passes also surfaces as `BundleIntegrityError` —
  that's a producer bug (wrong algorithm byte written) but the
  end result for the consumer is the same: "the body cannot be
  turned back into a dump."

  ## File adapter helpers

  `@noy-db/file` adds two thin path-based wrappers:

  - `saveBundle(path, compartment, opts?)` — calls
    `writeNoydbBundle()`, ensures parent directories exist via
    recursive `mkdir`, writes the file via `fs.writeFile`
  - `loadBundle(path)` — reads the file via `fs.readFile`, calls
    `readNoydbBundle()`

  Neither wrapper takes a passphrase. Restoring a compartment from
  a bundle is a two-step operation:

  ```ts
  const { dumpJson } = await loadBundle(path);
  await compartment.load(dumpJson, passphrase);
  ```

  This split keeps the bundle module purely a format layer and
  lets the same code feed format inspectors that never decrypt
  anything.

  ## New public surface

  **`@noy-db/core`:**

  - `writeNoydbBundle(compartment, opts?)` — produces container bytes
  - `readNoydbBundle(bytes)` — full read with integrity verification
  - `readNoydbBundleHeader(bytes)` — header-only read, no decompression
  - `BundleIntegrityError` — structured error for tampering / length mismatch
  - `Compartment.getBundleHandle()` — stable ULID generator/getter
  - `generateULID()` / `isULID()` — exposed for testing and external use
  - `hasNoydbBundleMagic()` — fast file-type check
  - Constants: `NOYDB_BUNDLE_MAGIC`, `NOYDB_BUNDLE_PREFIX_BYTES`,
    `NOYDB_BUNDLE_FORMAT_VERSION`
  - Types: `NoydbBundleHeader`, `WriteNoydbBundleOptions`,
    `NoydbBundleReadResult`, `CompressionAlgo`
  - `resetBrotliSupportCache()` — test-only helper to reset feature
    detection

  **`@noy-db/file`:**

  - `saveBundle(path, compartment, opts?)` — write to disk
  - `loadBundle(path)` — read from disk

  ## Out of scope (tracked separately)

  - **Bundle adapter shape** (Drive, Dropbox, iCloud) — v0.11 #93
  - **CLI commands** `noydb inspect/open` — v0.10 #96
  - **Browser extension reader** — v0.10
  - **Multi-compartment bundles** — v2
  - **Streaming decompression** for mobile — v2
  - **ZIP-like selective extraction** — v2
  - **Encrypting the dump body itself** — the body is plaintext
    JSON containing encrypted records; encrypting the JSON wrapper
    would require a second key derivation and is a bigger design
    conversation than v0.6 can host

  ## Tests

  **`@noy-db/core`** (28 tests in `bundle.test.ts`):

  - ULID generator: shape, uniqueness across 1000 calls,
    Crockford alphabet exclusions (I/L/O/U), lexicographic time
    ordering across milliseconds
  - Header validator: minimal valid header accepted, every
    forbidden key rejected with the offending name in the message,
    unsupported `formatVersion` rejected, malformed handle
    rejected, malformed `bodySha256` rejected, negative/non-integer
    `bodyBytes` rejected, encode→decode round-trip
  - Magic byte detection: positive case, several non-bundle prefixes,
    ASCII verification
  - Round-trip with real compartment + memory adapter: small
    compartment, medium (200 records), Unicode (Thai + emoji),
    explicit gzip, no compression
  - `readNoydbBundleHeader()` parses without decompression; throws
    on missing magic and on truncated prefix
  - Integrity tampering: flipping a body byte → `BundleIntegrityError`
    with sha message; truncating the body → `BundleIntegrityError`
    with length message
  - Handle stability: same handle across multiple `getBundleHandle`
    calls; same handle across re-exports of the same compartment;
    same handle across separate noydb instances on the same
    adapter (cross-process); different compartments get different
    handles

  **`@noy-db/file`** (6 tests in `bundle.test.ts`):

  - `saveBundle()` writes a `.noydb` file with the magic prefix,
    `loadBundle()` reads it back with parsed header and dump JSON
  - Creates intermediate parent directories
  - Overwrites an existing file at the same path; the bundle
    handle is stable across re-saves
  - Honors compression options (gzip explicit, auto default)
  - `loadBundle()` throws `BundleIntegrityError` on a tampered
    bundle file
  - Cross-session handle stability — fresh noydb instance over
    the same data directory sees the same persisted ULID

  444/444 core tests passing (416 baseline on main + 28 new bundle).
  6/6 file bundle tests passing.

- 958082b: feat(core): `scan().aggregate()` — memory-bounded aggregation over streaming scan (#99)

  `Collection.scan()` now returns a new `ScanBuilder<T>` that
  implements `AsyncIterable<T>` (for backward-compatible `for await`
  iteration) and exposes chainable `.where()` / `.filter()` clauses
  plus a `.aggregate(spec)` async terminal that reduces the scan
  stream through the same reducer protocol as `Query.aggregate()`
  (#97) — with **O(reducers) memory**, not O(records).

  ```ts
  // Backward-compatible iteration — unchanged from before
  for await (const record of invoices.scan({ pageSize: 500 })) {
    await processOne(record);
  }

  // v0.6 #99 — streaming aggregation with filter
  const { total, n } = await invoices
    .scan({ pageSize: 1000 })
    .where("year", "==", 2025)
    .aggregate({ total: sum("amount"), n: count() });
  ```

  **Memory model.** The aggregate terminal initializes one state per
  reducer, iterates through the scan one record at a time, applies
  every reducer's `step` per record, and never collects the stream
  into an array. This is what makes `scan().aggregate()` suitable
  for collections that don't fit in memory — the bound is a
  code-level invariant visible in the function body, not a runtime
  assertion.

  **Reducer reuse.** Every factory from #97 (`count`, `sum`, `avg`,
  `min`, `max`) plugs into `scan().aggregate()` unchanged. The
  `{ seed }` parameter plumbing from #87 constraint #2 is honored
  transparently. No duplicated API — the reducer protocol was
  deliberately designed so both `Query.aggregate()` and
  `Scan.aggregate()` could share it.

  **Immutable builder.** Each `.where()` / `.filter()` call returns
  a fresh `ScanBuilder` sharing the same page provider and page
  size. Base scans can be safely reused across multiple parallel
  aggregations, though each still pays a full scan — multi-way
  single-pass aggregation is out of scope for v0.6.

  **Backward compatibility.** The return type of
  `Collection.scan()` changed from `AsyncIterableIterator<T>` to
  `ScanBuilder<T>`. Every existing `for await (const rec of
collection.scan()) { … }` call continues to work because
  `ScanBuilder` implements `[Symbol.asyncIterator]`. Direct
  `.next()` calls on the iterator — not idiomatic, not used anywhere
  in the codebase — are no longer supported. All 36 existing
  `pagination` + `lazy-hydration` tests continue to pass without
  modification.

  **New public surface:**

  - `ScanBuilder<T>` — the chainable builder class
  - `ScanPageProvider<T>` — page provider interface (exposed so
    tests and custom sources can build a builder without a full
    Collection)

  **Out of scope (tracked separately):**

  - `scan().aggregate().live()` — unbounded streaming + change-stream
    reconciliation is a design problem, not a code one. Consumers
    with huge collections and live needs should narrow with
    `.where()` enough to fit in the 50k `query()` limit and use
    `query().aggregate().live()` instead.
  - `scan().groupBy().aggregate()` — high-cardinality grouping on
    huge collections re-introduces the O(groups) memory problem
    that streaming aggregate was designed to avoid.
  - Parallel scan across pages — race-safe page cursor contracts
    are not in the adapter API yet.
  - `scan().join(…)` — tracked under #76 streaming join.

  Tests: 16 new cases in `query-scan-aggregate.test.ts` covering
  async iteration, `.where()` / `.filter()` clause application,
  multi-clause AND, builder immutability, every reducer in
  combination, empty-result-set sentinels, the #87 seed seam in the
  scan path, backward-compatible `for await` on a real Collection,
  `.aggregate()` over a paginated Collection, multi-page iteration
  with `pageSize` smaller than the collection, and a 5_000-record
  streaming test that validates correctness (and implicitly memory
  footprint) on a dataset large enough to cross many page
  boundaries.

  479/479 core tests passing (463 from #98 + 16 new for #99).

- f65908a: feat(core): `scan().join()` — streaming join over `scan()` (#76)

  `ScanBuilder` now has a chainable `.join(field, { as })` method that
  resolves a `ref()`-declared foreign key per record as the scan
  stream flows, attaching the right-side record (or null) under the
  alias. v0.6 #76 — streaming joins.

  ```ts
  // Streaming joined iteration
  for await (const inv of invoices.scan().join("clientId", { as: "client" })) {
    await processInvoice(inv); // inv.client is attached
  }

  // Streaming joined aggregation
  const { total } = await invoices
    .scan()
    .where("status", "==", "open")
    .join("clientId", { as: "client" })
    .aggregate({ total: sum("amount") });
  ```

  **The key difference from eager `Query.join()` (#73):** the LEFT
  side streams page-by-page from the adapter and is never
  materialized. Memory ceiling on the left is O(pageSize), not
  O(rowCount). This is what makes streaming joins suitable for
  collections that exceed the eager join's 50_000-row ceiling.

  **Right-side strategy** is auto-selected per leg, mirroring eager
  join exactly:

  - **Indexed** — right source exposes `lookupById` (typical
    Collection right side) → O(1) per row, no upfront cost
  - **Hash** — right source has only `snapshot()` → build a
    `Map<id, record>` once at iteration start, then O(1) per row

  Both strategies hold the right side in memory for the duration of
  the iteration. The "streaming" property applies to the **left**
  side only — true left-and-right streaming joins (where neither
  side fits in memory) require a sort-merge join planner that's out
  of scope for v0.6.

  **Ref-mode semantics match eager `.join()` exactly:**

  - `strict` → throws `DanglingReferenceError` mid-stream when a
    left record points at a non-existent right id. The throw
    aborts the async iterator — consumers should wrap the
    `for await` in try/catch if they want to recover.
  - `warn` → attaches `null` and emits a one-shot warning per
    unique dangling pair, deduped per iteration via the same
    warn channel as eager join.
  - `cascade` → attaches `null` silently. A delete-time mode;
    dangling refs at read time are mid-flight or pre-existing
    orphans, not a DSL error.

  **Multi-FK chaining** is supported via repeated `.join()` calls.
  Each leg resolves an independent ref and picks its own strategy
  and ref mode. Joins execute in declaration order — the result of
  one leg becomes the input to the next.

  **Joins run AFTER clauses** in the streaming pipeline, matching
  the eager `Query.toArray()` ordering. This means `.where()` /
  `.filter()` can only see un-joined fields. Filtering on joined
  fields requires a follow-up post-aggregate filter in userland —
  out of scope for v0.6.

  **#87 constraint #1** — every JoinLeg from a streaming join
  carries `partitionScope: 'all'` plumbed through but never read
  by v0.6. v0.10 partition-aware streaming joins will populate it
  from `where()` predicates without changing the planner shape.
  Same seam as eager join.

  **`Collection.scan()` now passes a `JoinContext`** to the
  `ScanBuilder` it returns — same machinery as `Collection.query()`
  already used for eager joins. ScanBuilder constructed via the
  direct constructor (with a synthetic `ScanPageProvider`) has no
  `joinContext` and `.join()` throws with an actionable error.

  **Out of scope (tracked separately):**

  - True left-and-right streaming joins (sort-merge planner)
  - LRU + lazy probe for non-`lookupById` right sources (the
    current hash-from-snapshot fallback materializes the right
    side once; LRU only matters when the right side itself is
    stream-only, which v0.6's adapter API doesn't model)
  - Filtering on joined fields (`.where()` / `.filter()` after
    `.join()` reading joined alias)
  - `scan().join().live()` — same design problem as
    `scan().aggregate().live()`
  - Streaming join across compartments (`queryAcross` continues
    to be the cross-compartment correlation primitive)

  Tests: 12 new cases in `query-scan-join.test.ts` covering:

  - Direct constructor without joinContext throws actionable error
  - Strict mode throws `DanglingReferenceError` mid-iteration (unit
    test with synthetic `JoinContext` to bypass write-time strict
    rejection)
  - Warn mode attaches null + one-shot warning, deduped per pair
  - Cascade mode attaches null silently
  - Null FK passes through regardless of mode
  - Indexed `lookupById` happy path with multi-page iteration
  - Multi-FK chaining via two `.join()` calls
  - `.where()` composed with `.join()` (clauses run before joins)
  - `.scan().join().aggregate()` reduces a joined stream
  - Backward compatibility: `for await` without `.join()` still
    yields plain records

  530/530 core tests passing (518 from #99 + 12 new for #76).

## 0.5.0

### Initial release

Zero-knowledge, offline-first, encrypted document store — the core library with AES-256-GCM encryption, PBKDF2 key derivation, a multi-user keyring system, a hash-chained audit ledger, and a reactive query DSL.

**Crypto and access control.** All cryptography uses the Web Crypto API (`crypto.subtle`) — zero runtime dependencies. AES-256-GCM with a fresh 12-byte random IV per encrypt. PBKDF2-SHA256 with 600,000 iterations for key derivation. AES-KW (RFC 3394) for wrapping DEKs with the per-user KEK. The KEK never persists — it exists only in memory during an active session. Five roles: `owner`, `admin`, `operator`, `viewer`, `client`. Admins can grant and revoke any other admin with a subset-check guardrail (`PrivilegeEscalationError`) and automatic cascade-on-revoke through the delegation tree (`RevokeOptions.cascade`, default `'strict'`).

**Compartments and collections.** A `Noydb` instance holds the auth context and adapter references. Each `Compartment` is a tenant namespace with its own keyrings and collections. Each `Collection<T>` has its own DEK, an optional Standard Schema v1 validator (Zod, Valibot, ArkType, Effect Schema), optional foreign-key references via `ref()` with strict / warn / cascade modes, and either eager or lazy LRU-bounded hydration.

**Hash-chained audit ledger.** Every `put` and `delete` appends an encrypted entry to the compartment's `_ledger` internal collection. Entries link via `prevHash = sha256(canonicalJson(previousEntry))`, so any tampering breaks the chain. `payloadHash` is computed over the **encrypted** envelope, preserving zero-knowledge. `Compartment.ledger()` exposes `head()`, `entries({ from, to })`, `verify()`, and `reconstruct()` for rebuilding any historical version via reverse RFC 6902 JSON Patches stored in `_ledger_deltas`.

**Verifiable backups.** `Compartment.dump()` produces a tamper-evident encrypted JSON envelope that embeds the current ledger head plus the full `_ledger` and `_ledger_deltas` internal collections. `Compartment.load()` verifies the chain end-to-end on restore. `Compartment.verifyBackupIntegrity()` cross-checks data envelopes against the ledger's recorded `payloadHash`es — catches chain tampering, ciphertext substitution, and out-of-band writes.

**Authorization-aware plaintext export.** `Compartment.exportStream()` is an `AsyncIterableIterator<ExportChunk>` that yields per-collection (or per-record with `granularity: 'record'`) chunks of decrypted records, with schema and ref metadata attached. ACL-scoped: collections the caller cannot read are silently skipped. `Compartment.exportJSON()` is a five-line wrapper returning a `Promise<string>` with a stable on-disk shape. Both carry an explicit plaintext-on-disk warning block in JSDoc.

**Cross-compartment role-scoped queries.** `Noydb.listAccessibleCompartments({ minRole? })` enumerates every compartment the calling principal can unwrap at the requested minimum role. The existence-leak guarantee means compartments the caller has no keyring for (or wrong passphrase for) are silently dropped — never confirmed in the return value. `Noydb.queryAcross(ids, fn, { concurrency? })` fans a callback out across the supplied list with per-compartment error capture and opt-in concurrency. Composes with `exportStream()` for cross-tenant plaintext export in a single call.

**Reactive query DSL.** `collection.query()` returns a chainable `Query<T>` builder with operators `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`, `startsWith`, `between`, plus a `.filter(fn)` escape hatch and `.and()`/`.or()` composition. Terminal methods: `.toArray()`, `.first()`, `.count()`, `.subscribe()`, `.toPlan()`. Plans are JSON-serializable for devtools and Web Worker offloading. Secondary indexes via `indexes: ['status', 'clientId']` turn equality and `in` clauses into O(1) hash lookups — built client-side after decryption, never touching the adapter.

**Streaming and lazy hydration.** `Collection.scan()` is an `AsyncIterableIterator<T>` for memory-bounded iteration over very large collections. `cache: { maxRecords, maxBytes }` collection option enables lazy mode: `get(id)` hits the adapter on miss and populates an LRU. Peak memory stays bounded regardless of collection size.

**Adapter contract.** Six mandatory methods (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`), plus optional capabilities: `listPage` for pagination, `listCompartments` for cross-compartment enumeration, `ping` for connectivity checks. Adapters never see plaintext — encryption happens in core before data reaches any adapter.

**Sync engine.** Optional dirty tracking, push/pull with optimistic concurrency via `expectedVersion`, pluggable conflict strategies (`local-wins`, `remote-wins`, `version`, or a user-supplied callback), and autoSync on `online`/`offline` events.

**Biometric and session management.** WebAuthn-backed biometric unlock for browser contexts, session timeout that clears keys from memory after inactivity, passphrase strength validation via Zxcvbn-style entropy estimation.

Zero runtime dependencies.
