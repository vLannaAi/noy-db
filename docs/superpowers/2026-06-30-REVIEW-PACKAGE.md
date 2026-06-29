# Morning review package — hub reorg, edge-crypto, and a whole-codebase audit (2026-06-30)

> **Read this first.** Everything from the overnight run is linked here, prioritized. Built on branch `docs/hub-reorg-and-edge-crypto-specs`. **No code was changed** — these are specs, plans, and a read-only audit. Two **security bugs** were found that warrant action before the reorg (see 🔴 below).

## What happened overnight

You asked for: two specs (+ plans) for the hub work, then a whole-codebase review (security / discrepancy / refactoring), packed for your review. Done. Also — **the reorg you thought was lost is not lost**: it's commit `f6127e62` ("group optional subsystems into 7 dimension folders") on `feat/family-folders`, gate-green when committed. We finalized the naming as **`with-` prefix** (mirrors the `with*()` opt-in API). The specs re-derive the move on current `main`.

## Deliverables (all committed on this branch)

| # | Doc | What |
|---|---|---|
| Spec A | [`specs/2026-06-30-hub-src-with-dimension-reorg-design.md`](specs/2026-06-30-hub-src-with-dimension-reorg-design.md) | Group 36 optional subsystems into 7 `with-*` folders; public API + `dist/` byte-identical |
| Plan A | [`plans/2026-06-30-hub-src-with-dimension-reorg.md`](plans/2026-06-30-hub-src-with-dimension-reorg.md) | Step-by-step move (worktree, split-safe `git mv`, import codemod, tsup entries, gates) |
| Spec B | [`specs/2026-06-30-edge-crypto-kernel-optimization-design.md`](specs/2026-06-30-edge-crypto-kernel-optimization-design.md) | Flip the invariant to a store-edge codec: plaintext working set in trusted RAM, encrypt at disk/net/export edge; `to-memory` dissolves, `cache` = buffer pool |
| Plan B | [`plans/2026-06-30-edge-crypto-kernel-optimization.md`](plans/2026-06-30-edge-crypto-kernel-optimization.md) | Phased (P1 built-in store DONE → P2 codec seam → P3 dissolve `to-memory` → P4 buffer-pool); **security-gated** |
| Review | [`reviews/2026-06-30-security.md`](reviews/2026-06-30-security.md) | Crypto/security spine audit — **High 1 · Med 5 · Low 11** |
| Review | [`reviews/2026-06-30-architecture.md`](reviews/2026-06-30-architecture.md) | Invariant/catalog drift — High 4 · Med 5 · Low 3 |
| Review | [`reviews/2026-06-30-refactoring.md`](reviews/2026-06-30-refactoring.md) | Tech-debt + reorg sequencing — 12 ranked items |
| Review | [`reviews/2026-06-30-reorg-readiness.md`](reviews/2026-06-30-reorg-readiness.md) | Inventory — mapping exact, 0 unmapped, ~404 test-import refs |

---

## 🔴 URGENT — security, act before (or independent of) the reorg

