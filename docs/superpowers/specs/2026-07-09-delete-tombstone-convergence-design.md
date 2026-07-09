# Delete-tombstone convergence — design (#589, Spec 1 of 2)

**Date:** 2026-07-09
**Issue:** [#589](https://github.com/vLannaAi/noy-db/issues/589) (sync carries no delete tombstones — deletes never converge on pull; offline peers resurrect deleted records)
**Milestone:** Sync convergence & tombstones — this design resolves the `port?` to **`port`** (an additive `/adapter` envelope field; see §1).
**Spec 2 (deferred):** [#604](https://github.com/vLannaAi/noy-db/issues/604) — period-close lifecycle + operator purge/archive, milestone *Retention: purge, GC & archival*. Consumes the purge seam this spec ships (§4).

## Problem

Ordinary `collection.delete()` is a physical, one-way removal: `_doDelete` calls
`adapter.delete(vault, collection, id)` (`kernel/collection.ts:2849`), for both encrypted and
unencrypted collections — no marker survives, so **absence is the only durable trace**. Sync makes
this non-convergent:

- Deletes propagate **push-side only**, as a bare `remote.delete(vault, collection, id)` with no
  version check and no marker (`with-party/team/sync.ts` push; mirrored in `pushFiltered`).
- `pull()` is **snapshot-additive**: it iterates `remote.loadAll()` and only ever `put`s; it never
  removes a local row that is absent from the snapshot. A record deleted upstream simply stops
  appearing — invisible to every other puller.

Consequence: after the remote envelope is gone there is no evidence a delete happened. "Deleted" is
indistinguishable from "never synced here", and any peer holding a stale local copy (or making a
concurrent unrelated edit and re-pushing) resurrects the record. This affects **every** collection
under sync.

This is distinct from `forget()` crypto-shred tombstones (#590), which *do* converge — because
`_writeTombstone` does a `put` of a tombstone envelope, not a `delete`. That machinery is the
template; this spec applies it to ordinary deletes with different (version-ordered, not terminal)
semantics.

## Ground truth (from the #589 code exploration)

- The sync engine has **no peer / watermark / vector-clock / acknowledgement state** anywhere. It is
  strictly one-local ⇄ one-remote per `SyncEngine`; multiple targets run as independent, oblivious
  engines. There is no primitive on which to build "GC once every peer has seen it" — and in a
  serverless zero-knowledge system nothing can compute the peer set. **This is why retention is
  never-auto-GC + an operator-asserted purge, not consensus GC** (see §4, and #604).
- The only pull-visible "deleted" signal the store contract can carry is a `put()`-based tombstone
  envelope; `NoydbStore` has no soft-delete flag. So a converging delete must be a `put`, not a
  `delete`.
- `pull()` never calls `listSince`; it always `loadAll`s and filters client-side. No incremental
  changefeed exists today.

## Decisions (settled in brainstorming)

1. **Retention:** never auto-GC. Delete markers are permanent until an explicit operator purge.
   Provably no resurrection (matches #590's safety bar); zero new peer machinery.
2. **Semantics:** version-ordered (not terminal). A legitimate re-create of the same id at a higher
   `_v` resurrects it — that is what keeps `delete()` distinct from `forget()`. Guaranteed
   non-resurrection is `forget()`'s job, not `delete()`'s.
3. **Tie rule:** a true concurrent delete-vs-edit at the **same `_v`** routes to the collection's
   conflict resolver if one is configured; otherwise **delete wins**.
4. **Scope split:** this spec ships the marker primitive + a minimal purge seam. The period-close /
   archive / summaries subsystem is #604 (Spec 2).

## Design

### 1. The delete marker + seam impact

A delete marker is an envelope:

```ts
{ _noydb, _v: existing._v + 1, _ts, _iv: '', _data: '', _del: true, _by? }
```

minted at `existing._v + 1` (a real version bump — unlike `buildTombstone`, which keeps the displaced
`_v`, because a delete must be able to lose to a higher-`_v` re-create). Recognized by a new pure
predicate:

```ts
isDeleteMarker(env) === env._del === true
```

**Distinct from the forget crypto-shred tombstone**, which stays `isTombstoneShape(env) === env._data
=== '' && env._cek === undefined`. The two must never overlap — they have opposite convergence
semantics (forget = terminal, delete = version-ordered) — so `isTombstoneShape` gains a
`&& env._del !== true` guard, and a delete marker is never treated as a crypto-shred anywhere in the
sync terminal-rule logic or in `isTombstone()`.

**Seam impact — `surface: port` (additive).** `EncryptedEnvelope` (published on the
`@noy-db/hub/adapter` seam) gains an optional `readonly _del?: true`. Additive and non-breaking for
stores that round-trip whole envelopes (memory / file / browser-idb). **But** a structured store in
`noy-db-to` that maps envelope fields to columns could silently *drop* an unknown field, which would
make a marker round-trip as a live record and break convergence on that store. Therefore:

- the `adapter-conformance` harness gains a **"round-trips `_del`"** vector (every `to-*` store must
  preserve it), and
- `noy-db-to` stores are audited against the new vector (a conformance pass; a coordinated release
  only if a store actually drops the field).

This resolves the milestone's `port?` → `port`. Update on merge: `#589` label `surface: port?` →
`surface: port`; milestone tag `[api·port?]` → `[api·port]`.

### 2. Write path — `delete()` writes a marker

`_doDelete` writes the marker via `adapter.put(vault, collection, id, marker, /* expectedVersion */
existing._v)` **instead of** `adapter.delete(...)`, **only when sync is active for the vault** —
gated on `this.onDirty` being defined (true exactly when the vault has ≥1 sync target;
`noydb.ts` wires `onDirty` only then). A local-only collection keeps the physical
`adapter.delete()`: **zero regression, and no permanent markers for users who cannot converge
anyway.**

- Delete-of-absent short-circuits as today (`_internalDelete` already returns early); a marker is
  written only when a live record exists.
- History-snapshot-before-delete and the ledger `op: 'delete'` append are unchanged.
- The change is tracked on the sync dirty log as a **`put`** of the marker (mirroring
  `_writeTombstone`'s `onDirty(..., 'put', live._v)`), **not** the old `action: 'delete'`. This
  **retires the bare `remote.delete` push path** for ordinary deletes — which, as a side effect,
  closes the #590 review note where a dirty `delete` entry could wipe a remote forget-tombstone via
  bare `remote.delete`.
- **Read-path filtering:** every read treats a delete marker as absent — `get` → `null`, and `list`
  / `query` / aggregates / index maintenance / `loadAll`-consumers exclude it — extending the
  existing forget-tombstone filtering (`isTombstone`) to also short-circuit on `isDeleteMarker`, at
  the same pre-decrypt choke point (encrypted and unencrypted alike), so the empty-`_data` marker
  never reaches a decrypt attempt.
- **Re-create version continuity:** a `put` that re-creates a deleted id must version off the **raw
  stored marker**, minting `marker._v + 1` — exactly as a write over a forget tombstone continues
  from the tombstone's `_v`. This is what guarantees a re-create wins convergence (its `_v` exceeds
  the marker's). The write path already reads the raw stored envelope for versioning, so it sees the
  marker's `_v` even though every *read* API presents the id as absent; the design must keep those
  two views distinct (raw `_v` for the writer, filtered-`null` for readers).

### 3. Sync convergence

**Push** sends the marker as an ordinary envelope `put` with `expectedVersion = existing._v` — real
CAS, unlike today's unchecked `remote.delete`.

**Pull** dispatch order for each record (extending the current terminal-rule ladder):

1. **Forget-tombstone terminal** (unchanged, #590) — a crypto-shred tombstone wins regardless of
   `_v`, in both directions. Erasure outranks delete: a delete marker meeting a forget tombstone
   loses.
2. **Delete marker, version-ordered** (new):
   - `marker._v > local._v` → apply the marker (record converges to deleted).
   - re-create: a live envelope at `_v > marker._v` → live wins, id resurrects.
   - **tie** (`marker._v === local._v`, one side a marker and the other a live edit) → route to the
     collection conflict resolver if configured; else **delete wins**.
3. **Normal version comparison** (unchanged) for live-vs-live.

A winning marker is applied locally via **`put`** (persist the marker — *not* physical
`local.delete`) so convergence is **transitive** across sync topologies; the #598 cache invalidator
fires so no reader sees a stale decrypted value. Delete markers are **exempt from the `modifiedSince`
filter** (like forget tombstones), so a delete is never skipped by partial sync.

### 4. Purge seam (for #604)

A minimal, tested internal primitive:

```ts
vault._purgeDeleteMarkers(before: ISOTimestamp, collections?: string[]): Promise<number>
```

enumerates delete markers with `_ts` strictly older than `before` and physically removes them
(`adapter.delete`), returning the count and emitting a ledger / event record. Scoped to **delete
markers only** — forget tombstones and history are untouched (their retention is #604's call).

Its doc carries the load-bearing invariant **loudly**: *purging a marker re-opens the #589
resurrection window for any peer offline since before the cutoff; never-GC is safe precisely because
the marker is always present to win convergence. This primitive is an operator-asserted safe-point
only — #604's period-close lifecycle is what earns the assertion.* Shipping it here (with tests)
makes the marker lifecycle end-to-end verifiable (create → converge → purge) and gives #604 a clean
hook; the period/summary/cold-archive machinery is **not** in this spec.

### 5. Testing

Convergence vectors (hub sync suite):

1. **Core bug:** delete on A converges to B on pull — B no longer sees the record without a re-open.
2. **Re-create resurrects:** delete then `put` the same id → higher `_v` live envelope wins on pull.
3. **Concurrent delete-vs-edit tie:** same-`_v` marker vs live edit → resolver path (configured) and
   delete-wins default (unconfigured).
4. **Delete marker meets forget tombstone:** forget wins (terminal outranks version-ordered).
5. **`modifiedSince` exemption:** an old delete marker still applies under partial sync.
6. **Transitive convergence:** a pulled-and-applied marker persists as a marker (re-pushes / re-pulls
   correctly), never collapses to physical absence.
7. **Non-synced collection:** deletes stay physical `adapter.delete` — no marker, no regression.
8. **Read-path filtering:** `get`/`list`/`query`/aggregate all treat a marker as absent.

Seam: **adapter-conformance `_del` round-trip** vector (every `to-*` store preserves the field).

Purge: `_purgeDeleteMarkers` removes only markers older than the cutoff (count correct, live records
and forget tombstones untouched, filtered-out ids gone).

#598 cache invalidation already covers marker applies (no new wiring).

## Deferred to Spec 2 (#604) — period-close / retention

Recorded here so the intent isn't lost: a period lifecycle **open → closed** (no more writes,
end-of-period **summary** produced, **re-openable**) **→ frozen** (delete markers physically purged,
live records compressed / optimized for cold usage, **only summaries kept hot**; manual or scheduled
trigger). It consumes `_purgeDeleteMarkers`. Cutoffs by date or duration-back-from-now. Cold-archival
tiering may need a storage-adapter capability, which is why #604's milestone carries `port?`. Full
scope and the interaction with history, the ledger, forget tombstones, and satellite dead-ciphertext
GC (#591/#597) belong to #604's own brainstorm.

## Out of scope (unchanged)

- Automatic / consensus GC (no peer-ack primitive exists; deliberately replaced by operator purge).
- `listSince` incremental pull (pre-existing `loadAll` behavior; a separate optimization).
- The period/summary/archive subsystem (#604).
