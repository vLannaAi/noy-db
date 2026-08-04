# WebAuthn non-PRF reclassify (#963 finding 1) Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development.

**Goal:** Stop the WebAuthn non-PRF fallback from producing a self-decrypting confidentiality wrap (the DEK-map wrapping key derives entirely from `credentialId`, stored cleartext in the same record). Reclassify non-PRF as NOT a cryptographic confidentiality factor — real confidentiality requires the passphrase or a PRF-capable credential. Closes #963 finding 1. Self-contained in `@noy-db/on-webauthn`.

**Architecture:** Reject non-PRF **enrollment/wrap** by default (throw the already-declared-but-never-thrown `WebAuthnPRFUnavailableError`), so no new self-decrypting record can be produced. Keep `unlockWebAuthn` back-compatible (don't brick any existing non-PRF record — they were never confidential; document that). Correct every doc site that claims non-PRF confidentiality.

## Locked decision (maintainer)
Reclassify (NOT pepper). Non-PRF must never wrap a real DEK map into a standalone-decryptable record. The cleanest fit given the surface: reject non-PRF for the confidentiality wrap and reuse `WebAuthnPRFUnavailableError` (dead code today); `prfUsed` discriminator already exists.

## Global Constraints
- Branch `feat/963-webauthn-reclassify` (off main). Commit per task. **NEVER add Claude/AI attribution.**
- Behavior change is contained to `packages/on-webauthn/src/index.ts` (hub does NOT import on-webauthn; consumers wire the ceremony — a non-PRF device now gets a clear error and must use passphrase/PRF). Pre-1.0.
- Gates: `pnpm --filter @noy-db/on-webauthn test` + typecheck + build + `pnpm lint`. (Its tests run against the published hub per satellite law; in-repo, run the package's vitest.)

## Verified source facts (from recon)
- `deriveKeyFromRawId(rawId)` `index.ts:259-279` — derives wrap key entirely from rawId (constant salt/info). `deriveKeyFromPRF` `:233-253`.
- `enrollWebAuthn` `:412-499` — silent fallback at `:481-483` (`prfOutput ? deriveKeyFromPRF : deriveKeyFromRawId`); stores `credentialId = base64(rawId)` `:491` beside `wrappedPayload`/`wrapIv` `:495-496`. `wrapKeyringSummary` `:312-339` wraps the full DEK map + identity + salt.
- `unlockWebAuthn` `:517-573` — non-PRF branch `:568-570` re-derives from `assertion.rawId` (= the record's own credentialId → self-decrypting).
- `webAuthnSlotRewrapCeremony` `:622-784` — same non-PRF derivation `:698-712`.
- `WebAuthnPRFUnavailableError` `:130-140` — DECLARED, NEVER THROWN (dead). No `strictPrf` option on `WebAuthnEnrollOptions` `:173-197`.
- Tests encoding the WRONG (self-decrypting) invariant: `on-webauthn.test.ts:281-300` (non-PRF enroll→unlock round-trips), `:217-224` (non-PRF enroll succeeds), `slot-rewrap-ceremony.test.ts:237-291` (non-PRF rewrap round-trips).

---

### Task 1: reject non-PRF confidentiality wrap + tests

**Files:** `packages/on-webauthn/src/index.ts` (`enrollWebAuthn` fallback :481-483; `webAuthnSlotRewrapCeremony` non-PRF branch :698-712; `WebAuthnEnrollOptions` :173-197). Tests: rewrite `on-webauthn.test.ts` non-PRF cases + `slot-rewrap-ceremony.test.ts` non-PRF case.

**Behavior:**
- `WebAuthnEnrollOptions` gains `allowNonPrfInsecure?: boolean` (default FALSE). When PRF is absent at enroll and `!allowNonPrfInsecure` → throw `WebAuthnPRFUnavailableError` (BEFORE building any wrap) instead of calling `deriveKeyFromRawId`. Doc the option as: "non-PRF WebAuthn cannot provide confidentiality (the wrapping key derives from data stored in the record); enrollment refuses it unless you explicitly acknowledge it is not a confidentiality factor. Prefer the passphrase or a PRF-capable credential."
- Same guard in `webAuthnSlotRewrapCeremony`'s non-PRF branch (refuse to rewrap a slot into a non-PRF self-decrypting wrap unless `allowNonPrfInsecure`).
- **`unlockWebAuthn` stays back-compatible** — it must still unlock an EXISTING non-PRF record (don't brick migrators), but update its docstring to state non-PRF unlock is not zero-knowledge. Do NOT change the unlock crypto.
- Keep `deriveKeyFromRawId` (still used by the acknowledged-insecure path + existing-record unlock), but it is no longer reachable from a default enroll.

- [ ] **Step 1: failing tests** — (a) non-PRF `enrollWebAuthn` (prfOutput null, default options) → rejects with `WebAuthnPRFUnavailableError` (no record produced); (b) non-PRF enroll WITH `allowNonPrfInsecure: true` → still produces a record (escape hatch works) — and a test asserting that record is (by design) self-decryptable, documenting the acknowledged-insecure semantics; (c) PRF enroll unaffected (round-trips, prfUsed true); (d) unlock of an EXISTING non-PRF record still works (back-compat — build one via allowNonPrfInsecure, then unlock); (e) `webAuthnSlotRewrapCeremony` non-PRF without ack → rejects. Rewrite the 3 wrong-invariant tests to these. Use the existing stubWebAuthn/mockCreateCredential(prfOutput:null) fixture.
- [ ] **Step 2: run red.**
- [ ] **Step 3: implement** the guard + option.
- [ ] **Step 4: green** + `pnpm --filter @noy-db/on-webauthn typecheck` + build.
- [ ] **Step 5: commit** — `fix(on-webauthn): non-PRF WebAuthn is not a confidentiality factor — refuse the self-decrypting wrap by default (#963)`

---

### Task 2: docs + SECURITY.md + changeset + gates

**Files:** `packages/on-webauthn/src/index.ts` doc comments (header :19-25; `deriveKeyFromRawId` :255-257; `WebAuthnPRFUnavailableError` :119-140; `unlockWebAuthn` :501-516), `packages/on-webauthn/README.md` (:7 ZK claim, :29-38 unlock example), root `SECURITY.md` (rows :34 "cloud admin reads data", :38 "compromised biometric store", :25 biometric primitive), root `README.md` (:37/:41/:43/:147 trust-boundary — confirm they now hold: non-PRF no longer wraps confidentiality by default). `.changeset/webauthn-reclassify.md`.

- [ ] **Step 1: doc edits** — every site: non-PRF WebAuthn provides a liveness/presence assertion but NOT confidentiality (its wrap key derives from data in the record); confidentiality requires the passphrase or a PRF-capable authenticator. Correct `deriveKeyFromRawId`'s understated "rawId may be observable" comment to "rawId IS the entire secret and is stored in the record — self-decrypting." Fix the `WebAuthnPRFUnavailableError` docstring (the "strict PRF-only mode" it references now actually exists as the default). SECURITY.md: the "cloud admin reads data / zero-knowledge" row now holds because non-PRF no longer self-wraps by default (note the acknowledged-insecure escape hatch as a documented non-ZK opt-in); the biometric rows distinguish PRF (enclave-bound) from non-PRF (not a confidentiality factor).
- [ ] **Step 2: changeset** `.changeset/webauthn-reclassify.md` (`'@noy-db/on-webauthn': minor` — behavior change; note it's a security-hardening): non-PRF WebAuthn enrollment now refuses to produce a self-decrypting confidentiality wrap by default (`WebAuthnPRFUnavailableError`); non-PRF is a presence gate, not a confidentiality factor; existing non-PRF records still unlock (back-compat) but are documented as non-ZK; opt back in with `allowNonPrfInsecure`.
- [ ] **Step 3: gates** — `pnpm --filter @noy-db/on-webauthn build && test && typecheck` + `pnpm lint`.
- [ ] **Step 4: commit** — `docs(on-webauthn): correct non-PRF confidentiality claims (index/README/SECURITY) + changeset (#963)`

## Out of scope
- in-rest (finding 2 — separate PR); presence.ts + on-pin (separate small PR).
- A device-stored pepper (explicitly not chosen).