Two real erasure bugs in the **`forget()` / sealed-field** path (the #306 area shipped this week). Both are **standalone fixes** — not blocked by the reorg, and worth doing first because the reorg/edge-crypto will rewrite this exact code.

1. **H-1 — `forget()` doesn't delete `_sealed_cek` delivery envelopes.** A record reported as erased stays fully decryptable by a granted `at-*` host from any synced/backed-up replica (the per-record CEK survives in `_sealed_cek/<coll>/<id>/<pid>`; only `rotateRecordCek`/`revokeSealedRecord` clean it, never `forget()`). **Fix:** prefix-delete `${collection}/${id}/` from `_sealed_cek` in the forget loop + report residue. *(In any sync/backup deployment this is effectively Critical.)*
2. **M-1 — legacy DEK-sealed fields are mis-reported as crypto-shredded.** A record with a migrated body but pre-#306 DEK-derived `_sealed` slots is counted into `sealedFieldsShredded` as destroyed, while the retained collection DEK still decrypts any synced copy. `forget()` returns empty `unmigratedRecords` + positive shred count — a false "complete erasure" signal. **Fix:** detect DEK-derived slots (CEK-derive fails) and report as residue; don't count them shredded.

Other security items (full detail in the report): **M-2** subject-index is unsalted `SHA-256(subjectId)` → subject-existence brute-force; **M-3** derivations fanout sidecar is written **plaintext** (user-supplied keys can be content-bearing); **M-4** sealed-record expiry **fails open** on a malformed `expiresAt` (`NaN <= now` is false → eternal grant); **M-5** `revokeSealedRecord` is soft-only. Plus 11 Low (guard gaps, `_det` shares the DEK, metadata-in-envelope, etc.).

**The crypto spine itself is sound** (PBKDF2-600K / AES-256-GCM-random-IV / AES-KW, consistent injective HKDF domain separation, only ciphertext reaches the store, the LRU is verifiably RAM-only, `SealedHandle` non-residency holds, CEK crypto-shred works *except* H-1).

---

## 🟡 Findings that change the plan (before reorg)

**1. Extract `record-codec.ts` FIRST — it's the linchpin for everything.** The refactoring review and architecture review converge here: the envelope-build + encrypt/decrypt/CEK + #306 sealed dual-read logic is **copy-pasted** across `collection.ts`, `vault.ts`, `record-keys/sealing.ts`, and ~12 subsystem files (the envelope literal alone repeats ~30×; the security-critical dual-read exists in 2–3 drifting copies). If we reorg first, those copies **scatter into 7 folders**. Extracting one `record-codec.ts` simultaneously: (a) gives the reorg a single thing to move, (b) becomes the named "encryption-in-the-hub" module the architecture review says is missing, and (c) **is** Plan B's P2 store-edge codec seam. *Do this before the move.* (It also makes the H-1/M-1 fixes land in one place.)

**2. Decide test layout in the same pass.** Tests are in a **flat `__tests__/`** (not beside source, contra CLAUDE.md). The reorg moves source into 7 folders; ~404 test-import refs across 260 files need rewriting regardless (bigger than the prototype's 438/224). Decide now: mirror `__tests__/with-*/…` or co-locate. Also: **172 of 229 test files inline `createNoydb(` with zero shared helper** — extract `__tests__/helpers/` fixtures to cut churn during the move.

**3. The "minimalist ~6,500 LOC core" claim is aspirational, not load-bearing.** The 3 always-on files alone are **13,525 LOC** (collection 5,739 + vault 4,676 + noydb 3,110); the `kernel-surface` ratchet has risen ~45% as an approval queue, not a cap. ~13 subsystems are still kernel-coupled via named `…Strategy` fields rather than the `subsystem-bus`. The reorg + the god-object decomposition (refactoring items #6–#11) are the structural fix; the docs (`CLAUDE.md`, `SUBSYSTEMS.md` C1) should be reconciled to real numbers.

**4. Catalog drift to fix while we're in here.** `joins`(#2)/`live`(#4) are documented subsystems with subpaths + LOC-saved but **have no module and no export** (a consumer following the docs gets a resolution failure); `routing` is claimed at `@noy-db/hub/routing` (no such subpath — it's under `./store`); `transactions` is documented but exported as `./tx`; `team`/`attestation`/`sealed-record` have subpaths but no `with*()` factory. The reorg is the natural moment to reconcile catalog ↔ exports ↔ folders.

**5. The cache/`to-memory` double-residency is confirmed** (the basis for Spec B). Eager-default `loadAll`+decrypt-whole-collection holds the entire collection as plaintext on top of the store's ciphertext copy. Intrinsic to the boundary, but the eager default is the cost lever — **owned by Spec B / P4**, not flipped in the reorg.

---

## Security constraints folded into Spec/Plan B (the edge-crypto flip)

The security review's verdict on the flip: it does **not** inherently weaken at-rest/at-network confidentiality, but it relocates the invariant from one greppable chokepoint to "all egress paths," enlarges the RAM-disclosure/swap blast radius, and silently regresses sealed-field non-residency + `forget()` unless each is re-established. **Hard requirements for P2+** (now in Plan B):
- **Type-level `StoreEdgeCodec`** that makes an un-encoded persistent/network/export egress *unrepresentable* (not a grep guard). This is the gate; if it can't be made build-time-unbypassable, P2 stops.
- **Sealed-field non-residency must be preserved** in a plaintext working set (keep sealed fields as handles/ciphertext even in RAM) — explicit invariant + test, or the flip undoes #306.
- **`forget()` must RAM-scrub** the working-set copy (+ plaintext derived structures), since key-destruction no longer suffices once plaintext is resident. (V8 can't zero strings — design around it.)
- **Swap/core-dump is the sharp edge** — treat host RAM as the new TCB; `mlock`/secure-buffer where available; document it.
- **Silver lining to bank:** if the edge codec *re-encrypts* indexes/derived structures (randomized) rather than passing them through, the persisted `_det` equality side-channel and the metadata-in-envelope leaks (L-3/L-4/L-11) can be *removed* at the store. Make it a design goal.

---

## Recommended sequence

1. **Fix H-1 + M-1** (forget/_sealed_cek + legacy-DEK erasure honesty) — small, security-critical, standalone. *(Your go-ahead; I won't touch crypto/forget autonomously.)*
2. **Extract `record-codec.ts`** (+ dedupe sealed dual-read + `buildEnvelope()`) — the shared prerequisite. Lands the H-1/M-1 fixes in one place; seeds Plan B P2.
3. **Reorg** (Plan A) — now moves a consolidated codebase, not scattered copies; fold in catalog-drift fixes + test-layout decision + the god-object cluster moves (refactoring #6–#11).
4. **Edge-crypto** (Plan B, P2→P4) — security-gated on the type-level `StoreEdgeCodec`.

Independent quick wins anytime: shared test fixtures (#4), `putInternal` decomposition (#5), the other Medium security fixes (M-2…M-5).

## Open decisions for you
- **Approve the `with-` reorg structure** as specced? (mapping confirmed exact, 0 unmapped folders.)
- **Approve the edge-crypto direction** + its security gates, or want changes before P2 is planned in detail?
- **Want me to fix H-1 + M-1 now** (next session), or hold for your review of the security report first?
- **Test layout:** mirror `with-*` or co-locate?
- One spec or keep reorg + edge-crypto as the two separate specs they are? (Recommend: keep separate; sequence reorg → edge-crypto.)
