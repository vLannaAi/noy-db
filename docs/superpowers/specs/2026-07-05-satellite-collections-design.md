# Satellite collections — off-row storage for heavy fields in a zero-knowledge store (design)

**Date:** 2026-07-05 · **Status:** DRAFT v3 — owner-reviewed 2026-07-07, then **adversarially audited 2026-07-07** (3 independent lenses: security/ZK, consistency/convergence, API/architecture; 22 findings; all resolutions folded below; two previously-pinned decisions reversed: auto-create-null **dropped**, forget kill-order **downgraded** → [#590](https://github.com/vLannaAi/noy-db/issues/590)); pending plan.
**Issue:** [#591](https://github.com/vLannaAi/noy-db/issues/591) · **Builds on:** the row/collection/OLTP model (unchanged), the best-effort-revert write pattern of `putManyAtomic` / `runTransaction` (`kernel/collection.ts`, `with-commit/tx/transaction.ts` — the *pattern*, not the primitives themselves: both are single-collection or opt-in, see § Atomicity), the join planner's same-id `lookupById` nested-loop path (`kernel/query/join.ts:384`), the persisted-schema / config-marker machinery (`with-shape/persisted-schemas`, classified config-drift marker), and the `forget()` / tombstone path (`with-audit/forget`, `tombstone.ts`).

## Problem

A noy-db record is a **single monolithic encrypted envelope** — there is no partial decryption. To read *any* field of a record you decrypt the *whole* record. So a collection with a few small, hot, frequently-queried fields **plus** one or a few large, cold fields (a long `body`, a full document, a big note) pays to decrypt the large field on **every** read, even the 97% of reads that never touch it.

Example — a mail store:

```
msgs:       msg_id, from, to, subject_short, received_date        ← hot, small, listed/filtered constantly
msgs_text:  msg_id, subject, body                                 ← cold, large, full-text-searched, rarely loaded
```

Scanning an inbox list should not decrypt every message body. Today it must, because `body` lives in the same envelope as `received_date`.

## Prior art — this is a universal pattern, and the ZK constraint forces one specific form of it

Splitting hot/cold columns across a shared key is one of the most established patterns in databases. It exists at two levels:

- **Transparent, storage-engine automatic:** PostgreSQL **TOAST** (values over ~2 KB compressed and/or moved to a `pg_toast_*` side table, fetched only when that column is projected), SQL Server "large value types out of row" / `TEXTIMAGE_ON`, Oracle LOB `DISABLE STORAGE IN ROW`, MySQL/InnoDB overflow pages. The engine reads the narrow tuple and follows a pointer to the heavy value **only if needed**. Rationale: narrow rows pack more per page → far better buffer-pool hit rate; the wide column and its expensive full-text index are paid for on demand.
- **Explicit, modeled as two tables sharing a PK:** **vertical partitioning**, Hibernate **`@SecondaryTable`**, Django **`OneToOneField`**, Rails **`has_one`**, and — the closest conceptual and terminological match — **Data Vault 2.0's hub + satellite** (a business-key hub with heavy descriptive attributes hung off it in satellites).

**Why noy-db must use the explicit form.** The transparent form works because the engine can *partially read a row*. A zero-knowledge store cannot: a record is one AES-GCM envelope, opaque and atomic. The only way to get TOAST's benefit under encryption is to make the split a **first-class modeling act — two collections, two envelopes.** Satellite collections are exactly that: the ZK-compatible analog of TOAST / vertical partitioning, done at the collection layer because encryption forbids the storage-engine layer.

## The model

A **satellite collection** hangs off a **base collection**, sharing the base's record id 1:1, and holds the heavy/less-accessed fields. Declared on the satellite:

```ts
collection('msgs',      { /* schema: from, to, subject_short, received_date */ })
collection('msgs_text', {
  satelliteOf: 'msgs',
  fields: ['subject', 'body'],   // the routing table — explicit, sync at declaration
  joined:  'msgs_full',          // registers the full-record joined handle (optional)
  /* schema: subject, body */
})
```

- **Shared key = the record id.** `msgs_text/x` is the satellite of `msgs/x`. The 1:1 pairing is on the id itself, which is what makes every satellite read an O(1) same-id lookup, never a scan. **v1 allows exactly one satellite per base** (Q2, decided post-audit — the pre-audit text was inconsistently 1-vs-N; N-satellites is a deferred, explicitly versioned extension, see § Deferred).
- **Architectural home — archetype-③ (`with-shape/satellites`), decided by audit.** The kernel-surface ratchet stands at 4647/3898/2360 for collection.ts/vault.ts/noydb.ts with the files at 4646/3897/2359 — **one line of headroom each** (`scripts/check-architecture.mjs:689,846,941`). The pairing registry, fan-out, existence checks, and joined proxy therefore live in `with-shape/satellites/*`, declared on `collection({ satelliteOf, fields, joined })` with the implementation lazy-imported (the repo's archetype-③ pattern: schema features declared on `collection()`, impl in `with-shape/*`) *(v1 ships static imports — see § Implementation amendments)*. Kernel files get only thin bus-registered call-sites; any ceiling bump must be explicitly budgeted in the plan and justified per the ratchet doctrine ("register on the bus, not grow these files").
- **The pairing config is persisted, not session-local (audit).** `satelliteOf` / `fields` / `joined` as pure declaration options would drift across app versions (v1 declares `fields: ['body']`, v2 adds `'subject'` → the same logical record splits differently per client; a client that never declares the satellite would not fan out deletes at all). On first declaration the vault persists a **pairing marker** (base name, `fields` hash, `joined` name) into the `_schemas` reserved collection, following the classified config-drift marker pattern (hardened against the lost-update race in `f94b158e`). A re-declaration that mismatches the persisted marker is refused (R-S9); evolving `fields` is a deliberate marker-update operation, not a silent redeclare.
- **The satellite's `fields` list IS the routing table.** A whole-record write routes each key: in `fields` → satellite, everything else → base. One explicit array per satellite (not per-field annotation, so the 70-field case stays ergonomic). *Why not "the schemas are the routing table":* a noy-db `schema` is an opaque Standard Schema v1 validator (`kernel/schema.ts`) — field enumeration exists only via `derivePersistedSchema` (`with-shape/introspection/describe.ts`), which is async, best-effort, and effectively zod-4-only. Routing correctness is a hard invariant, so it must not depend on best-effort introspection. Derivable schema fields and `fieldMeta` keys are used as **cross-checks** on `fields` at declaration (best-effort, async — R-S5), never as the routing source.
- **The base is oblivious and standalone.** `msgs` is defined and usable entirely on its own; its schema/API says nothing about `msgs_text`. Only the vault-level pairing registry (backed by the persisted marker) knows the link, to drive delete/forget fan-out. `msgs.get(id)` returns the hot fields only — **no satellite fetch, no `body` decrypt.** This is the whole point: the cheap read is the default.
- **Base and satellite are both literal, honest collections.** `msgs_text.get(id)` returns satellite fields only; `msgs_text.put(id, { …heavy })` writes satellite fields only, validated by the satellite's own schema (the existing validate-before-encrypt / validate-after-decrypt pipeline runs unmodified on both collections). Neither handle ever carries fields outside its own schema.
- **The full-record access point is a joined handle with its own narrow type.** Declaring `joined: 'msgs_full'` registers a `SatelliteJoinedCollection` proxy: `get(id)` = base ⊕ satellite disjoint field-union merge; `put(id, full)` = split by the `fields` routing table → ordered fan-out with revert (§ Atomicity). **Type story (audit):** the proxy is exported as a dedicated **`JoinedHandle<T>`** type — `get` / `put` / `delete` / `list` / `query` plus a **working `describe()`** (the `@noy-db/ui` contract) — and is *not* typed as `Collection<T>`. The `OverlayedCollection` precedent established the virtual-proxy *pattern* but not the typing: it is returned via an `as unknown as Collection` double cast (`kernel/vault.ts:854`) implementing ~13 of ~50 members, leaving the rest `undefined` at runtime — the joined handle must not inherit that cast. Reactive APIs (`live`, `subscribe`, `query().live()`) are out of scope for v1 and throw "not yet implemented" (parity with overlays); the joined handle exposes no `history`/`diff`/`revert` in v1 (§ History note).
- **1:1 is delete-managed, not create-managed — REVERSED by audit (was: auto-create-null).** A base write does **not** auto-create a physical all-null satellite envelope. Under "absent ≡ all-null" that envelope carries zero information — but it *does* enter version competition: audit finding A2 showed a base-handle put's auto-created satellite v1-null racing an offline peer's real satellite v1 write, where the default conflict tie-break (`legacyResolve` local-wins at `localVersion >= remoteVersion`, `sync.ts:508`) plus the pull-side tie skip (`_v >` false at equality, `sync.ts:243`) can silently clobber the real heavy data and leave the stores permanently diverged. The satellite envelope is born on its **first real satellite/joined write**. This also deletes the create fan-out, its crash window, and the base-write hot-path satellite touch entirely. Deleting the base fans out; `forget()` fans out (§ Security). A satellite write for a non-existent base is refused (R-S6 — best-effort under concurrency, § Pair serialization).

## Operations

| Operation | Behavior |
|---|---|
| **Create / write (base handle)** | `msgs.put(id, { …hot })` writes the base only. **No satellite envelope is created** (absent ≡ all-null covers it). Single-collection write, no fan-out, no crash window. |
| **Write (satellite handle — heavy fields only)** | `msgs_text.put(id, { …heavy })` writes the satellite only, validated by the satellite's own schema. Refused if the base record does not exist (R-S6). |
| **Create / write (joined handle, the "full record" path)** | `msgs_full.put(id, { …hot, …heavy })` splits by the `fields` routing table → **fan-out multi-put with revert**, base leg first (§ Atomicity). Both legs are validated and encrypted **before** the first adapter write. |
| **Read (base, default — cheap)** | `msgs.get(id)` → hot fields only. No satellite envelope fetched or decrypted. Queries/filters on `msgs` never touch the satellite. |
| **Read (satellite — heavy fields only)** | `msgs_text.get(id)` → satellite fields only, `null` if the base row is absent/tombstoned (§ Existence authority). |
| **Read (joined handle — full record)** | `msgs_full.get(id)` → base ⊕ satellite, disjoint field-union merge (two O(1) same-id gets; absent satellite reads as all-null; `null` if the base is absent/tombstoned). |
| **Query the heavy side** | `withSearch(['subject','body'])` lives on `msgs_text` (a normal collection). Full-text runs against the satellite only; results are existence-filtered (§ Existence authority). Filtering base fields stays on `msgs`. |
| **Delete (base or joined handle)** | Deletes the pair — ordered fan-out with revert, satellite leg first (§ Atomicity). |
| **Delete (satellite handle)** | Deletes the satellite row only — the record's heavy fields drop to all-null (per absent ≡ all-null); the base survives. "Clear the heavy side" is a legal, non-surprising operation. |
| **`forget()`** | Fans out across the pair through the **full per-ref purge suite** — **mandatory** (§ Security). |

Each satellite **is a normal collection** for writes, indexing, and storage — `msgs_text` carries the heavy/full-text index; `msgs` stays compact with its own (e.g. `received_date`) index. **Scope honesty (audit, replaces "inherits the whole catalog unchanged"):** satellite *read* surfaces additionally pass through the existence-authority filter (§ below), which is one shared read-path hook — not per-service patches — covering the enumerated v1 surfaces. Services not on that list read the satellite as a plain collection and are documented as out of existence-filter scope.

## Security & lifecycle

- **`forget()` MUST fan out through the full purge suite — hardened by audit.** The single non-negotiable invariant: forgetting `msgs/x` while `msgs_text/x` retains the body is a plaintext leak of exactly the secret `forget` promised to shred (same discipline as the classified/dekResidue work). Three mechanism rules against the actual forget path (`vault.forget(subjectId)`, subject-index-driven, opt-in via `withForgetCascade`):
  1. **Fan-out happens at subject-index ref-resolution, into the same refs list.** Satellite records **never appear in the subject index** — the subject field lives in the base schema and satellite `fields` are disjoint from it. After `lookupSubject` resolves the matching base refs, the forget loop synthesizes a `(satellite, same-id)` ref for every base ref whose collection has a declared satellite — and the synthesized ref **enters the same `refs` list the shred loop iterates**, so it traverses the *entire* per-ref purge suite (`vault.ts:2338-2420`): live-envelope tombstone, history tombstoning, persisted-index side-car purge (`_idx`), lexical-index purge (`_ftindex`), blob shred, `_sealed` classification, `_sealed_cek` prefix-delete, vector purge. This is load-bearing, not pedantry: the satellite is exactly where `withSearch(['body'])` lives, so a tombstone-only satellite shred would leave fully decryptable full-text postings of the erased body. Fail-loud if a synthesized ref cannot be processed (R-S4).
  2. **The synthesized ref inherits the base's `perRecordKeys` classification (audit).** The loop derives `perRecordKeys` from `forgetStrategy.subjects[ref.collection]` (`vault.ts:2296`) — a map that by construction never contains a satellite, so without inheritance a satellite record still under the shared DEK would be tombstoned but **silently omitted** from `unmigratedRecords`, hiding exactly the residue that matters most. The satellite ref carries the base's classification; satellite shred gaps report through the existing `ForgetResult` accounting with no new fields.
  3. **A satellite of a forget-covered base MUST be `perRecordKeys` (R-S7), and retro-coverage requires migration.** A genuine crypto-shred requires the per-record CEK; without R-S7 the heaviest, most sensitive fields would get the weak shred while the hot fields get the strong one — inverted protection. Enforced as a loud declaration-time refusal (never silent auto-enable of a key mode). **Audit addition:** `perRecordKeys` is construction-only (`collection.ts:438`), so adding forget coverage to a base whose satellite *already exists* without it is refused until an explicit satellite CEK migration (the `_applyCutoverTransform` pattern) has run — a refusal alone would leave an un-erasable residue population behind an apparently-covered base.
- **Forget under sync — kill-order DOWNGRADED by audit → [#590](https://github.com/vLannaAi/noy-db/issues/590).** The v2 spec claimed a "standing kill-order": late-arriving satellite writes for a tombstoned base would be "tombstoned on the reconcile pass." The audit confirmed **no such pass exists** — and found worse: `pull()` overwrites *any* local envelope, tombstones included, when the remote carries a higher `_v` (`sync.ts:243→269`; `buildTombstone` keeps `_v` monotonic, `tombstone.ts:45-54`). An offline peer holding a higher-`_v` live envelope resurrects a completed, ledger-attested crypto-shred — **for every collection in the store, today**. This is a family-wide security defect filed as **#590** (pull must treat a tombstone as terminal for its record id); it is neither caused nor fixable by satellites. What this spec pins: (a) forget fan-out shreds both sides *at forget time* through the full purge suite (rules above); (b) post-forget late arrivals are contained **observationally only** (existence-authority rule 1 — the base tombstone makes the pair unreachable through every handle) until #590 lands; (c) when #590's tombstone-terminal pull rule ships, satellites inherit it with zero satellite-specific changes. No satellite conformance vector may claim resurrection *prevention* until then.
- **Atomicity — ordered fan-out with best-effort revert, hardened by audit.** The kernel has **no** true cross-collection atomic write: `putManyAtomic` is private and single-collection (`kernel/collection.ts:3216`); the only multi-collection path is `runTransaction` in the opt-in `with-commit` service, itself pre-flight CAS + best-effort revert with a crash window. Satellites therefore do NOT claim torn-state-freedom; deferred refoundation concern → **#588**. Joined writes and pair deletes execute as an ordered two-collection fan-out (`revertExecuted` pattern). **Audit hardening — the revert story leaks through side channels unless pinned:** `_putInternal` commits, in order, history snapshot → envelope → embeddings `_vec` side-car → ledger → cache/index → sync dirty entry → `change` event → derivations/MVs, while `revertExecuted` restores *envelopes only* and deliberately emits no compensating events (`transaction.ts:594-637`). Therefore: (i) the fan-out **validates and encrypts both legs before the first adapter write**, shrinking the revert window to adapter-I/O failures only — a satellite-schema failure aborts the joined put with zero writes anywhere; (ii) revert is invoked with the `db` reference and emits a **compensating `change` event** per reverted op, and the reverted leg's **sync dirty entry is removed** (else push re-transmits the phantom write); (iii) ledger/history/MV/embedding residue of a genuinely-reverted adapter write is **documented as accepted** — the ledger records what physically happened, including the revert.
- **Pair serialization (audit).** No per-record serialization exists in the kernel write path (the `WriteQueueTracker` is an observability counter, not a lock), so R-S6's base-exists check is a TOCTOU: a satellite put racing a pair delete (which removes the satellite *first*, keeping the base alive precisely while the pair dies) can land a front-door orphan. v1 pins a **pair-level async mutex in the pairing registry** covering satellite put, joined put, and pair delete. Even so, R-S6 is **best-effort under concurrency across clients** — a cross-client race is contained observationally by existence authority, converting a refusal the user should have seen into accepted-then-unreachable data; this is documented, not hidden. CRDT legs would bypass the mutex seams entirely, which is one of the reasons for R-S8.
- **CRDT — refused in v1 (R-S8), resolves Open Q4 (audit).** Envelope-restore over a commutative merge is a lost-update, not an undo: a CRDT-mode put reads-merges-writes unconditionally with no OCC (`collection.ts:1948-2047`), so reverting a fan-out's CRDT satellite leg with a stale prior envelope silently destroys *other actors'* merged operations that arrived between snapshot and revert. The correct compensation for a merge is another merge, which the revert pattern cannot express; CRDT writes also bypass the write-queue and write-hook seams (`collection.ts:1600` TODO). v1 refuses `crdtMode` on either member of a pair; roll-forward-only semantics are a deferred extension (§ Deferred).
- **Rotation** — CEK/DEK rotation is per-collection; base and satellite are independent collections with their own DEKs, so no special coupling beyond the delete/forget fan-out. The `perRecordKeys` question is settled by R-S7 + the retro-migration clause.
- **Threat-model note — the split discloses more envelope metadata than the monolith (audit, accepted for v1).** The untrusted store newly learns, per record id: (a) whether a satellite row exists — a "has heavy content" bit (made *more* informative by dropping auto-create), and (b) the heavy fields' ciphertext size in isolation, correlatable by shared id. Both are invisible in the single-envelope form. Accepted and documented for v1; always-present rows + size padding is a deferred hardening (§ Deferred).

## Convergence & existence authority (resolves Open Q5; revised by audit)

1. **The base row is the sole authority on record existence — with an enumerated enforcement scope (audit).** A base-less (absent or tombstoned base) satellite is **dead ciphertext**. Enforced in v1 by **one shared read-path hook** at these surfaces: `satellite.get` / joined `get` (→ `null`), satellite `list` / `query` (id-filtered against a live-base id set — an undecrypted, envelope-level check), and `withSearch` `retrieve()` on a satellite (post-filter of hits). **Enforced at the envelope layer for export:** `as-noydb` bundle / pod export skip satellite envelopes whose base row is absent/tombstoned — today's export filters only on undecrypted `_ts`/`_tier` (`with-pod/bundle.ts:1042-1059`) and would otherwise ship dead ciphertext *with its wrapped keys* into every future backup. **Not enforced (documented):** sync push (the remote is a dumb ciphertext store with exactly the same trust posture as the local one — a pushed dead envelope is unreachable through every reading hub by this same rule), raw `dumpEnvelopes()`, and any service reading via the raw adapter. The absolutist v2 phrasing "unreachable through every API" is retired; this enumeration is the contract. (Cost note: satellite reads add an *undecrypted* base-envelope existence check — adapter I/O only, zero extra crypto; the cheap base read is untouched.)
2. **Absent satellite ≡ all-null satellite.** The read path never assumes a physically-present satellite envelope; a missing one reads as all-null. Rules 1+2 together make every torn or converging state readable and deterministic: base-only reads as all-null heavy fields; satellite-only reads as nothing.
3. **Fan-out ordering is a LOCAL-store-only guarantee (audit-narrowed).** Joined-write fan-out writes the **base leg first**; pair-delete fan-out removes the **satellite leg first** — a local crash can only leave the safe direction (base-without-satellite ≡ all-null), never a fresh base-less satellite. **But push replay does not preserve this order:** per-entry error isolation (`sync.ts:195-197`) and dirty-log dedup-in-place (`sync.ts:109-111`) mean the remote and other peers can transiently observe base-less satellites with no crash anywhere. Contained by rule 1; the ordering claim must never be cited as a sync-level guarantee.
4. **Resurrection containment — delete is logical; forget is cryptographic.** Verified: `pull()` is snapshot-based and additive (never deletes local rows); plain deletes propagate push-side as bare `remote.delete` with no tombstone → "base deleted" vs "base never synced here" is indistinguishable, so v1 does **not** sweep base-less satellites (no safe evidence; aggressive GC would eat in-flight creates). Rule 1 makes them permanently unreachable instead — exactly the guarantee `delete` has always given. For **forget**, containment is observational-only until **#590** (tombstone-terminal pull) lands; see § Forget under sync.
5. **Conflict granularity is per-collection — joined writes can tear across envelopes (audit).** Sync resolves conflicts per collection+id with per-collection resolvers (`sync.ts:451-496`); base and satellite carry independent `_v`/`_ts`. Two clients writing the same record via the joined handle can converge to base-from-A ⊕ satellite-from-B — a logical record **neither client wrote**. v1 pins: (a) this **field-group conflict granularity is documented** as the joined handle's contract — correlated fields that must move together belong on the same side of the split; (b) registering a conflict resolver for either member of a pair **registers it for both** (declaration-time coupling), removing the divergent-resolver case; (c) a pair-aware resolver that sees both envelopes is a deferred extension (§ Deferred).
6. **Joined reads are not snapshot-consistent under active sync (audit, documented).** Pull applies the pair's records in arbitrary snapshot iteration order via raw `local.put` (no cache invalidation, no change events — `sync.ts:222-241`); a joined `get` racing a pull can merge new hot fields with not-yet-pulled heavy fields. The joined `get` reads via the adapter (not the eager cache) and tolerates mixed versions by design; "the pair is a consistent snapshot" is *not* part of the joined handle's contract.
7. **Partial-sync filters treat a pair as a unit (audit).** `push`/`pull` `collections` filters expand pair-wise via the pairing marker — naming the base implicitly includes its satellite (else a filtered push ships base *deletes* whose satellite deletes are withheld, leaving live-looking heavy envelopes on the remote indefinitely). `modifiedSince` remains able to split a pair by timestamp; documented.

## Refusal matrix

| # | Refused condition | Enforced at | Error |
|---|---|---|---|
| R-S1 | a satellite's `fields` list overlaps the base's fields (refused best-effort via the derivable-schema cross-check, async — see R-S5); v1 has one satellite per base, so cross-satellite overlap is moot until the N-satellite extension | declaration (`collection()` + persisted marker) | `SatelliteConfigError` — routing must be unambiguous |
| R-S2 | *(downgraded — no new hub check)* a joined-handle write's non-satellite keys route to the **base**, where the base's existing validate-before-encrypt refuses genuinely unknown fields iff the base declares a validator; a schema-less base accepts them, exactly as a normal collection does today | base's existing schema pipeline | the base validator's `SchemaValidationError` |
| R-S3 | `satelliteOf` names a non-existent base, or a base that is itself a satellite (no satellite-of-satellite chains) | declaration | `SatelliteConfigError` |
| R-S4 | `forget()` that cannot process a synthesized satellite ref through the full purge suite | forget path | fail-loud (never a partial forget that leaves the heavy side or its indexes) |
| R-S5 | `fields` omitted, empty, or containing the id; `joined` name colliding with an existing collection/virtual name; `fields` contradicting derivable schema info (`derivePersistedSchema` / `fieldMeta` keys), when derivable — best-effort, async, cross-check only | declaration | `SatelliteConfigError` |
| R-S6 | satellite-handle `put` for an id with no base record (orphan prevention; **best-effort under cross-client concurrency** — § Pair serialization) | write path (under the pair mutex) | `SatelliteConfigError` — create the base first (or write through the joined handle) |
| R-S7 | a satellite declared on a base covered by `forgetStrategy.subjects` without `perRecordKeys`; **and** adding forget coverage over a base whose existing satellite lacks `perRecordKeys`, until an explicit satellite CEK migration has run | declaration / `withForgetCascade` config time | `SatelliteConfigError` — loud refusal, never silent auto-enable of a key mode |
| R-S8 | `crdtMode` on either member of a satellite pair (v1 — revert cannot compensate a merge; § CRDT) | declaration | `SatelliteConfigError` |
| R-S9 | a declaration whose (`satelliteOf`, `fields` hash, `joined`) mismatches the persisted pairing marker in `_schemas` (config drift across app versions) | declaration / marker reconcile | `SatelliteConfigError` — evolve the marker deliberately, don't redeclare divergently |
| R-S10 | a base already has a registered satellite — v1 scope limit, not a routing-ambiguity rule (contrast R-S1); retires when the N-satellites-per-base extension lifts the one-satellite-per-base limit | declaration (registry) | `SatelliteConfigError` |

## Integration with existing primitives

- **Feature home** → `with-shape/satellites` (archetype-③), thin bus-registered kernel call-sites, persisted pairing marker in `_schemas` (classified config-drift pattern).
- **Synced writes** → ordered two-collection fan-out reusing the best-effort-revert pattern (`revertExecuted`) with the audit hardening (§ Atomicity: pre-validated legs, compensating events, dirty-entry cleanup) — *not* a true atomic commit; see #588.
- **The full-record handle** → `SatelliteJoinedCollection` exported as `JoinedHandle<T>` (narrow type, working `describe()`), following the `OverlayedCollection` virtual-proxy *pattern* but not its `as unknown as Collection` cast (`vault.ts:854`).
- **Query-layer joins** → the planner's same-id `lookupById` nested-loop (existing; O(1), 1:1 on the shared id) remains available for explicit `.join()`s across the pair; the joined handle's point `get` is two adapter gets + a field-union merge.
- **Field routing** → the satellite's declared `fields` list (explicit, sync); derivable schema info and `fieldMeta` keys as best-effort declaration-time cross-checks (R-S5).
- **Existence filter** → one shared read-path hook (rule 1's enumerated scope) + an envelope-level base-liveness filter in bundle export.
- **Heavy-side query** → `withSearch` / `withIndexing` / MV on the satellite, with search `retrieve()` passing the existence filter.

**History/ledger note (audit, documented):** one joined write produces two version streams and two hash-chained ledger entries; a single-side `revert(id)` on the base creates a version-skewed pair that the joined read merges without warning (by design — rule 6 already disclaims snapshot consistency); a *failed* joined write's executed leg still appends history/ledger entries plus the revert's own. The joined handle exposes no `history`/`diff`/`revert` in v1; pair-coherent history semantics are deferred.

## Shipping obligations (audit — mechanical gates that will otherwise fail merge day)

- `features.yaml` entry (schema-validated — `pnpm validate:features`).
- Bundle-size gate: satellite code must be reachable only behind the `with-shape/satellites` lazy import *(v1 ships static imports — see § Implementation amendments)* — the three CI invariants (floor, cross-leak, per-subsystem) must stay green with satellites unused.
- `check-architecture.mjs`: register the declaration options in the archetype-③ exemption set (or ship a `with*()` factory); budget any kernel ceiling bump explicitly.
- Doc page `docs/subsystems/satellites.md`, SPEC section, subpath export + tsup entry per the SERVICES.md governance checklist.
- Conformance vectors live in the hub package tests (spy-store based); no adapter-conformance changes (stores see only ordinary envelopes).

## Relationship to the cost-model advisor

Satellite collections are the concrete target of the cost-model advisor's flagship recommendation. The advisor observes a collection where a field is large, present in ~100% of records, but projected in a small fraction of reads, and recommends:

> `documents.body` averages 41 KB, present in 100% of records, read in 3% of query projections — you decrypt ~40 KB per scan for a field almost nobody reads. **Recommend:** make `body` a *satellite* of `documents`; add `withSearch(['body'])` if you query its text.

**Scope caveat (audit):** in v1 the recommendation is actionable for **new collections only** — see Non-goals. For existing data the advisor should phrase it as an aspirational restructuring pending the backfill tooling (§ Deferred).

## Non-goals

- **Splitting an existing, populated collection (v1) — audit.** There is no machinery to relocate field values out of live base envelopes (schema-update strategies gate writes, they don't move data; `@noy-db/hub/migrations` is an explicitly reserved future slot, SERVICES.md), and pre-split base envelopes still containing the routed fields would break the joined merge's disjointness premise. v1 satellites apply to collections declared satellite-paired from first write. Resumable encrypted backfill is a deferred extension.
- **1:N relationships** — a satellite is strictly 1:1 on the shared id. A 1:N relationship is a classic `links`/join, not a satellite.
- **Transparent storage-engine off-row splitting** — impossible under ZK (no partial decryption); the explicit two-collection model is the whole point.
- **Sub-record field-level lazy loading inside one envelope** — not achievable; superseded by the satellite split.
- **Cross-vault satellites** — satellites are single-vault. Cross-vault heavy/analytical projection is the klum Insight/shard layer's job, not this feature's.

## Deferred issues & future satellite improvements

Filed (blocking-adjacent, not owned by this feature):

- **Sync `pull()` resurrects forget tombstones — [#590](https://github.com/vLannaAi/noy-db/issues/590) (SECURITY, family-wide).** Pull overwrites tombstones on higher `_v`; voids `forget()` under sync for every collection. Fix direction: tombstone-terminal pull. Satellites inherit the fix with no changes; until it lands, post-forget resurrection containment is observational-only.
- **Sync carries no delete tombstones — [#589](https://github.com/vLannaAi/noy-db/issues/589).** Deletes never converge on pull; any collection's deleted record can be resurrected by an offline peer. Satellites contain it at the read layer; a sync-level tombstone/oplog is the general fix. A real tombstone would also unlock physical GC of dead-ciphertext satellites (below).
- **No kernel cross-collection atomic write — [#588](https://github.com/vLannaAi/noy-db/issues/588).** Satellites are the third feature family re-implementing fan-out/revert per-feature. Refoundation trigger: a fourth feature, or a real torn-pair report.

Future satellite improvements (analysis preserved from the 2026-07-07 audit; file as issues when scheduled):

- **N satellites per base.** Pairwise-disjoint `fields` lists (R-S1 generalizes), joined handle merges base ⊕ *all* satellites, `joined` declarable by at most one satellite of a base, marker becomes a list (retires R-S10, the v1 one-satellite-per-base scope guard). Explicitly a versioned extension of the joined-merge contract — do not slip it in.
- **CRDT pair members (lift R-S8).** Requires roll-forward-only fan-out semantics (never revert a CRDT leg — the correct compensation for a merge is another merge) and a serialization story that does not depend on the write-queue seams CRDT writes bypass (`collection.ts:1600` TODO).
- **Pair-aware conflict resolution.** Upgrade from v1's documented field-group granularity to a resolver hook that sees both envelopes of a pair as one logical record; requires sync-engine pair awareness (resolvers are keyed per collection today, `sync.ts:43,90`).
- **Resumable encrypted backfill ("split an existing collection").** Per-record relocation of `fields` out of live base envelopes under the `hub/migrations` reserved slot; must define merge precedence for the transition window (old-field-in-base vs satellite) and be crash-resumable. Unblocks the advisor's recommendation for existing data.
- **Pair-aware push ordering.** Defer a satellite dirty entry while its base's create entry is pending or errored (per-entry error isolation and dedup-in-place currently void the local write ordering on replay, `sync.ts:109-111,195-197`).
- **Dead-ciphertext sweep.** Physical GC of base-less satellites once delete evidence exists in the sync channel (#589); v1 ships export-side filtering only.
- **Metadata shaping.** Always-present satellite rows + heavy-envelope size padding to close the "has heavy content" bit and heavy-size disclosure (§ Threat-model note).
- **Joined reactive surface.** `live` / `subscribe` / `query().live()` on the joined handle (shared gap with overlay views); plus pair-coherent `history`/`diff`/`revert` semantics.

## Open questions for the owner

1. **~~Base-side opt-in merge.~~ RESOLVED (owner, 2026-07-07):** the joined handle is the single full-record access point; base and satellite stay literal.
2. **~~Multiple satellites per base.~~ RESOLVED (owner, 2026-07-07, post-audit):** v1 = exactly one satellite per base; N-satellites is a deferred, versioned extension (§ Deferred) — the audit found the v2 text inconsistently 1-vs-N, which would have retroactively changed the joined-merge contract.
3. **~~Write-entry ergonomics.~~ RESOLVED (owner, 2026-07-07):** three entry points — base handle (hot fields only, no satellite touch), satellite handle (heavy fields only, base must exist — R-S6), joined handle (full record, split by `fields`, fan-out with revert).
4. **~~CRDT × cross-collection write interaction.~~ RESOLVED (owner, 2026-07-07, post-audit):** refused in v1 (R-S8); roll-forward semantics deferred (§ Deferred).
5. **~~Offline-sync convergence.~~ RESOLVED (owner, 2026-07-07; revised post-audit):** the seven-rule **Convergence & existence authority** block. The 1:1 invariant is eventually consistent *physically* but immediately consistent *observationally* — with the forget-resurrection caveat explicitly parked on #590.

## Conformance vectors (each claim gets a test)

Writes & routing:
- Base-handle `put` writes exactly one envelope and touches no satellite (spy store: 0 satellite ops) — no auto-create.
- Joined-handle write splits by the `fields` routing table; both legs validated/encrypted **before** the first adapter write — an invalid satellite field aborts with **zero** adapter writes on either collection.
- Mid-fan-out adapter failure: executed leg reverted (prior envelopes restored), a **compensating `change` event** is emitted, and **no sync dirty entry survives** for the reverted leg (spy store + dirty-log inspection).
- A non-satellite key routes to the base and is refused by the base's validator when one is declared (R-S2).

Reads & existence authority:
- `msgs.get(id)` fetches exactly one envelope, decrypts no satellite (store-shape: 1 get, 0 satellite gets).
- `msgs_text.get(id)` returns satellite fields only; `msgs_full.get(id)` returns base ⊕ satellite merged (two gets, field-union; both schemas validate unmodified); absent satellite reads as all-null through the joined handle.
- A base-less satellite (base deleted, satellite envelope re-injected) is unreachable through every enumerated surface — `satellite.get` → `null`, joined get → `null`, satellite `list`/`query` exclude the id, satellite search `retrieve()` filters the hit; the dead-ciphertext envelope physically remains (no sweep).
- **Export filter:** an `as-noydb` bundle of a vault containing a base-less satellite excludes that satellite envelope.
- **Store-shape of the existence check:** `satellite.get(id)` performs an adapter-level base get with **zero base decrypts**; `msgs.get(id)` is untouched.
- `JoinedHandle.describe()` works (UI contract); reactive APIs throw "not yet implemented"; no member of the narrow type is `undefined` at runtime.

Delete & ordering:
- Base/joined-handle delete fans out satellite-first; a crash injected after the first op leaves only safe-direction states (delete: satellite gone, base present; joined write: base present, satellite absent ≡ all-null). A fresh base-less satellite is never produced **locally** (fault injection) — and the vector's name says "locally": push-replay ordering is explicitly not asserted.
- Satellite-handle delete removes the satellite row only; base survives; joined read shows all-null heavy fields.
- **Pair mutex:** concurrent `satellite.put` + pair delete serialize — no front-door orphan lands (in-process race test).
- **Partial sync:** `push({ collections: ['msgs'] })` includes `msgs_text` dirty entries (pair-unit expansion).

Forget:
- `forget()` reaches the satellite via a **synthesized ref** (never in the subject index) and runs the **full purge suite**: post-forget the satellite's live envelope, history versions, `_idx` side-cars, `_ftindex` postings, `_vec` entries, `_sealed`/`_sealed_cek` material all carry no data (spy store, per artifact).
- **Residue classification inheritance:** an unmigrated (shared-DEK) satellite record surfaces in `ForgetResult.unmigratedRecords` exactly like a base record — never silently omitted.
- Post-forget, a late-arriving satellite put for the tombstoned base id is unreachable through every enumerated surface (observational containment; resurrection *prevention* vectors are parked on #590).

Refusals & config:
- R-S1 (base-overlap cross-check), R-S3 (satellite-of-satellite), R-S5 (missing/empty/id-bearing `fields`, `joined` collision, cross-check contradiction), R-S6 (orphan put), R-S7 (both clauses: declaration and retro-coverage-without-migration), R-S8 (`crdtMode` on either member), R-S9 (re-declaration mismatching the persisted pairing marker), R-S10 (v1 one-satellite-per-base scope limit).
- The pairing marker persists to `_schemas` on first declaration; a second client with a divergent `fields` list is refused (R-S9) rather than silently splitting records differently.

Conflict granularity (documented behavior, asserted as such):
- Two clients' divergent joined writes can converge to base-from-A ⊕ satellite-from-B; the vector asserts this **documented** field-group granularity and that registering a conflict resolver for one pair member registers it for both.

## Implementation amendments (v1, 2026-07-07)

Four execution decisions made across Tasks 5–11, folded back into the design record (Task 12
reconciliation). None of these revise a resolved owner decision above — each is a v1 scoping
detail discovered while building the rule it implements.

- **Satellite `query()` refuses with `SatelliteConfigError` (Task 5).** Query's terminal methods
  (`toArray`/`first`/`count`) read the in-memory cache **synchronously**, while existence authority
  (§ Convergence & existence authority, rule 1) requires an **async**, undecrypted check against
  live base state — the two shapes don't compose without either breaking `query()`'s synchronous
  contract or accepting a check that can miss an out-of-band base mutation. `list()`/`get()` remain
  existence-safe (async, checked per call); `search`/`retrieve`/`similarTo` get their own existence
  post-filter (Task 9) since they answer from the search facade's own cache/index, not the proxy's
  get/list overrides.

- **Bundle export filter degrades leak-on-error, never drop-live-data (Task 10).** The `as-noydb`
  bundle export excludes base-less (dead-ciphertext) satellite envelopes (§ Conformance vectors,
  "Export filter"). If the liveness check against the base itself errors mid-export, the filter's
  posture is to **include** the satellite envelope (leak-on-error) rather than **exclude** it
  (drop-on-error) — an operator can always re-run `forget()`/a sweep to close a leaked dead
  satellite, but a wrongly dropped *live* record is unrecoverable data loss. This also discloses a
  **first-declaration marker-race window**: between a satellite's first `declareSatellite()` call
  writing the pairing marker to `_schemas` and that write becoming durable, a concurrent export
  reading a not-yet-marked collection treats it as a plain collection (no existence filtering
  applied at all) rather than as a satellite — a narrow, session-scoped race, not a persistent gap.

- **`pushFiltered`/`SyncTransaction` predicate paths are outside pair-unit expansion (Task 11).**
  Pair-unit dirty-entry expansion (a base's sync push carries its satellite's pending entries too,
  per § Conformance vectors "Partial sync") covers the ordinary `push({ collections })` allow-list
  path. `pushFiltered`'s per-record predicate and `SyncTransaction`'s explicit entry list are
  **not** expanded to their pair partner — a predicate or transaction that selects a base record
  does not implicitly pull in its satellite row. Both are documented out-of-scope for v1; a caller
  using either path against a satellite pair is responsible for including both collections itself.

- **Conflict-resolver pair-coupling is base-canonical on pre-pairing ties (Task 11).** Registering a
  conflict resolver for one pair member mirrors it to the other (§ Conformance vectors, "Conflict
  granularity"). If a resolver is registered on the satellite *before* the pair exists (no base
  declared yet, or declared after), retroactive mirroring at pair-registration time resolves any tie
  between a pre-existing base-side resolver and the satellite-side one in favor of the
  **base's** resolver — base-canonical, not last-write-wins — since the base is the existence
  authority for the pair (rule 1) and its conflict policy is the one already governing the pair's
  observable identity.

- **The archetype-③ implementation ships as STATIC imports from the kernel call-sites, not
  lazy-imported (Task 12 reconciliation).** § Architectural home and § Shipping obligations above
  describe the implementation as reachable only behind a `with-shape/satellites` lazy import; v1
  does not ship that. `kernel/vault.ts` statically imports
  `declare`/`proxy`/`registry`/`joined`/`types`/`forget` — matching the classified/i18n/links
  family precedent and grandfathered per-specifier in `check-architecture.mjs`'s
  `PRE_EXISTING_SPINE_SERVICE_IMPORTS` (port-layering). Consequence: satellite engine code
  (registry, proxies, fan-out, joined handle, ref expansion) ships in **every** consumer bundle
  (floor +2.4% gz, within the bundle-size gate's tolerance — the gate stays green because ③
  schema features were never floor-excluded). Only marker persistence, post-register schema
  derivation, and persisted-schema reads are genuinely lazy (`await import` in `marker.ts`,
  `post-register.ts`, `dead-filter.ts`). Why: the declaration path (validate → R-S7 → registry
  registration) must run **synchronously inside `vault.collection()`** — a sync API — which
  precludes a lazy (async-import) spine for the core machinery. True lazy-loading of the
  proxy/fan-out engines behind the declaration seam remains a possible future optimization
  (shared with the #553 lazy-import debt the money/computed/classified ③ siblings already carry).

- **The persisted pairing marker gains a `epoch` field, additive-only (#597, 2026-07-14).** The
  marker is keyed purely by collection name (`_schemas/<name>`), with no tie to a collection's
  *lifetime* — since noy-db has no delete-collection API today, this is latent, not reachable, but
  worth closing before it becomes a footgun. `PairingMarker.epoch` (`with-shape/satellites/types.ts`)
  and its classified twin `ClassifiedMarker.epoch` (`kernel/types.ts`) are an optional ISO-8601
  timestamp minted the first time a marker is ever persisted for a given collection name, and
  carried forward unchanged on every later re-declare of the SAME collection (`marker.ts`'s
  `ensureSatelliteMarker` only mints a candidate epoch for the branch where no prior marker exists;
  `satelliteMarkersEqual`/the classified `markersEqual` in `with-shape/persisted-schemas/register.ts`
  deliberately exclude `epoch` from equality, so a live collection re-declaring itself still hits the
  existing "same marker, no-op" fast path and never overwrites the persisted epoch). **The
  epoch-MISMATCH REJECTION itself is deferred** — there is nothing to reject against yet, since a
  name can't currently be freed and reused. Wiring that check is a follow-up for whenever a
  delete-collection API ships.
