# Via Phase B Implementation Plan (#629)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retrofit classified + blobs as via-features, introduce `ViaCryptoCtx` (sealedSlots + reservedEnvelopes), activate posture enforcement (query/export/forget) behind parity tests, and delete the via-enclave-isolation grandfather.

**Architecture:** Option-3 hybrid per the spec: the kernel lifts the *separable* `_sealed` sub-step (`record-codec.ts` steps 2 — seam map §2) behind a `sealedSlots` capability consumed by via-classified's `encodeAtRest`/`decodeAtRest` hooks; the `_vdig`/`_bidx` digest sub-step (needs `{id, prev}`) stays codec-inline consuming resolved config. `reservedEnvelopes(prefix)` gives DictionaryHandle a sanctioned crypto path. via-blob is thin (blob writes never touch `_putInternal`/codec — seam map §8). Posture consumers flip one at a time, each pinned to today's byte-observable behavior first.

**Tech Stack:** TypeScript, `@noy-db/hub` (tsup + vitest), turbo monorepo. Run from repo root: `pnpm vitest run <path>`.

## REQUIRED READING (every task)

- Spec: `docs/superpowers/specs/2026-07-11-via-phase-b-design.md`
- **Seam map (ground truth, exact anchors + verbatim excerpts):** `.superpowers/sdd/seam-map-classified-blobs.md` — §N references below point into it. Line numbers were verified post-#628 on main; re-locate by symbol if drifted.
- Phase-A conventions: `kernel/via.ts` (ViaBinding/registry), `kernel/via-pipeline.ts`, `compileViaBindings` in collection-config, `port/with/i18n-strategy.ts` (the port-move precedent), the two guard rules + allowlists in `scripts/check-architecture.mjs`.

## Global Constraints

- **Behavior lock:** the FULL classified (guard-gate-parity, reveal-gate, R10 drift, encoding-conformance…), blobs (routing/compaction/lifecycle), forget/erasure (sealed-CEK prefix-delete, residue classification), export, and query-refusal suites pass **UNCHANGED** (seam map §10 lists them). Any test edit beyond ADDING tests is a deviation to flag.
- **Zero-knowledge non-negotiable:** a via-feature never receives the keyring, raw DEKs/CEKs, or the enclave barrel — only the two `ViaCryptoCtx` capabilities, pre-bound and scope-checked. `rotateRecordCek`/`SEALED_CEK_NS`/`sealing.ts` stay kernel-side untouched (seam map §2 end).
- **Ceilings are EXACT-LOCKED** (collection.ts 4473, vault.ts 4094, noydb.ts 2385): every task that adds kernel lines must REMOVE at least as many in the same task ("shrink-before-add"). Report final counts every task; no bumps without a flagged deviation.
- **The `via-enclave-isolation` rule must END with an EMPTY allowlist** (Task 4 deletes the dictionary.ts entry) and still fire on synthetics; `via-layering` allowlist stays exactly `[join.ts → #626]`.
- **Digest-only invariants preserved:** `_vdig`/`_bidx` logic in `record-codec.ts:290-376` is NOT moved; `_det` and `_bidx` remain two mechanisms (§5); "I5: digest-only never equality-correlatable" holds.
- Run `pnpm --filter @noy-db/hub bundle-check` at Tasks 4, 6, 7, 10 (build first; `NODE_OPTIONS=--max-old-space-size=8192` if DTS OOMs). Classified engine canaries (§Part-4) keep their names.
- **Never add Claude attribution; grep every diff for "accounting-firm" pre-commit.**

---

### Task 1: `ViaCryptoCtx` types + the kernel sealed-slot capability

