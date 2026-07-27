# NOYDB Services

> Formerly `SUBSYSTEMS.md`.

> Authoritative list of services and the always-on core. The service catalog **is** the product surface — every entry below is both a developer-facing feature and a tree-shake-able code module behind a `with*()` strategy seam.

> Each satellite family binds one golden-frozen contract subpath — a **port** (`/to`, `/on`, `/at`, `/in`, `/by`, `/ui`, `/with`, `/as`, `/cargo`, `/pod`) — rather than reaching into hub internals; services hook into the kernel through the `/with` port. See the port table and layering law in [`docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md`](docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md#addendum-ports-2026-07-02).

> Unsure whether something is a family package, a service, a port, or prefix-less? [`FAMILIES.md`](FAMILIES.md) is the classification guide — decision rules plus worked case studies (to-memory vs the kernel cache, port/to vs with-store, in-ai, attestation).

## Why services

NOYDB is built as a **minimalist core + opt-in services**. A consumer who calls only `createNoydb({ user })` — no `store`, since the kernel ships a built-in in-memory default — gets a fully working zero-knowledge encrypted document store and pays for nothing else. Every other capability — history, blobs, sync, joins, CRDT — is a service the developer opts into by passing a strategy factory:

```ts
import { createNoydb } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'
import { withBlobs } from '@noy-db/hub/blobs'

const db = await createNoydb({
  store: idbStore(),
  user: 'me',
  historyStrategy: withHistory(),
  blobsStrategy: withBlobs(),
})
```

When a service is not opted into, its real implementation is replaced by a NO-OP stub (or a throwing stub on opt-in surfaces) and the heavy code is fully tree-shaken from the bundle.

This document lists the always-on core and the service catalog. It is the table of contents for the rest of the documentation. The catalog groups **27 capabilities** for teaching; `package.json` ships **43 subpaths plus the root barrel**, and the two do not map one-to-one — [Subpath inventory](#subpath-inventory) reconciles them and is authoritative.

---

## The minimalist core

The core is what NOYDB **is**, not what it **does**. Six areas are always loaded; together they total roughly **6,500 LOC** out of the hub's ~28,000.

| # | Core area | What it covers | Approx LOC |
|---|---|---|---:|
| C1 | **Vault & Collection model** | `Noydb`, `Vault`, `Collection<T>`, lifecycle, `openVault`, `listVaults` | ~3,000 |
| C2 | **Encryption** | AES-256-GCM, PBKDF2-SHA256 (600K), AES-KW, KEK→DEK, envelope format | ~500 |
| C3 | **Store contract** | The 6-method `NoydbStore` interface (`get`/`put`/`delete`/`list`/`loadAll`/`saveAll`) | ~300 |
| C4 | **Keyring & Permissions** | Owner-role keyring, DEK wrapping, single-user permission check (multi-user grant/revoke/rotate lives in the **`team`** service — split completed in #267, gated behind `withTeam()`) | ~750 |
| C5 | **Schema & Refs** | Typed records, foreign-key references, ref-mode dispatch (strict / warn / cascade) | ~460 |
| C6 | **Query basics** | `where` / `orderBy` / `limit` / `offset` / `toArray` / `first` / `count` / `scan` (eager async iteration) | ~700 |
| — | Errors / Events / Validation | Structured error types, `change` events, runtime guards | ~800 |

Anything outside this floor is a service.

---

## Field features (the Via port)

Separate from services, the **Via port** is a unified field-feature declaration surface where capabilities are declared per-field, not per-vault. Every field can be indexed, a reference, computed, carry money with exact arithmetic, be translated across locales, sealed at rest, externalized as a blob, etc. Each feature is optional and tree-shaken; features compose in one ordered stack and run through a phased kernel pipeline. See [`docs/subsystems/via.md`](docs/subsystems/via.md) for the full story and [`docs/subsystems/via-money.md`](docs/subsystems/via-money.md) / [`docs/subsystems/via-i18n.md`](docs/subsystems/via-i18n.md) / [`docs/subsystems/via-classified.md`](docs/subsystems/via-classified.md) / [`docs/subsystems/via-blob.md`](docs/subsystems/via-blob.md) / [`docs/subsystems/via-computed.md`](docs/subsystems/via-computed.md) / [`docs/subsystems/via-lookup.md`](docs/subsystems/via-lookup.md) for individual features. Phase A ships `via-money` and `via-i18n` (with backward compatibility); phase B ships `via-classified` and `via-blob` plus posture enforcement (query/export/forget) and `ViaCryptoCtx`; phase C ships the `ViaGraph` dependency graph + taint algebra, `via-computed` (virtual + materialized), taint enforcement, sync/cutover/restore dispatch, the frozen-output skip+audit rule, and forget fanout; phase D ships `via-lookup` (`lookup`/`enum`/`dict`, three backing tiers, altKeys, vocabulary, `restrict`/`cascade`/`nullify` reference semantics — `dictKey()`/`staticDict()` become aliases onto it); phase E adds external-SPI extensibility.

## The service catalog

Most services have their own subpath export under `@noy-db/hub/<name>`, a `with<Name>()` factory, and a doc page at [`noy-db-docs/content/docs/services/<name>.md`](https://github.com/vLannaAi/noy-db-docs/tree/main/content/docs/services). The "LOC saved" column is the bundle weight a consumer avoids by **not** opting in.

> **This table is the catalog, not the export list.** It groups capabilities for teaching; some rows are always-core rather than opt-in subpaths, and `package.json`'s `exports` carries entries this table does not (see [Subpath inventory](#subpath-inventory) for the authoritative two-way reconciliation). Two markers appear below:
> **‡** shipped, but reachable only from the root barrel — it has no subpath of its own.

### Cluster A — Read & Query

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 1 | `@noy-db/hub/indexing` | Eager + lazy persisted indexes (equality + orderBy dispatch) | 886 | `joins`, `lazy` |
| 2 | *(always-core — via `@noy-db/hub/query`)* | Multi-FK eager joins (indexed nested-loop / hash strategy) | ~470 | `indexing`, `live` |
| 3 | `@noy-db/hub/reduce` | `count` / `sum` / `avg` / `min` / `max` + `groupBy` | 886 | `joins` |
| 4 | *(always-core)* | Reactive subscriptions (`.live()`, `.subscribe()`) | ~210 | `joins`, `crdt`, `sync` |
| 28 | `@noy-db/hub/search` | Scan-mode full-text search — tokenizer, inverted index, snippets, retrieval fusion (`withSearch()`) | ~700 | `indexing`, `classified` |
| 22 | *(always-core)* | Cartesian + lateral cross-join — `.crossJoin(target, { as })` with 50K-row cost ceiling (Dim 11 v3) | — | `joins`, `reduce` |

### Cluster B — Write & Mutate

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 5 | `@noy-db/hub/history` | Versioning, diff, revert, time-machine, audit ledger (hash-chained) | 1,880 | `periods`, `consent`, `shadow`, `guards` |
| 6 | `@noy-db/hub/transactions` | Multi-record atomic writes (`db.transaction(fn)`) | 280 | `history`, `sync`, `derivations`, `guards` |
| 7 | `@noy-db/hub/crdt` | LWW-Map / RGA / Yjs interop | 221 | `live`, `sync` |
| 29 | `@noy-db/hub/sequence` | Atomic gap-free numbering — `vault.sequence(name).next()` over a CAS retry loop; online-only by design (`withSequence()`) | ~300 | `transactions`, `periods` |

### Cluster C — Derived data

The Dim 14 family. All three share the same encrypted-payload metadata envelope, the same housekeeping-delete bypass (so user `onDelete` guards on output collections don't deadlock system-internal tombstones), and a unified cycle detector at vault open.

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 18 | `@noy-db/hub/derivations` | Deterministic derived data — source row → typed outputs (eager / lazy) with cycle detection and strict-mode rollback (Dim 14 v1) | ~550 | `transactions` (strict-mode rollback), `guards` |
| 20 | `@noy-db/hub/materialized-views` | Query-level materialized views — `Query<T>` → output collection with eager / lazy / manual refresh, partition cycle-break, declared deterministic predicates with `queryHash` folding (Dim 14 v2) | ~1,400 | `derivations` (shared envelope shape), `transactions` (strict-mode), `overlay-views` (composition) |
| 21 | `@noy-db/hub/overlay-views` | Read-shadow virtual collections — merges base (typically MV output) + user-writable overlay via single-field shadow predicate; operator-editable layer over deterministic MVs | ~600 | `materialized-views`, `guards` (overlay-side write hooks), `derivations` |

### Cluster D — Data Shape

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 8 | `@noy-db/hub/blobs` | Binary attachments + compaction + MIME-magic | 2,376 | `pod`, `routing` |
| 9 | `@noy-db/hub/i18n` | Multi-locale records + dict-key resolution + auto-translate hook | 854 | `aggregate` (groupBy on dict-key) |
| 25 | `@noy-db/hub/classified` | Classified fields — behavioral sensitive-field types: presets, riders, projections, audited reveal, verify-without-reveal (digest-only presets, k-of-n matchGroup), equatable blind index (`_bidx`) + `findByDigest` | ~1,150 | `guards`, `history` (audited access) |

### Cluster E — Time & Audit

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 10 | `@noy-db/hub/periods` | Accounting periods + closed-period write guard | 334 | `history` |
| 11 | `@noy-db/hub/consent` | Consent audit log (GDPR/PIPL-friendly) | 194 | `history` |
| 19 | `@noy-db/hub/guards` | Record lock + field-level freeze + role-gated amendment invariant with `op: 'amendment'` ledger entry | ~700 | `history` (amendment audit), `transactions` (amendment-mode rollback), `team` (role check) |

### Cluster F — Snapshot & Portability

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 12 | `@noy-db/hub/shadow` | Read-only `vault.frame()` views | 129 | `history` (time-machine) |
| 13 | `@noy-db/hub/pod` (alias: `/bundle`, deprecated) | `.noydb` encrypted container format (backup, transport) | 846 | `blobs`, `routing` |
| 23 | `@noy-db/hub/snapshots` | Vault checkpoint/restore — `db.snapshot()` / `listSnapshots()` / `restoreSnapshot()` with declarative retention + `ledgerHead` tamper-detection | ~200 | `pod`, `history` |

### Cluster G — Collaboration & Auth

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 14 | `@noy-db/hub/sync` | P2P replication engine + presence | ~856 | `crdt`, `live`, `team` |
| 15 | `@noy-db/hub/team` | Multi-user grant/revoke/rotate (`db.grant`/`db.revoke`/`db.rotate` require `teamStrategy: withTeam()` since 0.3 — #267) + magic-link + delegation + tiers | ~1,000 | `sync`, `session` |
| 16 | `@noy-db/hub/session` | Token sessions + dev-unlock + policy enforcement | 839 | `team` |
| 16a | `vault.user.*` (always-on) — see `user-envelope` | Per-principal profile + preferences envelope (`_users/<keyringId>`) with own-only write rule | ~600 always-on | `team`, `session-tiers`, `sync` |
| 30 | `@noy-db/hub/custody` | FR-6 sovereign custody — `grantCustodian` / `revokeCustodian` / audited `liberate` of a sealed-owner (Deed) vault (`withCustody()`) | ~400 | `team`, `history` (ledger audit) |
| 27 | `@noy-db/hub/broker` | Passphrase-bound rolling non-extractable store-auth broker (enrol/challenge/credentials + refresh hook) | ~500 | `team`, `session` |

<a id="user-envelope"></a>**`user-envelope`** is included in the always-on core because it has zero peer-dep cost and the policy gates (`edit-own-profile`, `view-team-profiles`) are valuable even for single-user vaults. See [`noy-db-docs/content/docs/services/user-envelope.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/user-envelope.md).

### Cluster H — Operations

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 17 | `@noy-db/hub/store` | Multi-store routing + middleware + sync-policy | ~1,800 | `indexing`, `pod`, `lazy` |
| 26 | `@noy-db/hub/lazy` | Lazy mode — `prefetch: false` on-demand per-id reads over a bounded LRU working set (`withLazy()`; promoted out of `routing`, #267) | ~185 | `indexing` (persisted mirrors), `routing` |
| 24 | *(preview)* | Multi-vault partition federation — `db.openVaultGroup()` transparent shard routing + `vault-registry` source-of-truth + `minVersion` fan-out guard (MVP, milestone 16) | — | `queryAcross`, `permissions` |

**Totals:** ~17,440 LOC across all 27 services are tree-shake-able. A consumer using only the core ships ~6,500 LOC. A consumer opting into all 27 ships ~32,490 LOC.

---

<a id="subpath-inventory"></a>

## Subpath inventory — the authoritative list

`package.json`'s `exports` is the source of truth: **43 subpaths plus the root barrel**. It is enforced by the `service-subpath-naming` check in `scripts/check-architecture.mjs`, which fails in both directions — a factory with no subpath, and a subpath with no factory. The catalog above groups capabilities for teaching and does not map one-to-one onto it. This section reconciles the two, and is the list to check against when adding or removing an entry.

### Themed homes (#843 C3a)

`./store`, `./introspection`, `./money`, `./cover`, `./schema-update`, `./policy` and `./directory` group symbols that previously had no home but the root barrel. They are **additive** — each is also still re-exported from `.`, matching how the Via features are dual-homed (`./classified` and `./i18n` have always been reachable both ways). The subpath exists so the surface is navigable and tree-shakeable, not to force a migration. None has a `with<Name>()` factory, so each is allowlisted in the `service-subpath-naming` guard as a themed grouping rather than a service.

**Where this stopped, and why.** #843(c) began with **467 symbols reachable from no entry but `.`**; it now stands at **278**. Of those, **185 are declared in `kernel`** — `createNoydb`, `Vault`, `Collection`, the store contract, the error types — and belong on the root barrel by design, and a further **12** are the `at-*`/`on-*` sealing SPI that satellites import from `.` (see #843 C2). That leaves ~81 spread across ~19 modules at nine or fewer each. Those are deliberately left on the root barrel: a subpath for nine symbols mints permanent public API and a guard allowlist entry to satisfy a count, which is worse than the drift it removes. Revisit only if one of those modules grows a real, separable capability.

### Shipped subpaths not represented as rows above

`./attestation` · `./cargo` · `./forget` · `./i18n` · `./portability` · `./query` · `./reduce` · `./satellites` · `./sealed-record` · `./share-link` · `./tiers` · `./to` · `./util`

Several are contract seams rather than services — `./cargo` (frozen orchestration seam for klum-db), `./to` (the store contract satellites bind), `./pod`, `./satellites`, `./util`, `./share-link`, `./query`. They are exports, not opt-in capabilities, and deliberately have no `with<Name>()` factory.

### Shipped capabilities with **no** subpath

Each is reachable only from the root barrel. Listed so the omission is a recorded decision rather than drift:

| Capability | Seam | Why no subpath (yet) |
|---|---|---|
| `withArchive` | factory + `ArchiveStrategy`, **no `NO_*` stub** | Held as `ArchiveStrategy \| null` rather than a stub, so it does not yet match the service shape. Decide the stub first. |
| `withLookup` | `active.ts`, no stub | **Deliberate** — `via/lookup/index.ts` records that its declaration surface (`lookup`/`enumOf`/`dict`) is re-exported from the root barrel instead. Note this makes it the only Via feature without one (`i18n`, `classified`, `blobs` each have theirs). |

### Documented previously but never shipped

`/joins` and `/live` are **always-core**, not subpaths — joins lives in `kernel/query/join.ts` and is reachable via `./query`. `/aggregate` was renamed `./reduce` in #843(a). `/transactions` has never existed; the export is `./tx`. `/metrics`, `/migrations`, `/partitioning`, and `/validation` remain under [Reserved future services](#reserved-future-services).

---

## Service page template

Every service doc page ([`noy-db-docs/content/docs/services/<name>.md`](https://github.com/vLannaAi/noy-db-docs/tree/main/content/docs/services)) follows the same template so developers can scan any page and find what they need in the same spot:

```markdown
# <Service Name>

> **Subpath:** `@noy-db/hub/<name>`
> **Factory:** `with<Name>()`
> **Cluster:** <A–H>
> **LOC cost:** ~<n> (off-bundle when not opted in)

## What it does

One paragraph. The feature, in plain language.

## When you need it

Three to five bullet scenarios. Concrete, not abstract.

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { with<Name> } from '@noy-db/hub/<name>'

const db = await createNoydb({
  store: ...,
  user: ...,
  <name>Strategy: with<Name>(),
})
```

## API

The public surface this service adds: methods on `Vault`, `Collection`, query terminals, top-level helpers.

## Behavior when NOT opted in

- What surfaces are still callable (no-ops vs throws)
- What error message guides the developer to the subpath import

## Pairs well with

Cross-references to other services that compose naturally.

## Edge cases & limits

Row ceilings, performance considerations, security notes.

## See also

Related SPEC sections, ADRs, showcase tests.
```

---

## Documentation partition

The catalog drives the docs layout. The proposed structure:

```
docs/
  core/
    01-vault-and-collections.md
    02-encryption.md
    03-stores.md
    04-permissions-and-keyring.md
    05-schema-and-refs.md
    06-query-basics.md
  services/
    indexing.md         # Cluster A
    joins.md
    aggregate.md
    live.md
    history.md          # Cluster B
    transactions.md
    crdt.md
    blobs.md            # Cluster C
    i18n.md
    periods.md          # Cluster D
    consent.md
    shadow.md           # Cluster E
    bundle.md
    sync.md             # Cluster F
    team.md
    session.md
    routing.md          # Cluster G
  recipes/
    personal-notebook.md
    accounting-app.md
    realtime-crdt-app.md
    analytics-app.md
  reference/
    architecture.md
    threat-model.md
    store-conformance.md
```

[`SPEC.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md) (in `noy-db-docs`) reorganizes around the same partition: a "Core" half (one section per C1–C6) and a "Services" half (one section per service, in the same order as the catalog).

---

## Starter recipes

Each recipe maps directly to a doc page under [`noy-db-docs/content/docs/recipes/`](https://github.com/vLannaAi/noy-db-docs/tree/main/content/docs/recipes) and a showcase test under [`noy-db-docs/showcases/`](https://github.com/vLannaAi/noy-db-docs/tree/main/showcases).

### Recipe 1 — Personal encrypted notebook (single user, local-only)

```ts
import { createNoydb } from '@noy-db/hub'
import { idbStore } from '@noy-db/to-browser-idb'

const db = await createNoydb({ store: idbStore(), user: 'me' })
```

**Bundle:** ~6,500 LOC. No history, no blobs, no sync, no joins, no aggregate.

### Recipe 2 — Accounting application (immutable books + attachments + dictionaries + audit)

```ts
import { createNoydb } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'
import { withPeriods } from '@noy-db/hub/periods'
import { withBlobs } from '@noy-db/hub/blobs'
import { withI18n } from '@noy-db/hub/i18n'
import { withConsent } from '@noy-db/hub/consent'

const db = await createNoydb({
  store: postgresStore({ ... }),
  user: 'admin',
  historyStrategy: withHistory(),
  periodsStrategy: withPeriods(),
  blobsStrategy: withBlobs(),
  i18nStrategy: withI18n(),
  consentStrategy: withConsent(),
})
```

**Bundle:** ~12,200 LOC. Optimal mix for compliance-heavy verticals.

### Recipe 3 — Real-time collaborative app

```ts
import { createNoydb } from '@noy-db/hub'
import { withCrdt } from '@noy-db/hub/crdt'
import { withSync } from '@noy-db/hub/sync'
import { withLive } from '@noy-db/hub/live'
import { withTeam } from '@noy-db/hub/team'
import { withSession } from '@noy-db/hub/session'

const db = await createNoydb({
  store: idbStore(),
  user: currentUser,
  crdtStrategy: withCrdt(),
  syncStrategy: withSync({ peer: ... }),
  liveStrategy: withLive(),
  teamStrategy: withTeam(),
  sessionStrategy: withSession(),
})
```

**Bundle:** ~10,400 LOC. Skips history, blobs, periods, aggregate, joins.

### Recipe 4 — Analytics-heavy querying

```ts
import { createNoydb } from '@noy-db/hub'
import { withIndexing } from '@noy-db/hub/indexing'
import { withJoins } from '@noy-db/hub/joins'
import { withAggregate } from '@noy-db/hub/aggregate'
import { withRouting } from '@noy-db/hub/routing'

const db = await createNoydb({
  store: postgresStore({ ... }),
  user: 'analyst',
  indexingStrategy: withIndexing({ lazy: true }),
  joinsStrategy: withJoins(),
  aggregateStrategy: withAggregate(),
  routingStrategy: withRouting({ ... }),
})
```

**Bundle:** ~10,700 LOC. Optimized for read-path with lazy loading.

---

## Reserved future services

Slots reserved in the catalog so future work doesn't force renumbering or doc reshuffles. These are **not** services today; they're placeholders so spec/docs/issues can reference them ahead of implementation.

| Reserved name | Intended scope | Earliest target |
|---|---|---|
| `@noy-db/hub/partitioning` | Time-range / region / tenant partition awareness for query execution. The 37 LOC of dormant plumbing in `query/join.ts` (`partitionScope: 'all'` + reducer `seed`) is the seed for this. | TBD |
| `@noy-db/hub/migrations` | Schema migrations between hub versions / collection renames / field rename + backfill. | TBD |
| `@noy-db/hub/metrics` | Hub-level observability (timings, cache stats, sync stats). Today partial via the `to-meter` store wrapper. | TBD |
| `@noy-db/hub/validation` | Richer runtime validators (Zod-style, JSON-schema). Today schema/refs is core; deeper validation could split. | TBD |

---

## Service dependencies

Services compose. The diagram below records hard dependencies (A → B means "if you opt into A, you should also opt into B for the documented surface to work end-to-end").

```
joins ─────────► indexing      (indexed nested-loop strategy)
                  ▲
aggregate ────────┘            (groupBy uses index dispatch when present)

history ──┬──► shadow          (time-machine returns a frame)
          ├──► (audit ledger lives inside history today)
          └──► transactions    (transaction body uses history events)

crdt ─────► live               (CRDT updates surface through live queries)
sync ─────► crdt, live, team   (sync engine reuses CRDT merge + presence + grants)
team ─────► session            (token sessions enforce grants)
periods ──► history            (closed-period guard reads ledger)
consent ──► history            (consent audit appends ledger entries)
guards ───► history            (successful amendment appends `op: 'amendment'` ledger entry)
guards ───► transactions       (amendment mode set via `db.transaction({ amendment, reason }, fn)`)
derivations ► transactions     (strict-mode failure triggers source rollback via shared revert plan)
materialized-views ► derivations (shares the encrypted-payload metadata envelope; reuses housekeeping bypass)
materialized-views ► transactions (strict-mode + `withTransactions` triggers source rollback)
overlay-views ► materialized-views (typical base; cycle detector unifies the graph)
```

Soft pairings (mentioned in "Pairs well with" but not enforced) are listed per page.

---

## Bundle-size invariants (CI)

The catalog only delivers value if the gates hold under build. CI must enforce:

1. **Floor invariant** — `createNoydb({ store, user })` with no other imports compiles to ≤ ~6,800 LOC of executed JS (small headroom over the floor for type-elision artifacts).
2. **Per-service invariant** — importing a single service entry adds ≤ its declared LOC (with a +10% headroom).
3. **Cross-leak invariant** — no service implementation file is reachable from `@noy-db/hub` (root) without an explicit subpath import. Enforced by a Rollup analyzer pass.

These three invariants make the catalog **load-bearing** rather than aspirational.

---

## Governance

- **Adding a service** requires: a doc page from the template, a strategy seam (`<name>/{strategy.ts,active.ts,index.ts}`), a subpath export in `package.json`, a tsup multi-entry, a SPEC section, and a CI bundle-size gate.
- **Removing a service** requires a deprecation notice in the changelog, a major version bump, and a migration recipe in the doc page.
- **Renaming a service** requires keeping the old subpath export as a re-export for one minor version with a deprecation warning.

### The naming contract (#844)

> Enforced by `pnpm check:architecture` (`service-subpath-naming`). Both allowlists in that check require a reason recorded in this document, so silencing the guard costs the same effort as documenting the decision.

**The subpath is canonical.** Every other name for a service derives from it mechanically:

| Position | Rule | Example (`@noy-db/hub/snapshots`) |
|---|---|---|
| Subpath | `@noy-db/hub/<name>` | `@noy-db/hub/snapshots` |
| Factory | `with<Name>()` | `withSnapshots()` |
| Return type | `<Name>Strategy` | `SnapshotsStrategy` |
| `createNoydb` option | `<name>Strategy` | `snapshotsStrategy` |
| Bag key | `strategies.<name>` | `strategies.snapshots` |
| Un-opted-in stub | `NO_<NAME>` | `NO_SNAPSHOTS` |

Every service satisfies this. `./tx` was renamed `./transactions` in #843 to close the last gap — #844 had named the types from the subpath this document *claimed* (`/transactions`), which had never shipped, leaving factory, type, and option agreeing with each other but not with the export.

Three further rules:

1. **`Strategy` means the output, never the input.** A service you *declare* rather than merely *enable* takes a `<Name>Spec` and returns a `<Name>Strategy` — `withGuard(spec: GuardSpec): GuardStrategy`, and likewise for `withDerivation`, `withMaterializedView`, `withOverlayedView`. Before #844 these four used `<Name>Strategy` for the argument and `<Name>StrategyHandle` for the result, inverting the meaning the other 23 services carry.
2. **An options bag must be a named, exported type**, never an inline literal — an unnameable parameter type cannot be built on by consumers. Spell it `With<Name>Options` when it is a pure factory argument (`WithBlobsOptions`, `WithArchiveOptions`, `WithSnapshotsOptions`, `WithTransactionsOptions`, `WithRollupOptions`, `WithDeferredNumberingOptions`).
3. **The parameter is named `opts`.**

Sanctioned exceptions — extend this list only with a stated reason, never by drift:

- **`withBroker(config: BrokerConfig)`** — the argument is not a factory options bag; it is retained as live configuration and read back as `BrokerSeedCtx.config`. Both the parameter and the type say `config` because that is what it is.
- **`withForget`'s `SubjectDeclaration`** — the bag has an independent domain identity (the subject-key map), so it keeps that name rather than becoming `WithForgetOptions`. (The factory itself was renamed from `withForgetCascade` in #844 to match its `/forget` subpath.)
- **`with-store`'s middleware** — `withRetry`, `withLogging`, `withMetrics`, `withCircuitBreaker`, `withCache`, `withHealthCheck` return `StoreMiddleware`, not a strategy. They are not services and the table above does not apply.
- **`withDeferredNumbering`** returns a `DeferredNumberingConfig` consumed via `createNoydb({ numbering: [...] })`. It is a declaration helper, not a service seam; only rules 2 and 3 apply.

### Satellite family conventions (#845) — known debt

The hub is conformed; the satellite families are **not**, and were deliberately left alone in this pass. `as-*` (`toString`/`toBytes`/`download`/`write`/`from*`) and `at-*` (`*SealingProvider`) are the models to copy. The open drift:

- **`to-*` — five entry-point styles across five packages.** `to-file` → `jsonFile` (bare noun), `to-memory` → `memory`, `to-browser-idb` → `browserIdbStore` (noun+`Store`), `to-meter` → `toMeter` (family prefix), `to-probe` → `runStoreProbe`/`probeTopology` (verb). Separately, `to-memory`'s `memory(opts)` duplicates the hub root's `memoryStore()` under a different name *and* a different signature — which of the two is canonical is still undecided.
- **`on-*` — the `enroll*`/`unlock*` pair holds for `on-webauthn` and `on-oidc` only.** Outliers: `on-password` (`enrollPasswordAuthenticator` + `unwrapDeksWithPassword`), `on-pin` (`enrollPin`/`resumePin` — defensible, it genuinely is a resume), `on-magic-link` (`issueInvite`/`acceptInvite`), `on-shamir` (`splitKEK`/`combineKEK`), and worst, `on-email-otp` exporting bare `issue`/`verify` and `on-totp` a bare `verify` — unnamespaced generic identifiers at package top level.

These are cross-package renames on separately-versioned satellites, so they need their own pass. Pre-1.0 still makes them free.

---

## Open questions

- ~~Should `keyring-grant` (multi-user grant/revoke/rotate) split out of core into the `team` service, leaving only single-owner keyring in core?~~ **Resolved (#267):** the split is complete. `db.grant` / `db.revoke` / `db.rotate` throw `TeamNotEnabledError` unless `teamStrategy: withTeam()` is passed; the keyring grant/revoke/rotate engines are linked only from the `@noy-db/hub/team` subpath, so the core floor really is single-user. Single-user primitives (owner keyring, unlock, `listUsers`, `updateUser`, passphrase rotate/recover, `createDeedOwner`) stay ungated.
- ~~Should `lazy` mode (cache + on-demand fetch) be promoted from inside `routing` to its own headline service?~~ **Resolved (#267):** promoted — `@noy-db/hub/lazy` ships `withLazy()` (entry #26). Pre-1.0 back-compat: `prefetch: false` without `withLazy()` keeps working identically through a deprecated implicit path (one-time console warn); the implicit path is removed at 1.0.
- Should `bundle` stay as a subpath given it already tree-shakes naturally via `"sideEffects": false` and named re-exports? Decision: yes — the docs surface matters more than the technical mechanism, and a uniform pattern (every service has `with*()`) is easier to teach.
