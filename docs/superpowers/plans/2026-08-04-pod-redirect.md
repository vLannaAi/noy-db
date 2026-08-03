# pod-redirect (#944) Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development.

**Goal:** One signed **Redirect record** (L4) — a "this moved, go there" pointer carried in the pod's **plaintext header** so a dispatcher follows it pre-auth (no secret, no decompression), plus a `followRedirects` resolver with capped depth, loop detection, typed failures, and hop provenance. Closes #944 (milestone #46). Reuses #943's `signRecord`/`verifyRecord`.

**Architecture:** The Redirect record lives in a new allowlisted `redirect` header key (same 4 spots #942/#943 touched in `with-pod/format.ts`), carrying its **own inner `sig`** (record-level, via `signRecord`, independently verifiable via `verifyRecord` + caller `trustedKeys` — separate from the #943 pod-header sig). `readPodRedirect(bytes)` mirrors `readPodCover` (sync, no secret). `followRedirects` is a fresh resolver in `with-pod/redirect.ts` (walkClosure is only a depth/loop *template* — it has no hop list). Errors in `kernel/errors.ts` (per the `PartitionExtractionError` shape), re-exported from the pod barrel.

**DESIGN DECISION (documented, flag in PR):** the record goes in the **plaintext header**, not the encrypted body. The issue text says "body carries this record," but its own AC/Relations require pre-auth following by a connection-pod open flow / the Landing dispatcher / a static page — which is impossible from the encrypted body. Header placement is the only design that satisfies the stated consumers. `species:'redirect'` (already in the header from #942) + `readPodRedirect` surface it.

**Tech Stack:** TS ESM, WebCrypto/@noy-db/attestation via signature.ts, vitest, pnpm.

## Global Constraints
- Branch `feat/944-pod-redirect` (off main; has #942/#943/#946). Commit per task. **NEVER add Claude/AI attribution.**
- Signature REQUIRED on a Redirect (new record type, no legacy install base): an unsigned/absent-sig redirect is INVALID (fail closed), not "unverified". Contrast with legacy unsigned pods.
- Minimum-disclosure: a redirect target (locator/URL) is disclosure-appropriate (a redirect's whole purpose is to point). Keep the record to `{ v, target, reason, issuedBy(keyId), sig }` — no timestamps/identities/kdf beyond the keyId fingerprint.
- Do NOT touch collection.ts (at 4329/4329 ceiling), vault.ts, noydb.ts. Work in with-pod/* + errors.ts.
- Gates after changes: build → check:types (after build) → test → check:architecture → lint → typecheck.
- Goldens: new exports (readPodRedirect, followRedirects, Redirect type + options/result types, 4 error classes) update pod-surface.golden.json (sorted) + `_FrozenTypes` tuple + import-type list, and root-barrel-surface.golden.json. `cargo-surface` must NOT move (build followRedirects inside with-pod, not with-cargo).

## Record shape (finalize here)
```ts
export interface Redirect {
  readonly v: 1
  readonly target: string          // locator string or URL (the #945 Locator type isn't built yet; string for now, note the forward-seam)
  readonly reason: 'moved' | 'release' | 'tombstone' | 'repoint'
  readonly issuedBy: string        // keyId (16-hex) of the signer
  readonly sig: string             // base64url ed25519 over signedBytes(record minus sig)
}
```
Sign: `signRecord(privKeyPkcs8B64, { v, target, reason, issuedBy })` (record MINUS sig). Verify: `verifyRecord(trustedKeys[record.issuedBy], record.sig, { v, target, reason, issuedBy })`. An issuedBy not in trustedKeys → treat as unverifiable → invalid for following (RedirectBadSignature or a distinct untrusted state — keep simple: fail closed as bad-signature with a clear message).

---

### Task 1: Redirect record — header field, record sign/verify, readPodRedirect

**Files:** `with-pod/format.ts` (NoydbPodHeader `redirect?: Redirect`; ALLOWED_HEADER_KEYS += 'redirect'; validateBundleHeader redirect validator; encodeBundleHeader append), new `with-pod/redirect.ts` (Redirect type, `signRedirect(signer, {target,reason})`, `verifyRedirect(record, trustedKeys)`), `with-pod/bundle.ts` (`readPodRedirect(bytes): Redirect | undefined` mirroring readPodCover; `WritePodOptions.redirect?: Redirect` threaded into the header via assembleBundleContainer headerExtras). Test: `pod-redirect-record.test.ts`.

- [ ] **Step 1: failing tests** — signRedirect→verifyRedirect round-trips (real DocSigner via generateDocSigningKeyPair); a tampered target fails verify; issuedBy not in trustedKeys → invalid; validateBundleHeader accepts a well-formed redirect header field, rejects a malformed one (bad reason, missing sig, non-string target); writePod({redirect}) → readPodRedirect(bytes) returns it verbatim; a pod with no redirect → readPodRedirect === undefined. Mirror pod-signature-verify.test.ts fixture (inline toMemory, writePod).
- [ ] **Step 2: red.**
- [ ] **Step 3: implement.** The redirect header field is validated structurally (shape) by validateBundleHeader; signature verification is a SEPARATE step (verifyRedirect), not done at parse (a parser has no trustedKeys). Document that readPodRedirect returns the record UNVERIFIED (structural only) — the caller/ followRedirects verifies. Keep the header key append-friendly (after #942/#943 keys).
- [ ] **Step 4: green** + `pnpm vitest run packages/hub/__tests__/bundle.test.ts packages/hub/__tests__/pod-format-v2.test.ts packages/hub/__tests__/pod-header-fields.test.ts` (no regression) + typecheck + check:architecture. **Also confirm a signed pod carrying a redirect header field still verifyPodHeader→'verified'** (the redirect field is inside the #943 header signature by construction — add one assertion).
- [ ] **Step 5: commit** — `feat(hub): signed Redirect record in the plaintext pod header + readPodRedirect (#944)`

---

### Task 2: followRedirects resolver

**Files:** `with-pod/redirect.ts` (append `followRedirects`), `kernel/errors.ts` (4 error classes: RedirectDepthExceededError `REDIRECT_DEPTH_EXCEEDED`, RedirectLoopError `REDIRECT_LOOP`, RedirectBadSignatureError `REDIRECT_BAD_SIGNATURE`, RedirectUnreachableError `REDIRECT_UNREACHABLE` — per PartitionExtractionError shape). Test: `pod-redirect-follow.test.ts`.

**Interface:**
```ts
export interface RedirectHop { readonly target: string; readonly reason: Redirect['reason']; readonly issuedBy: string }
export interface FollowRedirectsResult { readonly terminal: Uint8Array; readonly hops: readonly RedirectHop[] }
/** fetcher: given a target string, return the pod bytes at that target (or throw/return null → unreachable). */
export async function followRedirects(
  start: Uint8Array,
  fetcher: (target: string) => Promise<Uint8Array | null>,
  opts: { readonly trustedKeys: Readonly<Record<string,string>>; readonly maxDepth?: number },
): Promise<FollowRedirectsResult>
```
Logic: at each hop, `readPodRedirect(bytes)`; if undefined → this is the terminal (return {terminal: bytes, hops}). If present → `verifyRedirect(record, trustedKeys)`; invalid → RedirectBadSignatureError. Track visited targets in a Set → repeat → RedirectLoopError. Increment depth; > maxDepth (default 8, small fixed constant) → RedirectDepthExceededError. `fetcher(target)` returns null/throws → RedirectUnreachableError. Accumulate hops (target/reason/issuedBy). Loop-detection + depth-cap patterned on walk-closure.ts:152-165 but with an ordered hop list.

- [ ] **Step 1: failing tests** — chain-of-2 (A→B→terminal) returns terminal + 2 hops in order; a loop (A→B→A) → RedirectLoopError; over-depth (chain longer than maxDepth) → RedirectDepthExceededError; a hop with a tampered/invalid sig → RedirectBadSignatureError; fetcher returns null → RedirectUnreachableError; a start pod that's already terminal (no redirect) → {terminal:start, hops:[]}. Build redirect pods via Task 1's writePod({redirect}) with a real signer; fetcher is an in-test Map<target, bytes>.
- [ ] **Step 2: red.**
- [ ] **Step 3: implement.**
- [ ] **Step 4: green** + typecheck + check:architecture.
- [ ] **Step 5: commit** — `feat(hub): followRedirects resolver — depth cap, loop detection, hop provenance, typed failures (#944)`

---

### Task 3: exports, goldens, docs, changeset, gates

**Files:** `with-pod/index.ts` + root `src/index.ts` (export Redirect, RedirectHop, FollowRedirectsResult, signRedirect, verifyRedirect, readPodRedirect, followRedirects, 4 error classes), goldens (pod-surface + root-barrel + `_FrozenTypes`), docs (extend `docs/subsystems/pod-signature.md` or a new `docs/subsystems/pod-redirect.md` — check house style; tombstone semantics + Redirect-vs-Locator), `.changeset/pod-redirect.md`.

- [ ] **Step 1: exports** (values/types separate, topic comment). Build, run pod-surface + root-barrel golden tests, add EXACTLY the new names (sorted) + `_FrozenTypes`/import-type. cargo-surface must not move.
- [ ] **Step 2: docs** — a "Redirect record" section: the record shape + record-level signature (fail-closed), header placement + why pre-auth, `followRedirects` contract + the typed failures, **tombstone semantics** (a decommissioned store writes a `reason:'tombstone'` Redirect so stale connection pods fail forward; where it lives; how an offline client shows the last-known re-point from its cached manifest generation), and **Redirect vs Locator** ("a Redirect says *go elsewhere once*; a Locator says *where cargo lives*" — the #945 Locator type is forthcoming; reference it as the sibling concept, don't blur).
- [ ] **Step 3: changeset** `.changeset/pod-redirect.md` (`'@noy-db/hub': minor`): signed Redirect record in the plaintext pod header (pre-auth followable) + followRedirects resolver (depth cap, loop detection, hop provenance, typed failures); required-signature/fail-closed; reuses the #943 record-signing convention.
- [ ] **Step 4: full gates** — build, check:types, test (full), check:architecture, lint, typecheck.
- [ ] **Step 5: commit** — `docs(hub): pod-redirect exports + tombstone/Redirect-vs-Locator doc + changeset (#944)`

## Out of scope
- The #945 Locator type (`target` is a string for now, forward-seam noted).
- Fleet-member references (klum-side, separate repo).
- Any store actually WRITING a tombstone on decommission (that's store/connection-pod wiring; #944 defines the record + resolver + docs the semantics).