**Files:**
- Modify: `packages/hub/src/kernel/via.ts` (additive: `ViaCryptoCtx`, `SealedSlotRef`, `ViaEraseCtx`, `ViaEraseReport`; `ViaBinding` gains `reservedPrefixes?: readonly string[]` + hook slots `enforceWrite?`, `encodeAtRest?`, `decodeAtRest?`, `erase?` — signatures below)
- Create: `packages/hub/src/kernel/enclave/record-keys/sealed-slots.ts` — EXTRACT the sealed sub-step from `record-codec.ts` (seam map §2 step 2 + `unsealField`/`makeSealedHandle` counterparts) into named kernel functions `sealFields(...)`/`unsealFields(...)` with the exact signatures the map's separability verdict states; `record-codec.ts` calls them (pure kernel-internal refactor, byte-parity)
- Test: `packages/hub/__tests__/via/crypto-ctx.test.ts`

**Interfaces — Produces (later tasks rely on these exact names):**

```ts
// kernel/via.ts (additive)
export interface SealedSlotRef { readonly iv: string; readonly data: string }   // matches the existing `iv:data` sealed map entries (§2 step 2)

export interface ViaCryptoCtx {
  readonly sealedSlots: {
    seal(field: string, plaintext: unknown): Promise<SealedSlotRef>
    unseal(field: string, ref: SealedSlotRef): Promise<unknown>
    delete(field: string): Promise<void>
  }
  reservedEnvelopes(prefix: string): {
    encrypt(collection: string, json: string, v: number): Promise<EncryptedEnvelope>
    decrypt(collection: string, env: EncryptedEnvelope): Promise<string>
  }
}

export interface ViaEraseCtx { readonly id: string; readonly vault: string; readonly live: unknown /* EncryptedEnvelope */; readonly crypto: ViaCryptoCtx }
export interface ViaEraseReport { readonly shredded: number; readonly residue: readonly unknown[] }

export interface ViaBinding {
  // …existing A fields/hooks unchanged…
  readonly reservedPrefixes?: readonly string[]
  enforceWrite?(record: Record<string, unknown>, ctx: ViaWriteCtx): void | Promise<void>          // throws to refuse (classified step-3 slot)
  encodeAtRest?(record: Record<string, unknown>, crypto: ViaCryptoCtx): Promise<{ record: Record<string, unknown>; sealed?: Record<string, SealedSlotRef> }>
  decodeAtRest?(record: Record<string, unknown>, sealed: Record<string, SealedSlotRef>, crypto: ViaCryptoCtx, opts: { asHandles: boolean }): Promise<Record<string, unknown>>
  erase?(ctx: ViaEraseCtx): Promise<ViaEraseReport>
}
```

The kernel capability factory (in `sealed-slots.ts` or a sibling): `makeSealedSlotCapability(codecCtxSubset, recordId, cek|dek)` pre-binds seal/unseal/delete to `(collection, recordId)` using the extracted `sealFields`/`unsealFields` internals — key material stays inside the closure, never on the returned object. `reservedEnvelopes(prefix)` factory takes a DEK resolver + declared-prefix set; requests where `!collection.startsWith(prefix)` OR prefix not declared by the binding throw `ValidationError`.

- [ ] Step 1: extraction first — create `sealed-slots.ts` by MOVING the step-2 seal loop + `unsealField` dual-read + handle-produce logic into `sealFields`/`unsealFields`/`makeHandleProducer` (read `record-codec.ts:261-288`, `485-493`, `552-554`, `615-623` and the map §2); `record-codec.ts` delegates. Run the FULL classified suite + `money/encoding-conformance` → green (byte-parity lock). Commit.
- [ ] Step 2: add the via.ts types + capability factories with unit tests: seal/unseal round-trip via a fixture key; `unseal` with a wrong-record binding throws; `reservedEnvelopes('_dict_')` refuses `'notdict_x'` and undeclared prefixes; erase types compile. Commit.

---

### Task 2: Pipeline + config plumbing for the new hooks

