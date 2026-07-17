# Blob durability journal — crash-safe shred & rehome (#753, #746, +#756 rider)

**Status:** design spec, 2026-07-18. Feeds the milestone-34 durability arc (the last constellation
after the leak-closure batches A–D shipped in PRs #754/#755/#758/#760/#763/#765).
**Scope:** `shredAllForRecord` crash-idempotency (#753), `rehomeForTier` crash-atomicity/resume
(#746), and — as a rider sharing the same files — `migrate()` tier-awareness (#756).
**Non-goals:** #759 (cargo domain), #761 (candor sweep), #764 (search compensation ergonomics) —
separate small arcs. No durable write-ahead log for the general write path; this journal covers
exactly the two multi-step blob operations whose partial completion is destructive or leaky.

## 1. Threat model — the two crash shapes

Both operations are multi-step sequences of individually-atomic adapter writes with no recovery
protocol. A process crash (tab close, power loss) between steps leaves states that are either
**destructive on retry** or **permanently leaky with no retry**:

### 1a. `shredAllForRecord` (#753) — destructive on retry

Order today: collect holds (slot map + version rows) → `releaseRef(eTag, n)` per eTag (CAS
refCount decrement; at 0, delete BlobObject + chunks) → delete slot map → delete version rows.

- Crash after releases, before row deletions → re-run re-collects the SAME holds from the
  still-present rows and **decrements again**. A co-owned blob (other record still references it)
  is driven to 0 and crypto-shredded — **another record's live content destroyed by a retry**.
- Inverting the order (delete rows first) is worse: crash after deletion → the holds are
  unrecoverable, refCounts stay high forever, content is orphaned-but-decryptable at rest with
  no healing path — a permanent GDPR-erasure failure.

### 1b. `rehomeForTier` (#746) — permanently half-rehomed, no retry

Order today (per #724/#747): per-eTag re-put under `toTier` DEK (slot entries updated as each
lands) → slot-map re-key to `toTier` (LAST) → version-record pass. A crash mid-loop leaves some
blobs tier-N-keyed and some still tier-0-decryptable at rest. Re-`elevate()` to the same tier is
a **no-op** (same-tier check), so nothing ever retries; the half-moved state is silent. The
record's `_tier` already moved (the collection op writes the record before `syncBlobs`), so every
`ownerTier()`-defaulted read of the not-yet-moved artifacts now resolves the WRONG DEK.

### 1c. `migrate()` (#756, rider) — loud failure, no data risk

`migrate()` pins `loadSlots(0)` but elevate re-keys the slot map unconditionally →
`TamperedError` on any previously-elevated record. Not a crash issue; folded here because the
fix touches the same slot-map tier-resolution seams and ships cheapest alongside.

## 2. Design — intent markers + atomic op-stamps

Two primitives, reusing patterns the campaign already shipped (the `_mv_stale` content-bearing
reserved collection from #736; CAS versioning on `BlobObject` writes from #747):

### 2a. The intent marker (reserved collection `_blob_intent`)

One row per in-flight multi-step operation, written BEFORE the first destructive/movement step,
deleted as the operation's LAST step. Key: `{collection}/{recordId}`. Value (encrypted under the
operation's *governing* DEK — see §4):

```ts
interface BlobIntent {
  readonly op: 'shred' | 'rehome'
  readonly opId: string            // random nonce minted at marker creation (crypto.getRandomValues)
  // shred:
  readonly holds?: readonly { eTag: string; n: number }[]  // captured ONCE, authoritative on resume
  readonly ownerTier?: number
  // rehome:
  readonly fromTier?: number
  readonly toTier?: number
  readonly policy?: 'isolate' | 'dedup'
}
```

An absent marker means "no operation in flight" (the normal state — zero cost on every path that
doesn't crash). A present marker means the operation MUST be resumed before any other blob work
on that record proceeds.

### 2b. The op-stamp (`BlobObject.lastOp?: string`)

The double-release hazard cannot be closed by the marker alone (crash mid-release-loop → re-run
cannot tell which eTags were already decremented). Fix: the shred's refCount CAS write stamps
`lastOp: opId` on the `BlobObject` **in the same atomic CAS write as the decrement**. Resume
checks `blob.lastOp === intent.opId` → this eTag's release already applied → skip. Properties:

- Atomic: stamp and decrement land in one `writeBlobObject` CAS — no window between them.
- Stable across resume: the opId comes from the persisted marker, so a re-run skips exactly the
  applied releases and applies exactly the rest.
- No false skip across generations: a NEW shred (record re-created, same eTag re-referenced,
  forgotten again) mints a fresh opId — the old stamp never matches.
- Shredded-at-0 objects are deleted, so no stamp lingers on them; `retainedShared` objects carry
  a stale stamp harmlessly until their next CAS write (documented; `lastOp` is bookkeeping, not
  crypto — it lives beside `refCount`, both mutable-by-CAS).

### 2c. Crash matrix — shred (#753)

Order becomes: collect holds → **write intent marker {opId, holds}** → releaseRef per eTag (each
CAS stamps `lastOp: opId`) → delete slot map → delete version rows → **delete marker**.

| Crash after… | Re-run (via resume) does… | Outcome |
|---|---|---|
| nothing / before marker | fresh shred from live rows | clean |
| marker write | resume: holds from MARKER (not rows); no eTag stamped yet → apply all; delete rows; delete marker | exactly-once |
| some releases | resume: skip stamped eTags, apply rest; delete rows; delete marker | exactly-once |
| all releases | resume: all stamped → skip all; delete rows; delete marker | exactly-once |
| row deletions | resume: skips (stamps) + rows already gone (void deletes); delete marker | exactly-once |
| marker delete | no marker → nothing to resume | clean |

Who resumes: `shredAllForRecord` itself checks for a marker at entry (crash-retry of forget());
plus `BlobSet` write entry points (`put`/`publish`/`adoptExternal`/`delete`) and `rehomeForTier`
refuse-or-resume on a pending marker (a record with an interrupted shred must not accept new blob
writes over ambiguous refCounts — RESUME first, then proceed; resume is cheap and idempotent).

### 2d. Crash matrix — rehome (#746)

Order becomes: **write intent marker {opId, fromTier, toTier, policy}** → existing per-eTag loop →
slot-map move → version pass → **delete marker**.

Resume = **re-run `rehomeForTier(fromTier, toTier, policy)` with per-step tolerance**, which the
#747 machinery makes near-free:

- Slot map: resume loads it via **try `fromTier`, fall back to `toTier`** (marker knows both). If
  it opens at `toTier`, the map already moved → skip the move step.
- Per-eTag: for each slot eTag, `loadBlobObject(eTag, fromTier)` — #747's tier-then-flat pattern
  extends to try-from-then-to using the marker's tiers; an object that only opens under `toTier`
  (or whose slot already points at a `toTier`-namespace eTag minted by the pre-crash run) is
  already moved → skip. The re-put path is content-addressed, so even a duplicated re-put
  converges to the same destination eTag (dedup hit) rather than forking.
- Version pass: same per-key tolerance (already decodes per-row with residue on failure).
- Old-object release on re-put uses the SAME op-stamp mechanism as shred (`lastOp: opId` on the
  decrement) so a resumed re-put cannot double-release the old object.

Who resumes: the tier ops (`elevate`/`demote`/`putAtTier` → `syncBlobs`) check the marker first —
a pending rehome marker for the record is resumed before (or instead of) the new move; the
BlobSet write/read-cleared entry points resume like shred. `atTier()` and gated reads do NOT
auto-resume (read paths stay write-free); they see the record through the marker's `toTier` with
the same fallbacks and remain correct on a half-moved record (each artifact opens under whichever
tier key it is actually at — the fallback reads are what #747 already ships).

### 2e. Why not alternatives

- **Delete-rows-first ordering:** permanent orphan leak on crash (§1a) — rejected.
- **Ground-truth refCount recount:** requires decrypting every slot map in the vault — breaks on
  elevated (undecodable-at-0) maps and is O(vault); rejected.
- **Global WAL/tx wrapper:** far larger surface than the two operations that need it; the
  marker-per-record journal is the minimal shape and mirrors `forgetDerivedFanout`'s
  per-concern-registration philosophy. The general answer stays per-op.

## 3. #756 rider — migrate() tier-awareness

With the marker machinery in place, `migrate()` drops its hardcoded `loadSlots(0)` and resolves
the slot map at `ownerTier()` (post-#747 the object I/O already pins 0 for legacy objects — the
`casUpdateBlobObject` pin stays). Legacy chunks remain flat by definition; only the slot-map READ
needed tier-awareness. A previously-elevated record's `migrate()` then works instead of throwing
`TamperedError`; a mid-rehome record resumes first (2d) then migrates.

## 4. Key management for the marker row

The marker must be readable by whoever resumes. Shred resume happens from forget()-retry (holds
the collection tier-0 DEK; the shredded record's pre-tombstone tier is IN the marker) and from
blob write paths (tier-0 surface). Rehome resume happens from tier ops (cleared callers).
Decision: **encrypt the marker under the collection's tier-0 DEK** — its content (op, tiers,
eTags+counts) is operational metadata, not record plaintext; eTags are already visible as store
keys to any store observer, so the marker leaks nothing beyond what `_blob_index` keys reveal.
This keeps resume possible for every legitimate resumer without minting elevated DEKs on the
tier-0 path. (Documented as an explicit metadata-residue decision for the audit: a tier-0 holder
can learn that an elevated record's shred/rehome was in flight and which eTags it touched —
existence-adjacent, consistent with the already-documented dedup-policy residue.)

## 5. Testing (crash injection)

The memory-adapter wrapper pattern from #725's race tests generalizes: wrap `put`/`delete` to
throw after N operations, run the op to the crash point, assert the intermediate state, then
re-run (or trigger the resuming entry point) and assert the §2c/§2d matrix rows:

- shred: crash after k of n releases → resume → co-owned blob retains exactly its co-owner's
  refCount (THE #753 regression), sole-owned content fully shredded, rows + marker gone.
- shred: new-generation same-eTag re-shred is not skipped by the old stamp.
- rehome: crash mid-loop → resume via next elevate() attempt → all artifacts at `toTier`, old
  objects released exactly once, marker gone; demote reversal still round-trips.
- rehome: crash after slot-map move → resume skips the move, completes versions.
- write-entry refusal-resume: `put()` on a record with a pending shred marker resumes the shred
  first (record's blobs end shredded; the new put then proceeds on clean state).
- migrate(): previously-elevated record migrates without TamperedError (#756 regression).

## 6. Open questions for design review

1. Marker granularity: one marker per record (proposed) vs per record+op — a rehome interrupted
   by a forget() would want the shred to supersede the rehome (forget wins; content erasure
   makes the half-move moot). Proposal: shred marker REPLACES a pending rehome marker; rehome
   entry refuses while a shred marker exists.
2. `lastOp` on retainedShared objects: harmless stale stamp accepted, or clear it on the next
   unrelated CAS? Proposal: accept + document (clearing costs a write on hot paths).
3. Does `dump()`/backup carry `_blob_intent`? Proposal: yes (harmless, resume works after
   restore) — verify the `_`-prefix conventions apply as with `_mv_stale`.

---

## 7. v2 corrections (adopted from the adversarial design review, 2026-07-18 — OVERRIDES conflicting §1-§6 text)

The review verdict was **sound-with-changes**; every §1-§6 mechanism stands EXCEPT as amended here.

**C1 (was F1) — completion rule for decrement-to-0.** `releaseRef` decrements, then deletes index+chunks as separate writes; a crash in that gap leaves a refCount-0 object with a recoverable `_cek`. The resume rule is two-armed: `stamped && refCount > 0` → skip; `stamped && refCount <= 0` → COMPLETE the deletion (idempotent). The marker's holds capture `chunkCount` per eTag so chunk cleanup survives index-row loss; residual undecryptable bytes are documented residue.

**C2 (was F2+Q2) — `lastOps` bounded ring, not a scalar.** Concurrent shreds of a co-owned blob would overwrite a scalar stamp and re-apply on resume. `BlobObject.lastOps: string[]` — bounded ring (K=8), append-in-CAS, membership check. K is an audit-visible concurrency bound.

**C3 (was F3) — increments are stamped too, row-scoped.** Rehome's destination `+1`s (dedup-hit in `putUnderDEK`; `rehomeVersionETag`'s `casUpdateRefCount(+1)`) crash-windows over-count and permanently strand content. Stamp identity for increments: `${opId}:${slotName}` / `${opId}:${versionKey}` (a bare opId can't discriminate N slots hitting one destination eTag).

**C4 (was F4) — the stamp check lives INSIDE the CAS retry loop.** A stamp-aware `casUpdateRefCount` variant: every (re)read checks membership first → `'already-applied'`. Entry-point checks alone are TOCTOU-broken under two resumers; in-loop test-and-set also covers landed-put-lost-response on remote adapters.

**C5 (was F5) — forget() writes the marker PRE-tombstone.** The tombstone drops `_tier`; a crash between tombstone and shred strands tier-N holds unrecoverably (no marker, `loadSlots(0)` throws). `forget()` mints the marker (op, opId, ownerTier, holds incl. chunkCounts — all readable pre-tombstone) BEFORE `_writeTombstone`; `shredAllForRecord` consumes the marker as its authority. Explicit retry contract: nothing auto-retries a crashed forget — resume-on-touch heals touched records; a marker SWEEP (forget-entry + vault-open, #736's orphan-sweep pattern) heals untouched ones.

**C6 (was F6) — resume gate on EVERY refCount/slot mutator.** The conservative rule: every method calling `releaseRef`, `casUpdateRefCount`, or `casUpdateSlots` resumes a pending marker first — adds `deleteVersion`, `setExternalMeta`, `migrate`, and any GC sweep to §2c's list. Resume inside forget-retry returns the standard `{shredded, retainedShared, residue}` shape derived from marker holds (stamped-and-gone → shredded; stamped-and-retained → retainedShared; undecodable → residue).

**C7 (was F7) — #756 rider full scope.** `migrate()` needs BOTH the owner-tier slot-map read AND #747-fallback per-eTag loads (`t === 0` has no fallback today; a mixed slot map still throws). Objects opening at `atTier > 0` are erasable by construction → `alreadyErasable`, never migrated. A pending rehome marker is resumed BEFORE migrate proceeds (mechanical, not prose).

**C8 (was F8) — marker create is CAS create-if-absent; multi-tab terminal-delete residue documented.** Present marker → resume it first, never overwrite (an overwritten marker orphans the prior op's stamps). The shred's terminal slot-map delete has no expectedVersion in the store contract — the two-tab finish/re-put/delete race is DOCUMENTED ACCEPTED RESIDUE for this arc (tabCoordinator integration deferred; noted for the audit).

**C9 (was F9) — pattern honesty.** `_blob_intent` is the family's FIRST content-bearing encrypted marker (`_mv_stale` is content-free plaintext) — its conventions (tier-0 DEK codec, CAS create, backup allowlist, sweep) are new and documented as such.

**C10 (was F10) — no swallowed releases under a marker.** `putUnderDEK`'s and `delete()`'s `.catch(() => {})` old-eTag releases: during a marker-governed op a failed release keeps the marker alive or surfaces as residue — never silent.

**C11 (was F11) — marker key encoding.** Record ids may contain `/`; the marker key uses the `::` grammar (`{collection}::{recordId}`) which blob-bearing record ids already refuse internally (#752) — prefix-scans for the sweep stay unambiguous.

**Q1 resolved — supersession is resume-then-shred.** A half-done rehome can leave a row-unreferenced destination object that shred's row-derived holds can never see; replacing the marker would leak it past forget() permanently. Forget entry: resume a pending rehome FIRST, then shred. Rehome entry under a shred marker: resume the shred (nothing left to rehome).

**Q3 resolved — backup allowlist is explicit.** There is no automatic `_`-prefix travel; `dumpVault`'s `internalNames` allowlist must gain `_blob_intent` (blob rows already travel; restoring mid-op state without its marker reproduces the ambiguity the journal prevents). Noted: `_mv_stale` does NOT travel today — filed as an observation for #761's constellation, not fixed here.

**Implementation ordering (2 PRs):** PR-1 = primitives + shred: (1) two-tier loader mode, (2) stamp-aware CAS + `lastOps` ring + completion rule, (3) `_blob_intent` plumbing (codec/CAS-create/allowlist/sweep), (4) shred journal (#753) with crash-injection matrix. PR-2 = (5) rehome journal (#746: stamped increments, unswallowed releases, per-step resume tolerance), (6) supersession, (7) #756 rider. Steps 4 and 5 are independently landable behind the shared primitives.
