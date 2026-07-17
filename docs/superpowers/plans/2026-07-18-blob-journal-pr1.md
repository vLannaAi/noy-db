# Blob Durability Journal PR-1 — primitives + crash-safe shred (#753) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the journal primitives (two-tier loader mode, stamp-aware CAS with the `lastOps` ring and completion rule, the `_blob_intent` marker plumbing) and make `shredAllForRecord` crash-idempotent (#753), per the reviewed spec.

**AUTHORITY:** `docs/superpowers/specs/2026-07-18-blob-durability-journal-design.md` — §2 as amended by **§7 (v2 corrections C1-C11, Q1/Q3)**. Where this plan and the spec disagree, the spec's §7 governs. PR-2 (rehome #746, supersession, #756 rider) follows separately on these primitives.

**Tech Stack:** TypeScript ESM, vitest, `crypto.subtle`/`crypto.getRandomValues` only.

## Global Constraints

- Branch `fix/753-blob-shred-journal` off main. Files: `blob-set.ts` (no ceiling), `kernel/types.ts` (no ceiling), `with-pod/backup.ts` (allowlist), `kernel/vault.ts` (CEILING 3959 metric EXACT — the forget() marker call must be ≤1-2 funded lines; heavy logic in blob-set/tiers helpers).
- Never add Claude attribution. Hub portable. TDD with crash-injection (adapter wrappers that throw after N ops — the #725 test pattern).
- The marker: reserved collection `_blob_intent`, key `{collection}::{recordId}` (C11), encrypted under the collection tier-0 DEK (§4), CAS create-if-absent (C8), content-bearing (C9 — document as the first of its kind).

---

### Task 1: two-tier loader mode + stamp-aware CAS primitives

**Files:** `blob-set.ts` (`loadBlobObject`, `casUpdateRefCount`, `releaseRef`), `kernel/types.ts` (BlobObject).

1. `loadBlobObject` gains an explicit two-tier mode: `loadBlobObject(eTag, tier, alsoTryTier?)` — try `tier`'s DEK, on `TamperedError` try `alsoTryTier`'s (today's `t>0`→flat fallback becomes the special case `alsoTryTier=0`; `t===0` callers may now pass an elevated alsoTry). Returns `atTier` as today. Unit-test all four (opens-at-from / opens-at-to / opens-at-neither / flat) outcomes.
2. `BlobObject` gains `readonly lastOps?: readonly string[]` (C2 — bounded ring, K=8, append-in-CAS; doc comment states K as an audit-visible concurrency bound and the stale-stamp-on-retained acceptance).
3. Stamp-aware CAS: `casUpdateRefCount(eTag, delta, tier?, stamp?: string)` — INSIDE the retry loop (C4), every (re)read first checks `blob.lastOps?.includes(stamp)` → return the sentinel `'already-applied'` (adjust the return type; callers today expect the new count — use a discriminated return or a distinct method `casUpdateRefCountStamped` returning `{ applied: boolean; refCount: number }`, implementer's call, type-clean). When applying: append stamp to the ring (evict oldest beyond K=8) in the SAME object write as the delta.
4. `releaseRef(eTag, n, reclaimLegacy, tier?, stamp?)`: with a stamp — two-armed resume rule (C1): already-stamped && refCount > 0 → `'retainedShared'`-equivalent skip; already-stamped && refCount <= 0 → COMPLETE the index+chunk deletion idempotently (chunkCount from the caller/marker when the index row is already gone) and report shredded.
5. Tests: concurrent-CAS (two writers, one stamp → exactly one applies); ring eviction at K; the C1 completion arm (delete index row manually post-decrement, re-run with stamp → chunks cleaned).

Commit: `feat(hub): stamp-aware blob refCount CAS + two-tier object loads — the journal primitives (#753 spec §7)`.

---

### Task 2: `_blob_intent` marker plumbing

**Files:** new `packages/hub/src/with-shape/blobs/blob-intent.ts` (codec + CAS-create + delete + sweep), `with-pod/backup.ts` (allowlist), `blob-set.ts` (entry-gate helper).

1. `BlobIntent` type per spec §2a + C5 (`holds` entries carry `{ eTag, n, chunkCount }`), key grammar C11. Codec encrypts under `getDEK(collection)` (tier-0), envelope shape mirroring the version-record writes. `createIntent` = CAS create-if-absent (expectedVersion on absent row); present → throw a typed `IntentPendingError`-style signal the caller converts into resume-first (C8).
2. `dumpVault`'s `internalNames` allowlist gains `_blob_intent` (Q3). Note in the commit body: `_mv_stale` does NOT travel today — observed, tracked on #761, not fixed here.
3. Sweep: `sweepBlobIntents(adapter, vault, getDEK, resume)` — lists `_blob_intent`, resumes each (used by forget-entry; vault-open wiring can be PR-2 if the seam is awkward — say so in the report).
4. Tests: create-if-absent refusal; codec round-trip; allowlist (dump carries the marker).

Commit: `feat(hub): _blob_intent journal marker — encrypted CAS-created intent rows + backup allowlist (#753 spec §7)`.

---

### Task 3: shred journal (#753)

**Files:** `blob-set.ts` (`shredAllForRecord` + resume + entry gates), `kernel/vault.ts` (forget() marker mint — CEILING), `with-audit/tiers` only if an entry gate needs it.

1. `forget()` mints the marker PRE-tombstone (C5): before `_writeTombstone`, one funded call (helper does the work: collect holds incl. chunkCounts from the live slot map + version rows at the pre-tombstone tier, mint opId via `crypto.getRandomValues`, CAS-create marker). If a marker already EXISTS for the ref: resume it first (same helper), then proceed fresh.
2. `shredAllForRecord` consumes the marker: holds from the MARKER (not rows) when present; each release via the stamped CAS with the marker's opId; then rows; then marker delete. When called without a marker (defensive/legacy paths): mint one at entry (same helper) so the crash matrix holds regardless of caller.
3. Resume gate on every refCount/slot mutator (C6): `put`/`publish`/`adoptExternal`/`delete`/`deleteVersion`/`setExternalMeta`/`rehomeForTier`/`migrate` check-and-resume a pending SHRED marker first (one shared private `resolvePendingIntent()`; rehome markers are PR-2 — for now a pending 'rehome' marker throws a clear not-yet-supported error documented as the PR-1/PR-2 seam). Resume returns the standard `{shredded, retainedShared, residue}` shape from marker-derived holds (C6 classification).
4. No swallowed releases under a marker (C10): within marker-governed execution, release failures surface as residue or keep the marker alive — audit the `.catch(() => {})` sites reachable from the shred path (delete()'s old-eTag release is NOT marker-governed in PR-1 — leave, note).
5. Crash-injection matrix tests (spec §5 + §7): crash after k of n releases → resume → co-owner keeps its refCount (THE regression); crash post-decrement pre-index-delete → C1 completion arm; crash pre/post marker rows; new-generation same-eTag re-shred not skipped; forget-entry resume of an elevated record's stranded marker (the C5 window — marker minted pre-tombstone makes tier-N holds recoverable); two-resumer concurrency via interleaved adapters (C4).

Commit: `fix(hub): shredAllForRecord is crash-idempotent — intent marker + stamped releases, forget() mints pre-tombstone (#753)`.

---

### Task 4: guards + changeset + close-out

1. Full verification: hub test/typecheck/lint/check:architecture; ceilings exact (vault.ts!). Bundle check: `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check` — the journal adds real bytes to the blobs/history-adjacent chunks; if a scenario exceeds tolerance, STOP and report the numbers (do NOT self-accept a baseline).
2. Changeset `.changeset/blob-shred-journal.md`:

```md
---
"@noy-db/hub": patch
---

Crash-safe blob erasure (#753). `shredAllForRecord` (the `forget()` blob arm) is now journaled: `forget()` mints an encrypted intent marker (reserved `_blob_intent` collection) BEFORE the tombstone, each refCount release is stamped atomically in its CAS write (bounded `lastOps` ring on the `BlobObject`), and every blob mutator resumes a pending shred before proceeding. A crash at any point — mid-release, between a decrement-to-zero and its chunk deletion, before or after row deletion — now resumes to exactly-once semantics: a co-owned blob can never be over-released by a retry (the destructive case), and an elevated record's holds are never stranded by the tombstone (the permanent-leak case). Markers travel in backups; two-tab terminal-race residue is documented. Rehome journaling (#746) and migrate() tier-awareness (#756) follow on these primitives.
```

3. Commit anything tracked.

## Self-Review Notes

- The PR-1/PR-2 seam (pending 'rehome' marker → clear error) is deliberate: shred must not guess at rehome resume semantics before PR-2's stamped increments (C3) exist.
- vault.ts's forget() already resolves the ledger pre-loop (#734's hoist); the marker mint slots beside the existing pre-shred reads — the helper must keep the call site to funded lines.
