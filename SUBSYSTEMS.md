# NOYDB Subsystems

> Authoritative list of subsystems and the always-on core. The subsystem catalog **is** the product surface — every entry below is both a developer-facing feature and a tree-shake-able code module behind a `with*()` strategy seam.

## Why subsystems

NOYDB is built as a **minimalist core + opt-in subsystems**. A consumer who calls only `createNoydb({ store, user })` gets a fully working zero-knowledge encrypted document store and pays for nothing else. Every other capability — history, blobs, sync, joins, CRDT — is a subsystem the developer opts into by passing a strategy factory:

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

When a subsystem is not opted into, its real implementation is replaced by a NO-OP stub (or a throwing stub on opt-in surfaces) and the heavy code is fully tree-shaken from the bundle.

This document lists the always-on core and the 17 subsystems. It is the table of contents for the rest of the documentation.

---

## The minimalist core

The core is what NOYDB **is**, not what it **does**. Six areas are always loaded; together they total roughly **6,500 LOC** out of the hub's ~28,000.

| # | Core area | What it covers | Approx LOC |
|---|---|---|---:|
| C1 | **Vault & Collection model** | `Noydb`, `Vault`, `Collection<T>`, lifecycle, `openVault`, `listVaults` | ~3,000 |
| C2 | **Encryption** | AES-256-GCM, PBKDF2-SHA256 (600K), AES-KW, KEK→DEK, envelope format | ~500 |
| C3 | **Store contract** | The 6-method `NoydbStore` interface (`get`/`put`/`delete`/`list`/`loadAll`/`saveAll`) | ~300 |
| C4 | **Keyring & Permissions** | Owner-role keyring, DEK wrapping, single-user permission check (multi-user grant/revoke is the **`team`** subsystem) | ~750 |
| C5 | **Schema & Refs** | Typed records, foreign-key references, ref-mode dispatch (strict / warn / cascade) | ~460 |
| C6 | **Query basics** | `where` / `orderBy` / `limit` / `offset` / `toArray` / `first` / `count` / `scan` (eager async iteration) | ~700 |
| — | Errors / Events / Validation | Structured error types, `change` events, runtime guards | ~800 |

Anything outside this floor is a subsystem.

---

## The 17 subsystems

Each subsystem has its own subpath export under `@noy-db/hub/<name>`, a `with<Name>()` factory, and a doc page in `docs/subsystems/<name>.md`. The "LOC saved" column is the bundle weight a consumer avoids by **not** opting in.

### Cluster A — Read & Query

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 1 | `@noy-db/hub/indexing` | Eager + lazy persisted indexes (equality + orderBy dispatch) | 886 | `joins`, `lazy` (within `routing`) |
| 2 | `@noy-db/hub/joins` | Multi-FK eager joins (indexed nested-loop / hash strategy) | ~470 | `indexing`, `live` |
| 3 | `@noy-db/hub/aggregate` | `count` / `sum` / `avg` / `min` / `max` + `groupBy` | 886 | `joins` |
| 4 | `@noy-db/hub/live` | Reactive subscriptions (`.live()`, `.subscribe()`) | ~210 | `joins`, `crdt`, `sync` |

### Cluster B — Write & Mutate

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 5 | `@noy-db/hub/history` | Versioning, diff, revert, time-machine, audit ledger (hash-chained) | 1,880 | `periods`, `consent`, `shadow` |
| 6 | `@noy-db/hub/transactions` | Multi-record atomic writes (`db.transaction(fn)`) | 280 | `history`, `sync` |
| 7 | `@noy-db/hub/crdt` | LWW-Map / RGA / Yjs interop | 221 | `live`, `sync` |

### Cluster C — Data Shape

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 8 | `@noy-db/hub/blobs` | Binary attachments + compaction + MIME-magic | 2,376 | `bundle`, `routing` |
| 9 | `@noy-db/hub/i18n` | Multi-locale records + dict-key resolution + auto-translate hook | 854 | `aggregate` (groupBy on dict-key) |

### Cluster D — Time & Audit

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 10 | `@noy-db/hub/periods` | Accounting periods + closed-period write guard | 334 | `history` |
| 11 | `@noy-db/hub/consent` | Consent audit log (GDPR/PIPL-friendly) | 194 | `history` |

### Cluster E — Snapshot & Portability

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 12 | `@noy-db/hub/shadow` | Read-only `vault.frame()` views | 129 | `history` (time-machine) |
| 13 | `@noy-db/hub/bundle` | `.noydb` encrypted container format (backup, transport) | 846 | `blobs`, `routing` |

