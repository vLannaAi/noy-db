# Document Attestation ③ — Magic-Link Share Capability design

**Status:** sub-system spec (③ hardening) → ready for plan
**Date:** 2026-05-31
**Relates to:** the ③ recipe `recipes/aws-kms-pdf-attestation/` (merged PR #239) and its spec `docs/superpowers/specs/2026-05-30-attestation-kms-pdf-recipe-design.md` (§6 flagged `authType: NONE` as a demo simplification needing production authz). Depends on the merged `@noy-db/attestation` (for `canonicalJson`/`utf8`).

## 1. Goal

Replace the recipe's unauthenticated `?docId=` access with a **magic link**: a data-holder who can already issue/seal a document mints an unforgeable, self-expiring URL and shares it with a public audience. The render Lambda validates the link **itself** — **no AWS authorizer, no Cognito, no IdP**. Authorization collapses into a cryptographic capability (a signed token in the URL), not an authenticated principal.

**The deliverable is closing the open door, not adding a token path beside it.** Today `makeHandler` renders a PDF for anyone who knows or guesses a `docId`. After this change **there is no path to fetch by bare docId** — every request must carry a valid, unexpired signed token or it is rejected (403). The Function URL stays `authType: NONE` at the AWS layer; the Lambda becomes the gate.

**Decisions locked in brainstorming + grounded in repo precedent:**
- **Stateless signed capability token** (no server-side store).
- **Local HMAC-SHA256** with a KMS-sealed secret — the repo idiom: `@noy-db/on-totp` does local WebCrypto HMAC; `@noy-db/at-aws-kms` seals secret material at rest. (NOT `@noy-db/on-magic-link` — that is a *stateful* ULID-token + server-store model that derives a viewer KEK; wrong fit for a store-free Lambda, though its conventions — `expiresAt` ISO, 24h default TTL — transfer. NOT KMS GenerateMac/VerifyMac — that adds a KMS call per verify on every page-open; local HMAC is faster/cheaper and verifies offline.)
- **Firm-side minting** — a helper alongside `sealAndUpload`, run in the hub/firm context that already holds the KMS-sealed secret.
- **Multi-use within the TTL is the requirement** (shareable public-audience bearer capability), not a flaw.

## 2. Token format

URL shape (Function URL query string):
```
https://<fn-url>/?d=<docId>&exp=<epochMs>&sig=<base64url>
```
- **Signed material:** `utf8(canonicalJson({ v: 1, docId, exp }))` — reuse `@noy-db/attestation`'s `canonicalJson` + `utf8` (already a recipe dep). Canonical, unambiguous encoding (no raw `docId|exp` concatenation, which is parse-ambiguous). **`v` is inside the signed bytes** so a future format change can't be downgrade-attacked (the attestation core's locked lesson: sign the version).
- **`exp`:** absolute expiry in **epoch milliseconds** (one agreed unit), checked `nowMs < exp`.
- **`sig`:** `base64url(HMAC-SHA256(secret, signedMaterial))`.

## 3. Verify (read path) — `src/share-link.ts`

```ts
export interface ShareTokenParams { d?: string; exp?: string; sig?: string }
export type ShareVerdict =
  | { ok: true; docId: string }
  | { ok: false; reason: 'missing-token' | 'malformed' | 'expired' | 'invalid-signature' }

export async function verifyShareToken(
  params: ShareTokenParams,
  secret: Uint8Array,
  nowMs: number,
): Promise<ShareVerdict>
```
Algorithm:
1. If `d`/`exp`/`sig` any missing → `{ ok:false, reason:'missing-token' }`.
2. Parse `exp` to a finite integer; non-numeric → `malformed`.
3. If `nowMs >= exp` → `expired`.
4. Recompute `signedMaterial = utf8(canonicalJson({ v:1, docId:d, exp:Number(exp) }))`; import `secret` as an HMAC-SHA256 key with usage `['verify']`; **`crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), signedMaterial)`** — constant-time, never recompute-and-`===` (a manual compare is a timing oracle). false → `invalid-signature`.
5. all-pass → `{ ok:true, docId:d }`.

## 4. Mint (firm side) — `src/share-link.ts` (same file, mint + verify are one unit)

```ts
export interface MintShareLinkOptions {
  secret: Uint8Array
  baseUrl: string         // the deployed Function URL
  ttlMs?: number          // default SHARE_LINK_DEFAULT_TTL_MS
  nowMs?: number          // injectable for tests
}
export async function mintShareLink(docId: string, opts: MintShareLinkOptions): Promise<string>

export const SHARE_LINK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000   // 24h (matches on-magic-link)
export const SHARE_LINK_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 7d cap
```
- `ttlMs` clamped to `SHARE_LINK_MAX_TTL_MS` (a minter can't fat-finger a decade-long link).
- `exp = (nowMs ?? Date.now()) + ttlMs`; compute the same HMAC; return `${baseUrl}?d=${docId}&exp=${exp}&sig=${sig}`.
- Pure — no AWS, fully CI-testable.

## 5. Handler gating — `src/handler.ts`

`HandlerDeps` gains `shareSecret: Uint8Array`. The handler's first step becomes:
```ts
const verdict = await verifyShareToken(
  { d: q['d'], exp: q['exp'], sig: q['sig'] }, deps.shareSecret, Date.now(),
)
if (!verdict.ok) return { statusCode: 403, headers: { 'content-type': 'text/plain' }, body: verdict.reason }
const docId = verdict.docId
```
The previous `docId = queryStringParameters.docId ?? rawPath` branch is **removed** — there is no longer any way to reach the S3→KMS→render flow without a valid token. Everything after (`GetObject` → `Decrypt` → `buildInvoiceHtml` → `renderPdf`) is unchanged.

## 6. The secret (provisioning seam)

A purpose-specific **256-bit share-signing secret**, **separate from any DEK / data passphrase** — rotating share-signing must never touch data access.
- **At rest (chosen):** the secret is **KMS-encrypted (envelope) and stored as the function's `SHARE_SECRET_CIPHERTEXT` env var** — a base64 KMS ciphertext blob. (An SSM SecureString is a documented alternative but NOT the implemented path, to keep the plan unambiguous and avoid a second AWS resource.)
- **Lambda:** decrypt once at **cold-start init** via the `kms:Decrypt` the role already holds; pass into `HandlerDeps.shareSecret` (the DI seam keeps `makeHandler` unit-testable with a literal secret — no AWS).
- **Mint helper:** obtains the secret the same way the seal helper obtains KMS (firm/hub context).
- **CDK:** at deploy time, generate a random 32-byte secret, KMS-`Encrypt` it, and set the resulting ciphertext as the function's `SHARE_SECRET_CIPHERTEXT` env var (a custom resource or a pre-deploy mint step writes it; the recipe RUNBOOK documents producing the blob with the same KMS key). The function role's existing `kms:Decrypt` covers init-time decrypt — least-privilege unchanged. The **same plaintext secret** must be handed to `mintShareLink` firm-side (the RUNBOOK shows decrypting the blob once to mint links).

## 7. Security properties (explicit, eyes-open)

- **Unforgeable** without the secret; tampering `d` or `exp` breaks the MAC.
- **Multi-use within the TTL is intended** — public-audience share. No nonce / single-use tracking (would require state, contradicting the stateless + public-share goals).
- **Containment = expiry.** Conservative default TTL (24h) because the URL *is* the credential and leaks into browser history / referrer headers / server logs.
- **Revocation = rotate the share-signing secret** — invalidates **all** live links at once (stated tradeoff; there is no per-link revocation in v1).
- The S3 bucket stays private; the sealed doc still requires KMS decrypt; the token only gates the render endpoint.

## 8. Testing (fully CI-testable — pure local HMAC, no AWS)

`src/share-link.test.ts`:
- mint → verify round-trip → `ok:true`, returns the docId.
- expired (`exp` in the past) → `expired`.
- tampered `docId` (verify a different d than was signed) → `invalid-signature`.
- tampered `exp` (bump it, keep old sig) → `invalid-signature`.
- missing `sig`/`d`/`exp` → `missing-token`.
- wrong-secret signature → `invalid-signature`.
- `ttlMs` over the cap is clamped to `SHARE_LINK_MAX_TTL_MS`.

`src/handler.test.ts` (path-closure — the headline assertion):
- request with **no token** (`?d=x` only, or bare) → **403**, render NOT invoked.
- request with a **valid** triple (mint with the test secret) → **200 application/pdf**, render invoked with the docId.
- request with a **bad sig** → **403**.
This proves there is no bare-docId path.

Showcase + RUNBOOK updated: the showcase mints a link and asserts the handler accepts it / rejects an unsigned request; the RUNBOOK's `curl` step now mints a link first.

## 9. Scope (YAGNI)

**In:** `share-link.ts` (mint + verify), handler gating (remove bare-docId path), the `shareSecret` dep + CDK sealed-secret wiring, unit + path-closure tests, showcase + RUNBOOK + recipe-doc updates.
**Out:** single-use/nonce/replay tracking; per-link revocation lists; a self-service `/mint` route on the Lambda (chicken-and-egg: what authorizes minting? — noted as future, needs its own auth decision); rate-limiting; any IdP/Cognito/IAM authorizer; rotating-key key-versioning (rotation invalidates all links by design).

## 10. Build order within the slice

1. `share-link.ts` (`mintShareLink` + `verifyShareToken` + constants) via TDD against `share-link.test.ts`.
2. Handler gating: add `shareSecret` to `HandlerDeps`, gate first, remove the bare-docId path; update `handler.test.ts` (path-closure).
3. CDK sealed-secret wiring + the deployed-handler `makeHandler({...})` secret resolution.
4. Showcase + RUNBOOK + recipe-doc updates + full local gate.
5. (Execution-time, profile-driven, separate from CI) optional real-AWS re-verify per the RUNBOOK.
