# pod-signature (#943) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ed25519 authentication for the `.noydb` pod — a signed header + a reusable record sign/verify convention — built on the published `@noy-db/attestation` and the hub's persisted per-vault signer, so the public read-only player can verify a pod with nothing but pod bytes + WebCrypto. Closes noy-db #943 (milestone #46, L3).

**Architecture:** New `with-pod/signature.ts` module holds the ONE signing convention (`canonicalJson(payload minus sig) → utf8 → ed25519`). The pod header gains `sig`/`keyId`/`alg` at a new `formatVersion: 2` (v1 stays the unsigned wire form — full back-compat). `writePod` signs by default when the vault already has a persisted signer (read-only `loadSigner`, never mint-on-export). `verifyPodHeader(bytes, trustedKeys)` is pure + dependency-free. Same sign/verify pair is exported for the Redirect record (#944) and manifest writes (#941) so the family has exactly one convention.

**Tech Stack:** TypeScript ESM, WebCrypto-only (`crypto.subtle`, Ed25519), `@noy-db/attestation` (already hub's only runtime dep), vitest.

## Global Constraints

- Branch `feat/943-pod-signature` (off main). Commit per task. **NEVER add Claude/AI attribution.**
- Reach crypto via `@noy-db/attestation` (published) and the `kernel/enclave/index.js` barrel only. `@noy-db/attestation` is NOT in the no-crypto-deps denylist — no exemption needed.
- `check-architecture.mjs` PRE_EXISTING_BODY_ACCESS caps `with-pod/bundle.ts` at 2 protected-body-field accesses — do NOT add envelope `_iv`/`_data`/`_cek` handling to the pod sign path; the signer module (`with-audit/attestation/signer.ts`) already owns that budget. Keep signing over plaintext header JSON only.
- `kernel/vault.ts` ceiling is tight (2 lines slack as of the echo arc; re-measure before touching — `node -e "console.log(require('fs').readFileSync('packages/hub/src/kernel/vault.ts','utf8').split('\n').length)"` vs the ceiling in check-architecture.mjs). Prefer an `_`-prefixed Vault method (filtered out of the kernel-api golden) or an options-injection seam over a public method. Do NOT touch collection.ts/noydb.ts.
- Goldens that will trip and MUST be updated in the same commit as their export/method: `pod-surface.golden.json` (+ the `_FrozenTypes` tuple + `import type` list in `pod-surface-golden.test.ts`), `root-barrel-surface.golden.json`, `kernel-api.golden.json` (only if a non-`_` Vault method is added). `cargo-surface` must NOT change.
- Format law: new header keys require a `formatVersion` bump + a new validator branch. Signed pods write `formatVersion: 2`; unsigned pods keep writing `1`. A v1 reader meeting a v2 pod fails with a clean version error.
- `canonicalJson` (from `@noy-db/attestation`) THROWS on `undefined`/`function`/`bigint`/non-finite and sorts object keys; the signed object must contain only defined JSON scalars/arrays/objects and must OMIT absent optional fields (never set them to `undefined`).
- After any content/export change run: `pnpm --filter @noy-db/hub build` THEN `pnpm --filter @noy-db/hub check:types` (dist-based reachability gate — NOT in the default lint/test set; it has bitten this codebase, always run it), plus `pnpm --filter @noy-db/hub test`, `pnpm check:architecture`, `pnpm lint`, `pnpm typecheck`.
- **Coordinate with #942** (extends the same four spots in format.ts). This plan builds the signed bytes as "whole header minus `sig`", so #942's later fields join the signature with no revisit. Leave the allowlist/validator/encoder edits in a shape that #942 can extend by adding lines, not restructuring.

## Trust model (implement as specified; documented in Task 6)

- The vault's Ed25519 **public key travels in the encrypted body** (post-unlock trust: a caller who unlocks learns the key and can pin it for next time).
- Its **`keyId` (16-hex fingerprint) rides in the plaintext header** (pre-unlock pinning: a landing that already knows a key can check the fingerprint before unlock).
- `verifyPodHeader(bytes, trustedKeys)` takes caller-supplied trusted keys — the function itself has zero library deps; key acquisition/pinning is the caller's (TOFU / out-of-band / prior-unlock). `sig` absent → result `{ status: 'unsigned' }`, NEVER silently equal to verified.

---

### Task 1: The signing convention — `with-pod/signature.ts`

**Files:**
- Create: `packages/hub/src/with-pod/signature.ts`
- Test: `packages/hub/__tests__/pod-signature-core.test.ts`

**Interfaces produced:**
```ts
export const POD_SIG_ALG = 'ed25519' as const
/** Sign an arbitrary canonical record. `payload` MUST already exclude any `sig` field. */
export async function signRecord(privateKeyPkcs8B64: string, payload: Record<string, unknown>): Promise<string> // base64url sig
/** Verify. `payload` is the record WITHOUT `sig`. Fails closed (false) on any malformed input. */
export async function verifyRecord(publicKeyB64: string, sig: string, payload: Record<string, unknown>): Promise<boolean>
/** The exact bytes a signature covers: utf8(canonicalJson(payload)). Exported for cross-checking. */
export function signedBytes(payload: Record<string, unknown>): Uint8Array
```

Implementation: `signedBytes` = `utf8(canonicalJson(payload))` (both imported from `@noy-db/attestation`). `signRecord` = `ed25519Sign(priv, signedBytes(payload))`. `verifyRecord` = `ed25519Verify(pub, sig, signedBytes(payload))`. No pod/vault imports — this is the family-wide primitive.

- [ ] **Step 1: Failing test** — assert: sign→verify round-trips a `{a,b}` record; verify fails on a mutated payload; verify fails on a swapped key; `signedBytes` is stable across key-order-permuted input objects (canonicalJson sorts) — build `{a:1,b:2}` and `{b:2,a:1}`, assert `signedBytes` equal; a payload containing `undefined` throws (documents the omit-don't-undefined rule).

```ts
import { describe, it, expect } from 'vitest'
import { signRecord, verifyRecord, signedBytes, POD_SIG_ALG } from '../src/with-pod/signature.js'
import { generateDocSigningKeyPair } from '@noy-db/attestation'

describe('pod signing convention', () => {
  it('round-trips and rejects tamper / wrong key / alg swap surface', async () => {
    const k = await generateDocSigningKeyPair()
    const payload = { alg: POD_SIG_ALG, keyId: k.keyId, bodySha256: 'ab'.repeat(32), formatVersion: 2 }
    const sig = await signRecord(k.privateKeyPkcs8B64, payload)
    expect(await verifyRecord(k.publicKeyB64, sig, payload)).toBe(true)
    expect(await verifyRecord(k.publicKeyB64, sig, { ...payload, bodySha256: 'cd'.repeat(32) })).toBe(false)
    expect(await verifyRecord(k.publicKeyB64, sig, { ...payload, alg: 'evil' })).toBe(false) // alg is inside signed bytes
    const other = await generateDocSigningKeyPair()
    expect(await verifyRecord(other.publicKeyB64, sig, payload)).toBe(false)
  })
  it('signedBytes is key-order-independent and rejects undefined', () => {
    expect(signedBytes({ a: 1, b: 2 })).toEqual(signedBytes({ b: 2, a: 1 }))
    expect(() => signedBytes({ a: undefined as unknown as number })).toThrow()
  })
})
```

- [ ] **Step 2: Run → fail** (`pnpm vitest run packages/hub/__tests__/pod-signature-core.test.ts`).
- [ ] **Step 3: Implement `signature.ts`.**
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(hub): pod signing convention — signRecord/verifyRecord over @noy-db/attestation (#943)"`

---

### Task 2: Format v2 — header sig fields

**Files:**
- Modify: `packages/hub/src/with-pod/format.ts` (`NoydbPodHeader` :105-168; `ALLOWED_HEADER_KEYS` :179-188; `validateBundleHeader` :205-326; `encodeBundleHeader` order :339-348; `NOYDB_BUNDLE_FORMAT_VERSION` const)
- Test: `packages/hub/__tests__/pod-format-v2.test.ts`

**Interfaces produced:** `NoydbPodHeader` gains optional `sig?: string`, `keyId?: string`, `sigAlg?: 'ed25519'` (named `sigAlg` to avoid confusion with `transferSeal.alg`; wire key is `sigAlg`). New `formatVersion` value `2` accepted. Keep `NOYDB_BUNDLE_FORMAT_VERSION = 1` as the DEFAULT written for unsigned pods; add `NOYDB_BUNDLE_FORMAT_VERSION_SIGNED = 2`.

Details:
- Allowlist: add `'sig'`, `'keyId'`, `'sigAlg'`. Leave the Set literal one-key-per-concept so #942 appends cleanly.
- `formatVersion` validator (:226-232): accept `1` or `2`. Add a cross-field invariant near :302-325: `sig`/`keyId`/`sigAlg` are a 3-tuple — all present or all absent (partial → throw); if present, `formatVersion` must be `2`; `keyId` matches `/^[0-9a-f]{16}$/`, `sig` non-empty base64url `/^[A-Za-z0-9_-]+$/`, `sigAlg === 'ed25519'`.
- `encodeBundleHeader` (:339-348): append the three spreads AFTER the existing fields, in the fixed order `sig`, then `keyId`, then `sigAlg`. **Signed bytes are computed by the signer over the header object with `sig` omitted — encode order only affects wire bytes, not the signature (canonicalJson re-sorts).** Document this at the encoder.
- Doc the new fields in the `NoydbPodHeader` comment block in the established minimum-disclosure style: `keyId` is a non-secret fingerprint (safe — it's a hash prefix, discloses no crypto config); `sig`/`sigAlg` authenticate the header.

- [ ] **Step 1: Failing test** — `validateBundleHeader` accepts a v2 header with the full sig-tuple; rejects a partial tuple (sig without keyId); rejects sig-tuple with `formatVersion: 1`; rejects bad keyId shape; a v1 header with no sig still validates (back-compat); `encodeBundleHeader`→`decodeBundleHeader` round-trips a signed header. (Use `validateBundleHeader`/`encodeBundleHeader`/`decodeBundleHeader` from `../src/with-pod/format.js`.)
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the four edits + the two version consts.
- [ ] **Step 4: Run → pass** + `pnpm vitest run packages/hub/__tests__/bundle.test.ts` (no regression) + typecheck.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(hub): pod header v2 — sig/keyId/sigAlg fields + validator (#943)"`

---

### Task 3: Vault signer access seam

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` (add the accessor — measure ceiling first)
- Modify: `packages/hub/src/with-audit/attestation/signer.ts` ONLY if a re-export helps (likely not)
- Test: `packages/hub/__tests__/pod-signer-access.test.ts`

**Interface produced:** an internal seam giving `writePod` a `DocSigner | null` for the vault WITHOUT minting and WITHOUT requiring `withAttestation()`. Preferred shape: `_loadPodSigner(): Promise<DocSigner | null>` on `Vault` (the `_` prefix keeps it out of the kernel-api golden). It calls `loadSigner(this.adapter, this.name, this.getDEK)` (all three are in-scope private members of Vault per the exploration). `loadSigner` is read-only and role-agnostic — correct for export (a non-owner exporting a pod signs with the vault's existing key if one exists; if none exists, returns null → unsigned pod, no mint, no owner-gate trip).

**Ceiling contingency:** if adding the method breaks the vault.ts ceiling, extract an existing cohesive block in vault.ts into a sibling module first (shrink-first) — pick the smallest self-contained private helper cluster; record what you moved. Do NOT lower any other file's function to make room.

- [ ] **Step 1: Failing test** — create a vault via `createNoydb`, confirm `_loadPodSigner()` returns null before any signer exists; then mint one (call the attestation issue path OR `loadOrCreateSigner` directly against the same store) and confirm `_loadPodSigner()` now returns a `DocSigner` with a 16-hex keyId + base64url public key. Access the private method in the test via a typed cast helper as other kernel tests do.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `_loadPodSigner`; measure ceiling; shrink-first only if needed.
- [ ] **Step 4: Run → pass** + `pnpm check:architecture` (kernel-surface ceiling + kernel-api golden must stay green — the `_` method must NOT appear in the golden; if it does, the golden's `_`-filter isn't catching it → rename to confirm the filter, report).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(hub): Vault._loadPodSigner — read-only per-vault signer access for pods (#943)"`

---

### Task 4: writePod signs by default

**Files:**
- Modify: `packages/hub/src/with-pod/bundle.ts` (`WritePodOptions` :105-257; `writePod` flow :1286-1339; `assembleBundleContainer` :1247-1279 — thread the signer/header-sign hook)
- Test: `packages/hub/__tests__/pod-signature-write.test.ts`

**Interface produced:** `WritePodOptions.sign?: false | DocSigner` — omitted ⇒ sign iff `vault._loadPodSigner()` returns non-null; `false` ⇒ never sign; explicit `DocSigner` ⇒ sign with it (injection for tests/advanced). The public key travels in the encrypted body: confirm `vault.dump()` already includes the `_attestations/_signer` record (it's a normal encrypted collection record, so a full dump carries it — VERIFY in the test by reading it back post-unlock; if `_attestations` is excluded from dump, add it to the signed-body inclusion and note the deviation).

Signing hook: in `assembleBundleContainer`, after the header object is built (:1261-1270) and BEFORE `encodeBundleHeader` (:1271): if a signer is provided, compute `sig = signRecord(signer.privateKeyPkcs8B64, { ...header, keyId: signer.keyId, sigAlg: 'ed25519' })` — note the signed payload INCLUDES keyId+sigAlg but NOT sig — then set `header.formatVersion = 2`, `header.sig = sig`, `header.keyId = signer.keyId`, `header.sigAlg = 'ed25519'`. Thread the signer from `writePod` (resolve via options/`_loadPodSigner`) into `assembleBundleContainer` via a new `headerExtras.signer` or a dedicated param — keep `extractPartition`'s call site compiling (pass no signer there for v1; partitions stay unsigned unless a follow-up says otherwise — note it).

- [ ] **Step 1: Failing test** — owner vault with a minted signer: `writePod(vault)` produces bytes whose `readPodHeader` shows `formatVersion: 2`, a 16-hex `keyId`, non-empty `sig`, `sigAlg: 'ed25519'`. `writePod(vault, { sign: false })` → v1, no sig. A vault with NO signer → v1, no sig, and no signer row was created (assert `_attestations/_signer` still absent — no mint-on-export). Post-unlock, the recipient can read the public key from the restored body and it matches the signer's keyId.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → pass** + `pnpm vitest run packages/hub/__tests__/bundle.test.ts packages/hub/__tests__/bundle-recipients.test.ts` (no regression).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(hub): writePod signs the header by default when the vault has a signer (#943)"`

---

### Task 5: verifyPodHeader + read-path semantics

**Files:**
- Modify: `packages/hub/src/with-pod/bundle.ts` (new `verifyPodHeader`; reuse `parsePrefixAndHeader`)
- Test: `packages/hub/__tests__/pod-signature-verify.test.ts`

**Interface produced:**
```ts
export interface PodVerifyResult {
  readonly status: 'verified' | 'unsigned' | 'untrusted' | 'tampered'
  readonly keyId?: string   // present when the header carried a sig-tuple
}
/** Pure, WebCrypto-only. `trustedKeys`: map keyId → publicKeyB64 the caller already trusts. */
export async function verifyPodHeader(bytes: Uint8Array, trustedKeys: Readonly<Record<string, string>>): Promise<PodVerifyResult>
```
Logic: `parsePrefixAndHeader(bytes)` → header. No `sig` ⇒ `{ status: 'unsigned' }`. Has sig but `header.keyId` not in `trustedKeys` ⇒ `{ status: 'untrusted', keyId }`. Else `verifyRecord(trustedKeys[keyId], header.sig, header WITHOUT sig)` (strip only `sig`; keyId+sigAlg stay in the verified payload) → `verified` or `tampered`. Zero imports beyond `@noy-db/attestation` + local format helpers — no store, no enclave, callable from a static page.

Do NOT change `readPod`'s existing bodySha256 check or its signature (frozen). `verifyPodHeader` is a standalone additive verifier; `readPod` stays about integrity+decrypt. (A future issue may fold sig-status into `readPod` via `ReadNoydbBundleOptions`; out of scope here.)

- [ ] **Step 1: Failing test** covering every branch: signed pod + correct trustedKeys → `verified`; flip one body-independent header byte (re-encode a header with a mutated `bodySha256`) keeping the old sig → `tampered`; signed pod + empty trustedKeys → `untrusted`; unsigned (v1) pod → `unsigned`; **alg-swap**: hand-craft a header with `sigAlg` changed post-sign → `tampered` (proves alg is inside signed bytes); **browser-context / zero-dep**: the test imports `verifyPodHeader` and asserts it runs using only `globalThis.crypto` — add a guard that the module graph of signature.ts + the verify path pulls no store/enclave (assert by construction: verifyPodHeader called with only bytes+keys, no Vault). Legacy fixture (a pre-signature v1 pod from bundle.test.ts's existing fixtures) → `unsigned`, explicitly `expect(...).not.toBe('verified')`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `verifyPodHeader`.**
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(hub): verifyPodHeader — pure WebCrypto pod authentication with legacy-unsigned semantics (#943)"`

---

### Task 6: Exports, goldens, trust-model doc, changeset, gates

**Files:**
- Modify: `packages/hub/src/with-pod/index.ts` (export `verifyPodHeader`, `signRecord`, `verifyRecord`, `POD_SIG_ALG`, types `PodVerifyResult`)
- Modify: `packages/hub/src/index.ts` (root barrel — same, in the pod region :363-410)
- Modify: `packages/hub/__tests__/pod-surface.golden.json` + `pod-surface-golden.test.ts` (`_FrozenTypes` tuple + `import type` list); `root-barrel-surface.golden.json`
- Create: `docs/subsystems/pod-signature.md` (trust model) — check `docs/subsystems/` for the house doc style; if pod docs live elsewhere, match the neighbor
- Create: `.changeset/pod-signature.md`

- [ ] **Step 1: Add exports** (values + types separate, topic comment). Build, run the golden tests, add EXACTLY the printed names to the JSONs + the test's type tuple/import list. cargo-surface must not move.
- [ ] **Step 2: Trust-model doc** — key origin (public key in encrypted body; keyId in plaintext header), pre-unlock pinning vs post-unlock learning, `verifyPodHeader(bytes, trustedKeys)` contract, legacy-unsigned semantics (`sig` absent ≠ verified), the alg-in-signed-bytes anti-downgrade note, and that partitions are unsigned in v1. Cross-link the session-tiers/threat-model pages if a natural link exists.
- [ ] **Step 3: Changeset** `.changeset/pod-signature.md`:
```md
---
'@noy-db/hub': minor
---

Pod authentication (#943): the `.noydb` header is now Ed25519-signed by default when the vault has a persisted signer, verifiable by a dependency-free static page via `verifyPodHeader(bytes, trustedKeys)`. Header format v2 adds `sig`/`keyId`/`sigAlg` (v1 pods still read/write unsigned; `sig` absent is reported as `unsigned`, never silently verified). A reusable `signRecord`/`verifyRecord` convention (canonical JSON over `@noy-db/attestation`) is exported for the Redirect record and manifest writes. `alg` is inside the signed bytes (no downgrade).
```
- [ ] **Step 4: Full gates** — build, `check:types`, test (full), check:architecture, lint, typecheck. All green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(hub): export pod-signature surface + trust-model doc + changeset (#943)"`

## Out of scope (note in PR / file if surfaced)

- Signing `extractPartition` output (partitions stay unsigned v1).
- Folding sig-status into `readPod` (additive `verifyPodHeader` only for now).
- Redirect record (#944) and manifest re-point verification (#941) — they CONSUME `signRecord`/`verifyRecord`; not built here.
- Key revocation / rotation for pod signers (attestation has a revocation list; wiring it to pods is a follow-up).