### Cluster F — Collaboration & Auth

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 14 | `@noy-db/hub/sync` | P2P replication engine + presence | ~856 | `crdt`, `live`, `team` |
| 15 | `@noy-db/hub/team` | Multi-user grant/revoke/rotate + magic-link + delegation + tiers | ~1,000 | `sync`, `session` |
| 16 | `@noy-db/hub/session` | Token sessions + dev-unlock + policy enforcement | 839 | `team` |

### Cluster G — Operations

| # | Subpath | Headline | LOC saved | Pairs with |
|---|---|---|---:|---|
| 17 | `@noy-db/hub/routing` | Multi-store routing + middleware + sync-policy + lazy-mode + LRU cache | ~1,985 | `indexing`, `bundle` |

**Totals:** ~13,200 LOC across all 17 subsystems are tree-shake-able. A consumer using only the core ships ~6,500 LOC. A consumer opting into all 17 ships ~28,000 LOC (parity with today).

---

## Subsystem page template

Every subsystem doc page (`docs/subsystems/<name>.md`) follows the same template so developers can scan any page and find what they need in the same spot:

```markdown
# <Subsystem Name>

> **Subpath:** `@noy-db/hub/<name>`
> **Factory:** `with<Name>()`
> **Cluster:** <A–G>
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

The public surface this subsystem adds: methods on `Vault`, `Collection`, query terminals, top-level helpers.

## Behavior when NOT opted in

- What surfaces are still callable (no-ops vs throws)
- What error message guides the developer to the subpath import

## Pairs well with

Cross-references to other subsystems that compose naturally.

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
  subsystems/
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

`SPEC.md` reorganizes around the same partition: a "Core" half (one section per C1–C6) and a "Subsystems" half (one section per subsystem, in the same order as the catalog).

---

## Starter recipes

Each recipe maps directly to a doc page under `docs/recipes/` and a showcase test under `showcases/`.

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

## Reserved future subsystems

Slots reserved in the catalog so future work doesn't force renumbering or doc reshuffles. These are **not** subsystems today; they're placeholders so spec/docs/issues can reference them ahead of implementation.

| Reserved name | Intended scope | Earliest target |
|---|---|---|
| `@noy-db/hub/partitioning` | Time-range / region / tenant partition awareness for query execution. The 37 LOC of dormant plumbing in `query/join.ts` (`partitionScope: 'all'` + reducer `seed`) is the seed for this. | TBD |
| `@noy-db/hub/migrations` | Schema migrations between hub versions / collection renames / field rename + backfill. | TBD |
| `@noy-db/hub/metrics` | Hub-level observability (timings, cache stats, sync stats). Today partial via the `to-meter` store wrapper. | TBD |
| `@noy-db/hub/validation` | Richer runtime validators (Zod-style, JSON-schema). Today schema/refs is core; deeper validation could split. | TBD |

---

## Subsystem dependencies

Subsystems compose. The diagram below records hard dependencies (A → B means "if you opt into A, you should also opt into B for the documented surface to work end-to-end").

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
```

Soft pairings (mentioned in "Pairs well with" but not enforced) are listed per page.

---

## Bundle-size invariants (CI)

The catalog only delivers value if the gates hold under build. CI must enforce:

1. **Floor invariant** — `createNoydb({ store, user })` with no other imports compiles to ≤ ~6,800 LOC of executed JS (small headroom over the floor for type-elision artifacts).
2. **Per-subsystem invariant** — importing a single subsystem entry adds ≤ its declared LOC (with a +10% headroom).
3. **Cross-leak invariant** — no subsystem implementation file is reachable from `@noy-db/hub` (root) without an explicit subpath import. Enforced by a Rollup analyzer pass.

These three invariants make the catalog **load-bearing** rather than aspirational.

---

## Governance

- **Adding a subsystem** requires: a doc page from the template, a strategy seam (`<name>/{strategy.ts,active.ts,index.ts}`), a subpath export in `package.json`, a tsup multi-entry, a SPEC section, and a CI bundle-size gate.
- **Removing a subsystem** requires a deprecation notice in the changelog, a major version bump, and a migration recipe in the doc page.
- **Renaming a subsystem** requires keeping the old subpath export as a re-export for one minor version with a deprecation warning.

---

## Open questions

- Should `keyring-grant` (multi-user grant/revoke/rotate) split out of core into the `team` subsystem, leaving only single-owner keyring in core? Today this is partially done — the proposal is to complete the split so the core floor really is single-user.
- Should `lazy` mode (cache + on-demand fetch) be promoted from inside `routing` to its own headline subsystem? Trade-off: clarity vs. catalog inflation. Open for the next review.
- Should `bundle` stay as a subpath given it already tree-shakes naturally via `"sideEffects": false` and named re-exports? Decision: yes — the docs surface matters more than the technical mechanism, and a uniform pattern (every subsystem has `with*()`) is easier to teach.