**Files:** `kernel/via-pipeline.ts` (fold `enforceWrite`/`encodeAtRest`/`decodeAtRest`/`erase`; async-stack detection includes the new hooks), `kernel/collection-config.ts` (compile threading unchanged — order comment gains classified), tests `__tests__/via/pipeline-b.test.ts` (fixture bindings exercising each new fold + ordering + the sync-stack rule: a stack with only sync hooks stays sync).

Pipeline additions mirror A's folding style: `enforceWrite` awaits each binding in order (first throw wins); `encodeAtRest` folds `{record, sealed}` accumulating sealed maps (brand-keyed collision = error); `decodeAtRest` folds; `erase` runs all bindings, concatenating reports. Commit per green step.

---

### Task 3: Codec boundary — the hooks go live (fixture-proven, classified still inline)

**Files:** `kernel/enclave/record-keys/record-codec.ts` (at the exact current step-2 position: if the collection's pipeline has at-rest hooks, invoke them with a `ViaCryptoCtx` built from the codec's own key material; else run the existing inline path — parity), `kernel/collection.ts` (thread `via` into `RecordCodecContext` — it's flat/this-free, add one field; SHRINK: this task must stay ceiling-neutral), tests `__tests__/via/codec-boundary.test.ts` (a fixture at-rest binding on a plaintext + an encrypted vault: sealed map lands in `_sealed`, decode round-trips, handles honor `asHandles`; zero-via collections byte-identical envelopes vs pre-change fixtures).

NOTE: after this task classified STILL runs inline (its binding doesn't exist) — the inline path and the hook path coexist behind `pipeline?.hasAtRestHooks`. Full classified + money/i18n suites green.

---

### Task 4: `reservedEnvelopes` consumer — DictionaryHandle cutover + grandfather deletion

**Files:** `shape/via-i18n/binding.ts` (declares `reservedPrefixes: ['_dict_']`), `shape/via-i18n/dictionary.ts` (DictionaryHandle consumes injected `reservedEnvelopes('_dict_')` closures instead of `kernel/enclave` imports — the map Part 3 lists exactly `encrypt`/`openEnvelopeJson` + cross-collection DEK; the vault's `buildDictionaryHandle` wiring threads the capability), `scripts/check-architecture.mjs` (**DELETE the `VIA_ENCLAVE_ALLOWLIST` dictionary.ts entry — allowlist now EMPTY**), tests: dictionary suite (623-LOC lock) green; synthetic enclave import still fires the rule; `grep -rn "kernel/enclave" packages/hub/src/shape` → nothing.

---

### Task 5: via-classified — move + strategy port + binding (dormant)

**Files:** git mv `with-shape/classified` → `shape/via-classified` (+ global specifier update incl. grandfather paths, exemption set, canary check — the Task-4-of-A recipe); `port/with/classified-strategy.ts` (ClassifiedStrategy + NO_CLASSIFIED move — i18n precedent); `shape/via-classified/binding.ts`:

```ts
classifiedBinding(cfg): ViaBinding = {
  brand: 'classified',
  posture: { encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true },
  declare: resolveClassifiedFields + guardClassifiedCompat bodies (§1),
  enforceWrite: the enforceClassifiedWrite body (§1; storage:'never' rejection + validators),
  encodeAtRest/decodeAtRest: via ctx.sealedSlots (the recoverable/sensitive union — collection-config.ts:598-605 semantics preserved),
  erase: sealed-CEK prefix-delete + classifySealedShred participation (bodies stay kernel-side where they are codec-owned — the erase hook CALLS ctx/codec-provided closures, mirrors §2 _classifySealedShred plumbing),
  describeFragment,
}
```
Specs/presets gain `_viaBrand: 'classified'`. Binding DORMANT (no compile entry). Full classified suite green (pure move + dormant code). Multi-commit like A's Task 7.

---

### Task 6: via-classified kernel cutover

Compile entry (order money→i18n→classified pinned); collection.ts: `enforceClassifiedWrite` call site → pipeline `enforceWrite` phase; the codec's inline sealed path for classified collections now flows through the binding's at-rest hooks (Task 3's boundary); `sensitiveFields`/`vdigFields` config threading UNCHANGED (codec consumes resolved config — Decision 1); kernel classified imports die (6 symbols, §1); grandfather retirements; `_classifySealedShred` shim + `(coll as any)` stay until Task 10. Acceptance: `grep -rn "shape/via-classified" packages/hub/src/kernel` → nothing. FULL classified + R10 + reveal + encoding-conformance suites green; ceilings: collection.ts must NET-SHRINK (enforce body + imports leave).

---

### Task 7: via-blob — move + thin binding + vault cutover + bundle scenario

git mv `with-shape/blobs` → `shape/via-blob`; binding (brand `'blob'`, posture `{envelope,'none',true,true}`, declare + describeFragment + erase (purge participation §9); NO pipeline write hooks — out-of-band per §8); `blobFields` sugar + `_viaBrand: 'blob'`; vault.ts's 3 value imports (§7: export-blobs, blob-compaction) → strategy-port/registry delegation keeping `exportBlobs`/`compact` golden-locked signatures (vault.ts is ZERO-slack: reclaim by the delegation shrink); blob bundle scenario added to `check-bundle.mjs` (withBlobs on, assert floor excludes `class BlobSet` — extend the existing canary). Blob suites + goldens green.

---

### Task 8: Posture enforcement — query

Parity pins FIRST (today's classified refusal errors on where/orderBy/aggregate over classified fields — exact error classes/messages; det-exact `_bidx` equality path works; money ordered + i18n full unchanged), then flip: the DSL consults `pipeline.postureFor(field)?.queryable` (new small pipeline accessor) instead of per-feature branches. Query-refusal + sealed-query-refusal.test-d suites green UNCHANGED.

---

### Task 9: Posture enforcement — export

Parity pins FIRST (export fixtures byte-locked: classified fields appear as today's sealed/redacted forms via the toJSON accident), then flip: `exportStream`/bundle path consults `posture.exportable` and redacts deliberately; the SealedHandle.toJSON accident REMAINS (belt-and-braces — assert both layers independently: a test that disables the deliberate layer still gets `'[sealed]'`). Export + export-dict + export-i18n-layer suites green.

---

### Task 10: Posture enforcement — forget + erase hooks live

The risky one. Parity pins FIRST (forget-erasure suites already lock reports/residue — run them as the pin), then: `vault.forget()` consults `posture.forgettable` and invokes `pipeline.erase(ctx)`; classified participation (sealed-CEK prefix-deletes + shred/residue classification) flows through via-classified's erase hook; blob purge through via-blob's; **the `(coll as any)` casts die** (replace with typed `_onViaErase`-style collection method or direct pipeline access); `_classifySealedShred` shim retired if nothing else calls it. Forget/erasure + tiers suites green UNCHANGED; erasure reports byte-identical.

---

### Task 11: Guards, ceilings, docs, changeset prep

Verify: `VIA_ENCLAVE_ALLOWLIST` empty + fires; `VIA_SHAPE_ALLOWLIST` still exactly join.ts; ceilings re-ratcheted DOWN to new actuals (#629 comments); full gauntlet (suite/typecheck×3/lint/arch/build/bundle-check/knip-attribution). Docs: `docs/subsystems/via.md` phase-B status flip + `via-classified.md`/`via-blob.md` pages (SHIPPED-API examples ONLY — read the real tests first; the phase-A docs lesson is binding), SERVICES.md line. Commit.

---

## Final steps (execution skill handles)

Full hub suite green; changeset `@noy-db/hub: minor` (via-classified/via-blob + posture enforcement + ViaCryptoCtx; note the grandfather deletion); whole-branch review on the most capable model (mutation-test: the empty enclave allowlist, one posture parity pin, the sealed-slot capability scope checks; verify zero-knowledge — grep via features for keyring/DEK access); PR against main (do NOT merge — human gate).
