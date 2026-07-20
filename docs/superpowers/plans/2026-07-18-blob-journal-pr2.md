# Blob Durability Journal PR-2 — resumable rehome (#746) + supersession + migrate() rider (#756) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `rehomeForTier` (the tier-move blob rehome) crash-atomic and resumable (#746) on the PR-1 journal primitives, resolve shred/rehome supersession (spec Q1), and land the `migrate()` tier-awareness rider (#756).

**AUTHORITY:** `docs/superpowers/specs/2026-07-18-blob-durability-journal-design.md` — §2d + **§7 corrections C3, C7, C10, Q1** govern. Builds on PR-1 (#753, merged): `_blob_intent` marker (`blob-intent.ts`), `casUpdateRefCountStamped`, `BlobObject.lastOps` ring, two-tier `loadBlobObject(eTag, tier?, alsoTryTier?)`, `resolvePendingIntent` gate on all 8 mutators, `BlobRehomeResumeNotImplementedError` (the seam this PR fills).

**PRE-REQ:** PR-1 (#768) must be MERGED before branching. Branch `fix/746-blob-rehome-journal` off the post-merge main.

**Tech Stack:** TypeScript ESM, vitest, `crypto.subtle`/`crypto.getRandomValues`.

## Global Constraints

- Files: `blob-set.ts` (no ceiling — `rehomeForTier`/`rehomeVersionRecords`/`rehomeVersionETag`/`migrate`), `blob-intent.ts` (rehome-marker consume + the `op:'rehome'` resume), `with-audit/tiers/index.ts` (syncBlobs — CEILING, keep funded), `kernel/vault.ts` (only if forget-supersession needs it — CEILING 3959 exact).
- Never add Claude attribution. Hub portable. TDD with STOP-model crash injection (hang-forever adapter wrappers + fresh-session resume — the PR-1 pattern in `blob-shred-journal.test.ts`, NOT throw-and-catch).
- The rehome marker (`op:'rehome'`, `{opId, fromTier, toTier, policy}`) already exists in the `BlobIntent` type (PR-1 §2a). This PR wires its mint + consume + resume.

---

### Task 1: increment stamping (C3) — the rehome correctness core

**Files:** `blob-set.ts` (`casUpdateRefCountStamped` already supports a stamp; extend the INCREMENT callers), `rehomeForTier`'s `putUnderDEK` + `rehomeVersionETag`.

The rehome's DESTINATION `+1`s are the crash hazard C3 names: `putUnderDEK`'s dedup-hit `+1` and fresh-object refCount, and `rehomeVersionETag`'s `casUpdateRefCount(already, +1)`. A crash after the `+1` but before the slot/version CAS that records the move → resume re-puts → over-counts the destination → the object never reaches 0 → content never crypto-shredded on a later `demote(→0)` (a silent permanent leak).

1. Increments during a marker-governed rehome carry a **row-scoped** stamp: `${opId}:${slotName}` (slot re-puts) / `${opId}:${versionKey}` (version re-puts). A bare opId can't discriminate N slots legitimately applying N `+1`s to one destination eTag — the row scope is load-bearing (spec C3).
2. `casUpdateRefCountStamped`'s in-loop membership check (PR-1) already returns `'already-applied'` on a matching stamp — so a resumed re-put's `+1` is idempotent per row.
3. Old-object RELEASE on re-put keeps the shred-style opId stamp (already the mechanism) so a resumed re-put can't double-release the old object either.

Tests (STOP-model, new `packages/hub/__tests__/blob-rehome-journal.test.ts`): crash after a destination `+1` before the slot CAS → resume → destination refCount is correct (NOT over-counted), old object released exactly once; same for a version `+1`.

Commit: `fix(hub): rehome destination increments are row-scoped stamped — resume can't over-count (#746 spec C3)`.

---

### Task 2: rehome marker mint + resumable rehomeForTier (#746)

**Files:** `blob-set.ts` (`rehomeForTier` + a `resumeRehome`/consume path), `blob-intent.ts` (rehome consume), `with-audit/tiers/index.ts` (syncBlobs mints).

1. `syncBlobs` (the tier-op → rehome seam, called from elevate/demote/putAtTier in `tiers/index.ts`) mints the rehome marker BEFORE `rehomeForTier`'s first write (CAS-create; a pending marker for the record → resume it first per §2d). Keep the tiers/index.ts call funded (helper does the work).
2. `rehomeForTier` becomes resumable per spec §2d — re-run with per-step tolerance:
   - Slot map: load via two-tier `loadSlots`-equivalent (try `fromTier`, fall back `toTier` — the marker knows both); opens at `toTier` → move already done → skip the move step.
   - Per-eTag: `loadBlobObject(eTag, fromTier, toTier)` (PR-1's `alsoTryTier` — THIS is its first real caller, the seam PR-1 left); an object that only opens at `toTier` (or whose slot already points at a `toTier`-namespace eTag) is already moved → skip. Content-addressed re-put converges (dedup hit), never forks.
   - Version pass: same per-key from-then-to tolerance.
   - Delete the marker LAST.
3. **C10 — no swallowed releases under the marker:** `putUnderDEK`'s and `rehomeVersionETag`'s `.catch(() => {})` old-eTag releases: under a rehome marker a failed release keeps the marker alive or surfaces (don't silently drop — the release is the crypto-shred of the FROM-tier object; swallowing it during a documented-exactly-once op is the bug C10 closes).
4. Resume entry: the tier ops resume a pending rehome marker (via syncBlobs); the PR-1 mutator gate's `BlobRehomeResumeNotImplementedError` is REPLACED with a real `resumeRehome` call.

Tests (STOP-model): crash mid per-eTag loop → resume via a fresh `elevate()` attempt → all artifacts at `toTier`, old objects released once, marker gone, demote reversal still round-trips; crash after slot-map move → resume skips the move, completes versions; the `alsoTryTier` from-then-to open resolves a half-moved record's mixed artifacts.

Commit: `fix(hub): rehomeForTier is crash-atomic and resumable — intent marker + per-step tolerance (#746)`.

---

### Task 3: supersession (Q1) — forget resumes a pending rehome first

**Files:** `blob-set.ts` (`resolvePendingIntent` / the shred entry), `kernel/vault.ts` (forget-entry — CEILING).

Spec Q1 (resolved): supersession is **resume-then-shred**, NOT replace. A half-done rehome can leave a row-unreferenced destination object that shred's row-derived holds can never see — replacing the marker would leak it past `forget()` permanently. So:
1. `forget()` / shred entry: a pending `op:'rehome'` marker → **resume the rehome to completion first** (restores the row↔hold invariant), THEN mint + run the shred on clean state. (Replaces PR-1's `BlobRehomeResumeNotImplementedError` throw at the shred entry.)
2. Rehome entry under a pending `op:'shred'` marker → resume the shred (nothing left to rehome — the record's blobs are being erased).
3. Marker is single-per-record (CAS create-if-absent, PR-1) — resume-first means no window where both ops' semantics apply.

Tests: rehome crashes mid-move → `forget()` on that record → rehome resumes, THEN shred runs → orphan destination object IS shredded (the Q1 regression: prove a row-unreferenced half-moved object doesn't survive forget); shred pending → elevate() → shred resumes.

Commit: `fix(hub): shred resumes a pending rehome before erasing — supersession keeps orphan destinations reachable (#746/#753 spec Q1)`.

---

### Task 4: migrate() tier-awareness rider (#756) — full scope (C7)

**Files:** `blob-set.ts` (`migrate`).

Spec C7 — the rider needs BOTH fixes, not just the slot-map read:
1. `migrate()` reads the slot map at `ownerTier()` (not the hardcoded `loadSlots(0)` that throws `TamperedError` on a previously-elevated record).
2. Per-eTag loads use the #747 fallback (`loadBlobObject(eTag, ownerTier, 0)`): `t===0` has no fallback today, so a mixed slot map (rehomed tier-keyed eTags + legacy flat) still throws. Objects opening at `atTier > 0` are erasable by construction → push to `alreadyErasable`, never migrate them (migrate only upgrades LEGACY flat blobs to per-record CEK).
3. A pending rehome marker → resume it FIRST (mechanical — reuse Task 3's resume), then migrate.

Tests: previously-elevated record (put→elevate→demote, or putAtTier) `migrate()` works instead of `TamperedError` (#756 regression); a mixed legacy+erasable slot map migrates only the legacy ones; a mid-rehome record resumes then migrates.

Commit: `fix(hub): migrate() is tier-aware — owner-tier slot read + #747-fallback per-eTag loads, resumes a pending rehome (#756)`.

---

### Task 5: guards + changeset + close-out

1. Full verification: hub test/typecheck/lint/check:architecture; ceilings exact (vault.ts, tiers/index.ts). Bundle check (`build` + `bundle-check`) — report deltas; if a scenario exceeds tolerance STOP for a decision (the arc's second wave of bytes; do NOT self-accept).
2. Changeset `.changeset/blob-rehome-journal.md`:

```md
---
"@noy-db/hub": patch
---

Crash-safe tier-move blob rehome (#746) + tier-aware migrate() (#756), completing the blob durability journal (#753 shipped the shred half). A tier move (`elevate`/`demote`/`putAtTier`) that re-keys a record's blobs to the destination tier's DEK is now journaled: destination refCount increments are row-scoped stamped so a crash mid-move can't over-count (and thus never strand content undecryptable-but-alive), and `rehomeForTier` resumes with per-step from-then-to tolerance — a half-moved record heals on the next tier op or blob touch instead of staying silently split across tiers at rest. `forget()` resumes a pending rehome to completion before erasing (so a half-moved blob a row no longer references can't survive erasure), and a shred supersedes a pending rehome the other way. `migrate()` (legacy-blob → per-record-CEK upgrade) is now tier-aware — it no longer throws `TamperedError` on a previously-elevated record and skips already-erasable blobs. No swallowed releases under a marker: a failed from-tier crypto-shred during a rehome surfaces rather than silently dropping.
```

3. Commit anything tracked.

## Self-Review Notes

- Task 1 (increment stamping) MUST land before Task 2 wires the resumable rehome — the resume tolerance is only exactly-once WITH the stamped increments.
- The `alsoTryTier` param PR-1 added purely for this PR's benefit finally gets its caller in Task 2 — confirm no PR-1 hot path accidentally started passing it.
- Supersession (Task 3) closes the arc's subtlest hole: the row-unreferenced orphan destination object. Its test is the arc's keystone regression — make it STOP-model and adversarial.
