# Edge-crypto kernel optimization — Implementation Plan

> **For agentic workers:** execute via superpowers:subagent-driven-development. **GATED:** Phases P2+ do not start until the security review (`scratchpad/review/security.md`) confirms the edge-formulated ciphertext guard is enforceable at the same strength as today's `stores-ciphertext-only`, and the user gives explicit go-ahead. This plan flips a central invariant.

**Goal:** Make encryption a **store-edge codec** (encrypt crossing out to disk/network/export, decrypt crossing in), with a plaintext working set in trusted RAM — dissolving `to-memory` and reframing `cache` as the buffer pool.

**Architecture:** Move the encryption boundary from "before any store call" to "at the persistent/transport/export edge." Behavior-preserving for at-rest/in-transit/export guarantees; removes the redundant in-RAM ciphertext copy for the pure-memory case.

**Tech Stack:** TypeScript, `crypto.subtle`, tsup, vitest, pnpm.

## Global Constraints

- **Zero-knowledge against the backend is preserved:** every persistent/transport/export store still only ever receives ciphertext. The guarantee that weakens is *uniformity* (in-memory working set is plaintext by design) — the new guard must enforce "ciphertext at the persistent edge" build-time, as mechanically as Check 4 does today.
- **No silent behavior change:** lazy-by-default (P4) is a separable behavior change — propose, don't bundle.
- **Atomic doc/guard update:** "encryption before any store call" appears across docs/specs/`check-architecture.mjs`. The invariant flip updates all of them in one change or none.
- Security review findings are folded in before P2 implementation.
- No Claude attribution in commits.

## Security gates (from the 2026-06-30 security review — HARD requirements)

The review's verdict: the flip does **not** inherently weaken at-rest/at-network confidentiality, but it relocates the invariant from one greppable chokepoint to "all egress paths." These are non-negotiable for P2+:

1. **Type-level `StoreEdgeCodec`.** An un-encoded persistent/network/export egress must be **unrepresentable in the type system**, not merely grep-guarded. If it can't be made build-time-unbypassable, **P2 stops**. (The existing `stores-ciphertext-only` guard is already weaker than it claims — L-5 — so it cannot be the safety net here.)
2. **Sealed-field non-residency preserved.** A plaintext working set must keep `sensitive` fields as `SealedHandle`/ciphertext even in RAM, or the flip silently undoes #306/#503. Explicit invariant + test.
3. **`forget()` RAM-scrubs.** Once plaintext is resident, key-destruction no longer suffices — `forget()` must scrub the working-set copy + plaintext derived structures. V8 can't zero strings; design around it (typed-array-backed buffers for sensitive material, drop+GC the rest, document the residual). **Prerequisite: H-1 + M-1 `forget()` fixes land first** (review §🔴) so the erasure path is correct before it gains RAM-scrub duties.
4. **Swap/core-dump is the sharp edge.** Treat host RAM as the new TCB; `mlock`/secure-buffer where available; document the threat.
5. **Bank the silver lining:** make the edge codec **re-encrypt** indexes/derived structures (randomized) rather than pass them through — this *removes* the persisted `_det` equality side-channel and metadata-in-envelope leaks (L-3/L-4/L-11) at the store. Explicit design goal, not an accident.

---

## P0 — `record-codec.ts` extraction (shared with the reorg prerequisite)

P2's "store-edge codec seam" IS the `record-codec.ts` extraction the reorg plan also requires. Do it **once**, first: pull envelope-build + encrypt/decrypt/CEK + the deduped #306 sealed dual-read out of `Collection` into a named module. It serves the reorg (no scattered copies), the architecture honesty ("encryption-in-the-hub" is now a module), and this spec's P2 (the codec to graft the edge logic onto). See the reorg plan's Prerequisite section.

---

## P1 — Built-in store (DONE — landed `e1f5ba90`)

`createNoydb({ store? })` optional; built-in `MemoryStore` (`src/store/memory-store.ts`) is the zero-config default. This is the enabler for P3. No work remaining; listed for completeness.

---

## P2 — Store-edge codec seam

**Files:** `src/store/`, `src/adapter/`, `scripts/check-architecture.mjs`, `crypto.ts` (no new primitives — reuse `encrypt`/`decrypt`/envelope).

