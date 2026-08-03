# pod-header fields (#942) Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development. Checkbox steps.

**Goal:** Add five OPTIONAL plaintext header fields to the `.noydb` pod (`engineRange`, `unlockMethods`, `hasApp`, `species`, `pointerMode`) — the Header layer (L2) a dispatcher/landing reads pre-auth. Closes #942 (milestone #46). Additive on top of the merged #943 signature layer.

**Architecture:** Extends the same four spots in `with-pod/format.ts` #943 touched (`ALLOWED_HEADER_KEYS`, `NoydbPodHeader`, `validateBundleHeader`, `encodeBundleHeader`), plus `WritePodOptions`/`assembleBundleContainer` passthrough. Because the header signature covers "whole header minus sig", the new fields join the signature automatically — a guarded regression test proves it.

**Tech Stack:** TypeScript ESM, vitest, pnpm.

## Global Constraints

- Branch `feat/942-pod-header-fields` (off main, has #943). Commit per task. **NEVER add Claude/AI attribution.**
- Allowlist stays CLOSED — these 5 are the only additions; forbidden list (timestamps/identities/kdf) stands; unknown keys still hard-reject.
- All 5 optional: a legacy pod (none present) parses + round-trips unchanged; unsigned v1 pods unaffected; the #943 all-or-nothing sig-tuple invariant survives.
- No new exports expected (fields ride the already-exported `NoydbPodHeader`); if a golden trips, investigate — do NOT touch `cargo-surface`.
- After changes: `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub check:types` (dist-based, after build), `test`, `pnpm check:architecture`, `lint`, `typecheck` — all green.
- Coordinate w/ #943 (already merged): append to the allowlist literal after the sig keys; keep it append-friendly.

## Field spec (from #942)

| field | type | default | discloses |
|---|---|---|---|
| `engineRange` | `string` | — | engine version range that wrote/reads the pod (version-skew triage) |
| `unlockMethods` | `readonly ('password'\|'webauthn'\|'oidc'\|'totp'\|'email-otp'\|'magic-link'\|'pin'\|'recovery'\|'shamir')[]` | — | declared unlock method(s) so a landing shows the right UI pre-library |
| `hasApp` | `boolean` | — | app-manifest presence (orphan-vs-linked fork) |
| `species` | `'full'\|'connection'\|'snapshot'\|'redirect'\|'group'` | — | artifact species hint (dispatcher branching) |
| `pointerMode` | `'public'\|'private'` | `private` | whether the app pointer is disclosed pre-auth (author opt-in to public) |

(For `unlockMethods` values, check the real `on-*` method names / any existing UnlockMethod union in hub before finalizing the string literal set — mirror what exists; if a canonical union exists, reference it, else use the on-* family names. Document the choice.)

---

### Task 1: format.ts — five header fields + validators + doc

**Files:** Modify `packages/hub/src/with-pod/format.ts` (`NoydbPodHeader` ~:105-191, `ALLOWED_HEADER_KEYS` ~:210-215, `validateBundleHeader` per-field ~:230-360 + no new cross-field invariant needed unless `pointerMode` default handling wants one, `encodeBundleHeader` order ~:410-425). Test: `packages/hub/__tests__/pod-header-fields.test.ts` (create).

**Interfaces produced:** `NoydbPodHeader` gains the 5 optional fields above with minimum-disclosure doc comments (each states what it discloses + why it's safe, matching the existing forbidden-keys block style).

- [ ] **Step 1: failing test** — `validateBundleHeader` accepts a header with all 5 fields (valid values); rejects bad values per field (e.g. `species: 'bogus'` → throw; `pointerMode: 'weird'` → throw; `unlockMethods` non-array or bad member → throw; `hasApp` non-boolean → throw; `engineRange` non-string → throw); a header with NONE of the 5 (legacy) still validates; unknown key `foo` still rejects; `encodeBundleHeader`→`decodeBundleHeader` round-trips all 5. Build a valid base header by copying a fixture shape from `bundle.test.ts`/`pod-format-v2.test.ts`.
- [ ] **Step 2: run red.**
- [ ] **Step 3: implement** — add fields to interface (with doc comments); add the 5 keys to `ALLOWED_HEADER_KEYS` (after the sig keys); add a per-field validator block for each in `validateBundleHeader` (string / string-enum / boolean / string-array-of-enum); append the 5 conditional spreads to `encodeBundleHeader` in a fixed order after the existing fields. No version bump needed (these are optional additive keys like the sig tuple; confirm the issue doesn't mandate a version — it doesn't, absence=legacy).
- [ ] **Step 4: run green** + `pnpm vitest run packages/hub/__tests__/bundle.test.ts packages/hub/__tests__/pod-format-v2.test.ts` (no regression) + typecheck + check:architecture.
- [ ] **Step 5: commit** — `feat(hub): pod header L2 fields — engineRange/unlockMethods/hasApp/species/pointerMode (#942)`

---

### Task 2: writePod/readPod passthrough + signature coexistence + docs + gates

**Files:** Modify `packages/hub/src/with-pod/bundle.ts` (`WritePodOptions` — add the 5 as optional; `writePod` flow → pass them into `assembleBundleContainer` via `headerExtras`; `assembleBundleContainer`'s `headerExtras` `Pick` union widens to include the 5). `readPodHeader` already returns the whole header — no change needed, just test it. Modify `docs/reference/architecture.md` (minimal-disclosure section — find it; if the path differs, grep docs for the minimum-disclosure/header list and update the real file). Test: `packages/hub/__tests__/pod-header-fields-write.test.ts` (create). Changeset `.changeset/pod-header-fields.md`.

- [ ] **Step 1: failing test** — `writePod(vault, { engineRange, unlockMethods, hasApp, species, pointerMode })` → `readPodHeader(bytes)` returns all 5 verbatim; a `writePod` with none of them → header has none (legacy-shaped) and round-trips; **THE SEAM TEST**: a vault with a minted signer → `writePod` with the 5 fields → `verifyPodHeader(bytes, { [keyId]: pub })` returns `'verified'` (proves the new fields are inside the signed bytes and don't break the signature). Mirror the signer-mint setup from `pod-signature-write.test.ts`.
- [ ] **Step 2: run red.**
- [ ] **Step 3: implement** the `WritePodOptions` + `assembleBundleContainer` passthrough. Keep `extractPartition`'s call compiling. Update the architecture doc's disclosure list with the 5 new fields (same rationale style).
- [ ] **Step 4: full gates** — build, check:types (after build; the fields ride `NoydbPodHeader` which is already exported, so likely 0 new gaps — confirm), test (full hub suite), check:architecture, lint, typecheck. Author changeset (`'@noy-db/hub': minor`).
- [ ] **Step 5: commit** — `feat(hub): writePod/readPodHeader carry L2 header fields + docs + changeset (#942)`

## Out of scope
- `species: 'redirect'` runtime semantics (#944); consuming the fields in a dispatcher (Studio-side, milestone DoD consumer pass); #946 identifiers (separate PR).
