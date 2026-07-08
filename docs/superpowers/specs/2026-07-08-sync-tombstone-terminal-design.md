# Sync tombstone-terminal rule — design (#590 + #598)

**Date:** 2026-07-08
**Issues:** [#590](https://github.com/vLannaAi/noy-db/issues/590) (security: pull overwrites forget tombstones), [#598](https://github.com/vLannaAi/noy-db/issues/598) (sync-applied envelopes bypass the Collection cache)
**Milestone:** Sync convergence & tombstones [api·port?] — this design resolves the `port?`: **no `/adapter` change**.

## Problem

`vault.forget()` crypto-shreds a record by rewriting its live envelope to a tombstone
(`{_noydb, _v, _ts, _by?, _iv:'', _data:''}`, `_cek` dropped — the omission *is* the
erasure; `kernel/enclave/record-keys/tombstone.ts`). Sync voids that promise two ways:

1. **Pull is tombstone-blind** (`with-party/team/sync.ts` `pull()`): any remote envelope
   with `_v` greater than the local one is applied verbatim. An offline peer holding a
   live copy at a higher `_v` overwrites the tombstone with decryptable plaintext
   (its own `_cek` intact) — after a completed, ledger-attested shred.
2. **The shred never propagates**: `_writeTombstone` (`kernel/collection.ts:2957`)
   writes via a raw adapter put and never enters the sync dirty log. The remote keeps
   the pre-shred live envelope indefinitely, even with no concurrent edit; any pull
   resurrects it locally.

Additionally (#598), every sync-applied local write (`pull()` applies, conflict
winners in `push()`/`pull()`/`pushFiltered()`) bypasses `_invalidateCacheEntry`, so an
eager Collection cache serves stale — for tombstones, still-decrypted — records for the
rest of the session.

## Approaches considered

- **A. Tombstone-terminal rule in `SyncEngine` + pull-side re-assert + forget enters
  the dirty log** — chosen. Pure hub change; reuses the existing tombstone envelope
  shape; converges in both directions and both sync orders.
- **B. Sync-level erasure/delete oplog** (the #589 structural fix, generalized) —
  rejected for now: #589's exit criteria defers it to the next sync-engine structural
  iteration; #590 is fixable today without it.
- **C. Pull-only enforcement, no re-assert** — rejected: the remote keeps a
  resurrectable envelope until some other peer pulls; fails #590's exit criteria
  ("tombstoned everywhere, both orders").

## Design

### 1. Recognition — `isTombstoneShape`

New pure predicate beside `buildTombstone` in `kernel/enclave/record-keys/tombstone.ts`:

```ts
isTombstoneShape(env) === (env._data === '' && env._cek === undefined)
```

Collection-independent — sync has no per-collection `encrypted` flag, and doesn't need
one: no real record serializes to empty `_data` (JSON bodies are non-empty; the
`_sync/meta` envelope carries non-empty `_data`). The existing
`isTombstone(env, encrypted)` read-path predicate is untouched.

**Seam impact: none.** The tombstone is already an ordinary `EncryptedEnvelope` that
round-trips through every store. No `/adapter` type or contract change; the milestone's
`surface: port?` label resolves to plain `api`.

### 2. Terminal rule in `SyncEngine`

Enforced at every compare point, **before any resolver runs**:

| Situation | Behavior |
|---|---|
| Pull: local tombstone, remote live (any `_v` — higher, equal, lower) | Never apply. **Re-assert**: put the tombstone to the remote with `_v = max(local._v, remote._v)`, fresh `_ts` when bumped, original `_by` preserved; update local to the same `_v`. Report the suppressed remote envelope. |
| Pull: remote tombstone, local live | Apply the tombstone locally regardless of `_v`, drop any dirty entry, invalidate caches. Report the suppressed local envelope **only when it was dirty** (an actual local edit was lost); a non-dirty stale copy is a plain apply, not a suppression. |
| Push: the local envelope for a dirty entry is a tombstone | **Unconditional put** — no CAS `expectedVersion`, no conflict path. A tombstone push is an erasure assertion; erasure always wins. |
| Push `ConflictError` path (`push`/`pushFiltered`): remote is a tombstone | Enforce locally, complete the entry, report the suppressed local envelope. Per-collection resolvers and the db-level `ConflictStrategy` are **never consulted** — a resolver must not overrule a ledger-attested erasure. |
| Pull `modifiedSince` filter | **Remote tombstones are exempt** — an arriving erasure is never skipped by partial sync. (A local-tombstone re-assert can be deferred by `modifiedSince` filtering of the remote live copy; the next full pull — or the push channel — covers it.) |
| Both sides tombstones | Keep the higher `_v`; no report. |

The `_v`-bump on re-assert keeps per-key version monotonicity on each store; the
terminal rule itself never depends on `_v`.

### 3. Propagation — forget enters the dirty log

`_writeTombstone` additionally calls `this.onDirty?.(this.name, id, 'put', live._v)`
so the shred rides the normal push channel immediately. The pull-side re-assert is the
convergence backstop for peers that only ever pull.

**Accepted window (documented):** any client whose push precedes its pull can transiently
resurrect the *remote* copy — including the CAS-matching case: `buildTombstone` keeps the
displaced `_v`, so a peer that edited once from the same base passes the `expectedVersion`
check and overwrites the remote tombstone **silently and unreported** (no ConflictError, so
the push-side enforcement never fires), and its own next pull does not repair the remote
(equal `_v` → skip). Convergence still holds: the first sync by any tombstone-holder
re-tombstones the remote via pull re-assertion. `sync()` (pull-then-push) protects the
default path; a dumb ciphertext store cannot enforce this server-side.

### 4. Reporting (api-additive)

- New type `ErasureEnforcement { vault, collection, id, tombstone, suppressed,
  direction: 'pull' | 'push' }` in `kernel/types.ts`; `suppressed` is always the
  concrete live envelope that lost (never null — unreported enforcements are
  plain applies).
- New optional `erasures?: ErasureEnforcement[]` on `PullResult` and `PushResult`
  (optional so existing constructors of these types stay valid; the engine always
  sets it).
- New `'sync:erasure'` event in `NoydbEventMap`.
- Exported from the main hub entry only — **not** added to the `/kernel`, `/cargo`,
  or `/adapter` seams (verified: none of them export the sync result types today;
  the golden surfaces stay byte-identical).

Deliberately **not** a `Conflict`: conflicts carry `resolve()` semantics and resolver
routing, which erasure enforcement must never have.

### 5. #598 — sync-applied writes invalidate the Collection cache

New `setCacheInvalidator(fn)` on `SyncEngine` (same injection pattern as
`setPairExpander`), wired where the vault attaches the sync engine, using the existing
recipe from `vault.ts` (`_invalidateCekCacheEntry` + `_invalidateCacheEntry`).
No-op for collections never instantiated in this session. Every sync-applied local
write calls it: pull applies, conflict `remote`/`merged` applies in
`push`/`pull`/`pushFiltered`, and tombstone enforcement.

### 6. Testing (TDD; tests first per repo convention)

Vectors in the hub sync test suite:

1. **#590 exit-criteria vector**: forget on A + higher-`_v` offline edit on B +
   bidirectional sync in *both orders* → record tombstoned on A, B, and the remote;
   B's edit reported via `erasures` + `'sync:erasure'`, never silently applied.
2. **No-concurrent-edit propagation**: after forget on A, the remote is tombstoned via
   push (dirty-log path) and, independently, via pull re-assert (backstop path).
3. **Resolver bypass**: an LWW / custom / manual resolver that would pick the live side
   is not invoked for tombstone pairs.
4. **`modifiedSince` exemption**: a tombstone older than the cutoff still applies.
5. **Equal/lower `_v` re-assert**: remote live at `_v` equal to or below the tombstone's
   is still re-tombstoned (covers propagation-never-happened).
6. **#598 vectors**: eager-cache `get()` after a pull-applied newer envelope returns
   the new record; after tombstone enforcement returns `null`; CEK cache evicted for
   `perRecordKeys` collections.

## Out of scope (unchanged)

- #589 delete tombstones / sync oplog.
- History dead-ciphertext retention (history under a shredded CEK is already
  undecryptable; physical GC stays as-is).
- Satellite pairing interplay — the satellites kill-order rule downgraded by audit
  finding A1 can be revisited once this lands.