**Interfaces produced:** a `StoreEdgeCodec` boundary — `encodeForEdge(record) → EncryptedEnvelope` / `decodeFromEdge(envelope) → record` — applied by the kernel write/read path at the store seam, replacing the "encrypt before every store call" inline calls with a single named edge transform.

- [ ] **Step 1 (spec the seam):** Document where every store call sits today (grep `adapter.put`/`adapter.get` in `collection.ts`/`vault.ts`/subsystems) and confirm they all route through one chokepoint suitable for a codec. If not single-chokepoint, the first task is to funnel them.
- [ ] **Step 2 (write failing guard test):** A test asserting that anything reaching a **persistent/transport/export** store is ciphertext (the edge formulation), and that an in-memory working-set read returns plaintext without a store round-trip.
- [ ] **Step 3 (implement the codec seam):** Introduce `StoreEdgeCodec` as the single encrypt/decrypt point at the adapter edge; the built-in `MemoryStore` path can skip the codec (no boundary crossed) — *gated behind the security-review-approved formulation*.
- [ ] **Step 4 (re-express the guard):** Update `check-architecture.mjs` Check 4 from `stores-ciphertext-only` (every store call) to `ciphertext-at-persistent-edge` (file/cloud/sync/export adapters). Must be as mechanical and unbypassable as the original.
- [ ] **Step 5:** typecheck ✓ · test ✓ · `check:architecture` ✓ (new guard) · the full conformance suite (`test-harnesses/adapter-conformance`) — every persistent store still ciphertext-only.
- [ ] **Step 6:** Update every doc/spec stating "encryption before any store call" to the edge formulation, same change.

## P3 — Dissolve `to-memory` from the essentials

**Files:** the 5-essentials list (`noy-db` core packages), `SUBSYSTEMS.md`, the family `CLAUDE.md` essentials table, migration docs.

- [ ] **Step 1:** Confirm the built-in `MemoryStore` is contract-complete vs `@noy-db/to-memory` (it covers dev/test/prototyping; spot any feature `to-memory` has that the built-in lacks — e.g. `getStoreTime` monotonic clock — and port if essential).
- [ ] **Step 2:** Demote `to-memory` from the 5 essentials to the extended `noy-db-to` family (or deprecate if fully superseded by the built-in). Decision recorded in `SUBSYSTEMS.md` + a changelog entry.
- [ ] **Step 3:** Migration note: "replace `to-memory` with the built-in default (omit `store`) or import from `noy-db-to`." Update recipes/showcases that used `to-memory`.
- [ ] **Step 4:** `pnpm check:architecture` + the essentials-count gate; full test suite.

## P4 — `cache` → buffer-pool framing (+ lazy-default evaluation)

**Files:** `src/cache/`, `collection.ts` (the `cache`/`lru` fields + eager `prefetch` path), docs.

- [ ] **Step 1:** Rename/reframe `cache` as the buffer pool in docs + identifiers where it clarifies (it is the in-memory DB, not an accelerator). Low-risk doc/naming pass.
- [ ] **Step 2 (separate proposal):** Evaluate **lazy-by-default**. Today eager `prefetch:true` decrypts the whole collection on open (the 🔴 cost + whole-DB-in-RAM exposure). Quantify the memory/security win of lazy-default vs the offline-first eager-read feature loss. This is a behavior change — present as its own decision with benchmarks; do NOT flip silently. Intersects the refactoring review's eager-cache item.

## Verification (per phase)

`pnpm --filter @noy-db/hub typecheck` · `build` · `test` · `node scripts/check-architecture.mjs` · `test-harnesses/adapter-conformance` (P2/P3) · bundle-size gate (the catalog invariants).

## Open questions (carry into review)

- Can the edge guard be made *build-time unbypassable* (the security review's call)? If not, P2 stops.
- Does any 🟢/🔵 subsystem secretly rely on the in-RAM ciphertext copy (CRDT merge reads the raw envelope at `collection.ts:309`; history; key-rotation)? Enumerate before P3 so dissolving `to-memory` doesn't break them.
- Lazy-by-default: feature regression vs memory/security win — needs data.
