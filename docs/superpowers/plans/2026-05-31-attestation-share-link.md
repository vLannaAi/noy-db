# Document Attestation ③ — Magic-Link Share Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL GIT RULE:** NEVER run `git stash`/`git stash pop`/`git reset`/`git checkout HEAD -- <files>`/`git clean`. A pre-existing user stash (`stash@{0}: WIP on main`) must stay untouched. Only `git add <scoped paths>` + `git commit` + read-only git.
>
> **TYPECHECK before committing** — vitest uses esbuild and does NOT typecheck. Run `cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit` before each commit.
>
> **NO real AWS in any task here.** Mint + verify are pure local HMAC (fully CI-testable). The KMS-decrypt of the secret happens only in the deployed handler's lazy init + the RUNBOOK; never in CI.

**Goal:** Replace the ③ recipe's unauthenticated `?docId=` access with a stateless signed magic-link — the hub-free Lambda rejects (403) any request lacking a valid, unexpired HMAC token; a firm-side helper mints links. No Cognito/IAM authorizer.

**Architecture:** A new `src/share-link.ts` (pure: `mintShareLink` + `verifyShareToken`, local HMAC-SHA256 over `canonicalJson({v:1,docId,exp})` using `@noy-db/attestation` helpers). `handler.ts` gains a `shareSecret` dep, gates on `verifyShareToken` first, and drops the bare-docId path. The deployed handler lazily KMS-decrypts a 256-bit secret from the `SHARE_SECRET_CIPHERTEXT` env var on first invoke. CDK generates + seals that secret.

**Tech Stack:** TypeScript, WebCrypto HMAC, Vitest, `@aws-sdk/client-kms`, `aws-cdk-lib`. Depends on merged `@noy-db/attestation`.

**Spec:** `docs/superpowers/specs/2026-05-31-attestation-share-link-design.md`.

**Branch:** `feat/attestation-share-link` (already checked out, off `main` incl. #239; the spec is already committed on it).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `recipes/aws-kms-pdf-attestation/src/share-link.ts` | Create | `mintShareLink` + `verifyShareToken` + TTL constants (pure HMAC) |
| `recipes/aws-kms-pdf-attestation/src/share-link.test.ts` | Create | mint/verify unit tests (7 cases) |
| `recipes/aws-kms-pdf-attestation/src/handler.ts` | Modify | add `shareSecret` to `HandlerDeps`; gate on token; remove bare-docId path; lazy KMS-decrypt of `SHARE_SECRET_CIPHERTEXT` in the deployed entry |
| `recipes/aws-kms-pdf-attestation/src/handler.test.ts` | Modify | path-closure tests (403 without token, 200 with valid, 403 bad sig) |
| `recipes/aws-kms-pdf-attestation/infra/stack.ts` | Modify | generate + KMS-seal the 256-bit secret → `SHARE_SECRET_CIPHERTEXT` env var |
| `recipes/aws-kms-pdf-attestation/infra/synth.test.ts` | Modify | assert the env var is present on the function |
| `recipes/aws-kms-pdf-attestation/RUNBOOK.md` | Modify | mint-a-link step before curl; rotation note |
| `docs/recipes/aws-kms-pdf-attestation.md` | Modify | note the magic-link access model |
| `showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts` | Modify | mint a link + assert handler accepts it / rejects unsigned |

---

## Task 1: `share-link.ts` — mint + verify (pure HMAC, TDD)

**Files:** create `recipes/aws-kms-pdf-attestation/src/share-link.ts`, `src/share-link.test.ts`.

- [ ] **Step 1: Write the failing test `src/share-link.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import {
  mintShareLink, verifyShareToken,
  SHARE_LINK_DEFAULT_TTL_MS, SHARE_LINK_MAX_TTL_MS,
} from './share-link.js'

const secret = new Uint8Array(32).fill(7)
const other = new Uint8Array(32).fill(9)
const BASE = 'https://fn.example.aws/'
const NOW = 1_700_000_000_000

function parse(url: string): { d: string; exp: string; sig: string } {
  const q = new URL(url).searchParams
  return { d: q.get('d')!, exp: q.get('exp')!, sig: q.get('sig')! }
}

describe('share-link mint + verify', () => {
  it('round-trips: a minted link verifies and returns the docId', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    const v = await verifyShareToken(parse(url), secret, NOW + 1000)
    expect(v).toEqual({ ok: true, docId: 'doc-1' })
  })

  it('default exp is now + 24h', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    expect(Number(parse(url).exp)).toBe(NOW + SHARE_LINK_DEFAULT_TTL_MS)
  })

  it('rejects an expired token', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, ttlMs: 1000, nowMs: NOW })
    const v = await verifyShareToken(parse(url), secret, NOW + 2000)
    expect(v).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a tampered docId (sig no longer matches)', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    const p = parse(url)
    const v = await verifyShareToken({ ...p, d: 'doc-2' }, secret, NOW + 1000)
    expect(v).toEqual({ ok: false, reason: 'invalid-signature' })
  })

  it('rejects a tampered exp (old sig, bumped exp)', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, ttlMs: 1000, nowMs: NOW })
    const p = parse(url)
    const v = await verifyShareToken({ ...p, exp: String(NOW + 9_000_000) }, secret, NOW + 1000)
    expect(v).toEqual({ ok: false, reason: 'invalid-signature' })
  })

  it('rejects a wrong-secret signature', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    const v = await verifyShareToken(parse(url), other, NOW + 1000)
    expect(v).toEqual({ ok: false, reason: 'invalid-signature' })
  })

  it('reports missing-token when any field is absent', async () => {
    expect(await verifyShareToken({ d: 'x', exp: '123' }, secret, NOW)).toEqual({ ok: false, reason: 'missing-token' })
    expect(await verifyShareToken({}, secret, NOW)).toEqual({ ok: false, reason: 'missing-token' })
  })

  it('reports malformed when exp is not a finite integer', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    const p = parse(url)
    expect(await verifyShareToken({ ...p, exp: 'abc' }, secret, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('clamps ttlMs over the cap to SHARE_LINK_MAX_TTL_MS', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, ttlMs: SHARE_LINK_MAX_TTL_MS * 10, nowMs: NOW })
    expect(Number(parse(url).exp)).toBe(NOW + SHARE_LINK_MAX_TTL_MS)
  })
})
```

- [ ] **Step 2: Run, verify FAIL** (module not found): `cd recipes/aws-kms-pdf-attestation && npx vitest run src/share-link.test.ts` (from repo root use `npx vitest run --project aws-kms-pdf-attestation src/share-link.test.ts`).

- [ ] **Step 3: Implement `src/share-link.ts`**
```ts
import { canonicalJson, utf8, bytesToB64url, b64urlToBytes } from '@noy-db/attestation'

export const SHARE_LINK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24h
export const SHARE_LINK_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d cap

export interface MintShareLinkOptions {
  secret: Uint8Array
  baseUrl: string
  ttlMs?: number
  nowMs?: number
}

export interface ShareTokenParams {
  d?: string
  exp?: string
  sig?: string
}

export type ShareVerdict =
  | { ok: true; docId: string }
  | { ok: false; reason: 'missing-token' | 'malformed' | 'expired' | 'invalid-signature' }

/** The exact bytes the HMAC covers — canonical, version-tagged, unambiguous. */
function signedMaterial(docId: string, exp: number): Uint8Array {
  return utf8(canonicalJson({ v: 1, docId, exp }))
}

async function hmacKey(secret: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

/** Firm-side: mint a shareable, self-expiring link for a docId. */
export async function mintShareLink(docId: string, opts: MintShareLinkOptions): Promise<string> {
  const now = opts.nowMs ?? Date.now()
  const ttl = Math.min(opts.ttlMs ?? SHARE_LINK_DEFAULT_TTL_MS, SHARE_LINK_MAX_TTL_MS)
  const exp = now + ttl
  const key = await hmacKey(opts.secret, 'sign')
  const sigBytes = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, signedMaterial(docId, exp) as BufferSource),
  )
  const url = new URL(opts.baseUrl)
  url.searchParams.set('d', docId)
  url.searchParams.set('exp', String(exp))
  url.searchParams.set('sig', bytesToB64url(sigBytes))
  return url.toString()
}

/** Lambda-side: verify a share token. Constant-time via subtle.verify. */
export async function verifyShareToken(
  params: ShareTokenParams,
  secret: Uint8Array,
  nowMs: number,
): Promise<ShareVerdict> {
  const { d, exp, sig } = params
  if (!d || !exp || !sig) return { ok: false, reason: 'missing-token' }
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || !Number.isInteger(expNum)) return { ok: false, reason: 'malformed' }
  if (nowMs >= expNum) return { ok: false, reason: 'expired' }
  let sigBytes: Uint8Array
  try {
    sigBytes = b64urlToBytes(sig)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const key = await hmacKey(secret, 'verify')
  const valid = await globalThis.crypto.subtle.verify(
    'HMAC', key, sigBytes as BufferSource, signedMaterial(d, expNum) as BufferSource,
  )
  return valid ? { ok: true, docId: d } : { ok: false, reason: 'invalid-signature' }
}
```
NOTE: confirm `b64urlToBytes` throws on malformed input (the test for `malformed`-via-bad-base64 isn't asserted, but the `try/catch` guards it). If tsc flags `secret as BufferSource`, that's the repo's WebCrypto convention (see `crypto.ts`). If `b64urlToBytes` is tolerant (never throws), the catch is dead code — harmless; keep it.

- [ ] **Step 4: Run, verify PASS (9 tests):** `npx vitest run --project aws-kms-pdf-attestation src/share-link.test.ts`

- [ ] **Step 5: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && (cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit)
git add recipes/aws-kms-pdf-attestation/src/share-link.ts recipes/aws-kms-pdf-attestation/src/share-link.test.ts
git commit -m "feat(recipe/aws-kms-pdf): share-link mint + verify (stateless HMAC capability)

mintShareLink / verifyShareToken — HMAC-SHA256 over canonicalJson({v,docId,exp}),
constant-time subtle.verify, 24h default TTL / 7d cap. Pure, no AWS."
```

---

## Task 2: Handler gating — token-gate + remove the bare-docId path

**Files:** modify `recipes/aws-kms-pdf-attestation/src/handler.ts`, `src/handler.test.ts`.

- [ ] **Step 1: Rewrite the handler test for path-closure** — replace `src/handler.test.ts` with:
```ts
import { describe, it, expect, vi } from 'vitest'
import { makeHandler } from './handler.js'
import { mintShareLink } from './share-link.js'
import { encodeRenderPayload, type RenderPayload } from './payload.js'

const payload: RenderPayload = { docId: 'd1', fields: { invoiceNo: 'INV-1', total: 5 }, qr: 'qr-string' }
const SHARE_SECRET = new Uint8Array(32).fill(3)

function deps(over: Partial<{ getObjectBody: Uint8Array | null }> = {}) {
  const body = 'getObjectBody' in over ? over.getObjectBody : encodeRenderPayload(payload)
  const s3 = { send: async () => {
    if (body === null) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e }
    return { Body: { transformToByteArray: async () => body } }
  } }
  const kms = { send: async (cmd: { input: { CiphertextBlob: Uint8Array } }) => ({ Plaintext: cmd.input.CiphertextBlob }) }
  const renderPdf = vi.fn(async (_html: string) => new Uint8Array([0x25, 0x50, 0x44, 0x46]))
  return { s3: s3 as never, kms: kms as never, renderPdf, bucket: 'b', keyId: 'k', prefix: 'docs', shareSecret: SHARE_SECRET }
}

// Build a Function-URL event from a minted link's query string.
async function eventForValidLink(docId: string) {
  const url = await mintShareLink(docId, { secret: SHARE_SECRET, baseUrl: 'https://fn/' })
  const q = new URL(url).searchParams
  return { rawPath: '/', queryStringParameters: { d: q.get('d')!, exp: q.get('exp')!, sig: q.get('sig')! } }
}

describe('makeHandler — token-gated (path closure)', () => {
  it('200 application/pdf for a valid signed link; renderPdf receives the doc fields', async () => {
    const d = deps()
    const res = await makeHandler(d)(await eventForValidLink('d1'))
    expect(res.statusCode).toBe(200)
    expect(res.headers!['content-type']).toBe('application/pdf')
    expect(res.isBase64Encoded).toBe(true)
    expect(d.renderPdf).toHaveBeenCalledOnce()
    expect(d.renderPdf.mock.calls[0]![0]).toContain('INV-1')
  })

  it('403 + render NOT invoked when there is no token (bare docId is rejected)', async () => {
    const d = deps()
    const res = await makeHandler(d)({ rawPath: '/d1', queryStringParameters: { docId: 'd1' } } as never)
    expect(res.statusCode).toBe(403)
    expect(d.renderPdf).not.toHaveBeenCalled()
  })

  it('403 for a bad signature', async () => {
    const d = deps()
    const ev = await eventForValidLink('d1')
    ev.queryStringParameters.sig = 'AAAA'
    const res = await makeHandler(d)(ev)
    expect(res.statusCode).toBe(403)
    expect(d.renderPdf).not.toHaveBeenCalled()
  })

  it('404 when a validly-linked doc is missing from S3', async () => {
    const d = deps({ getObjectBody: null })
    const res = await makeHandler(d)(await eventForValidLink('d1'))
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run, verify FAIL** (handler has no `shareSecret` / still reads bare docId): `npx vitest run --project aws-kms-pdf-attestation src/handler.test.ts`

- [ ] **Step 3: Modify `src/handler.ts`** — add the import, the dep, and the gate; remove the bare-docId line.

Add at the top with the other imports:
```ts
import { verifyShareToken } from './share-link.js'
```
Add to the `HandlerDeps` interface:
```ts
  shareSecret: Uint8Array
```
Replace the opening of the returned `handler` function — the current lines:
```ts
    const docId = (event.queryStringParameters?.['docId'] ?? event.rawPath?.replace(/^\/+/, '') ?? '').trim()
    if (!docId) return { statusCode: 400, headers: { 'content-type': 'text/plain' }, body: 'missing docId' }
```
with:
```ts
    const q = event.queryStringParameters ?? {}
    const verdict = await verifyShareToken(
      { d: q['d'], exp: q['exp'], sig: q['sig'] }, deps.shareSecret, Date.now(),
    )
    if (!verdict.ok) return { statusCode: 403, headers: { 'content-type': 'text/plain' }, body: verdict.reason }
    const docId = verdict.docId
```
(Everything after — S3 GetObject → KMS Decrypt → buildInvoiceHtml → renderPdf — is unchanged.)

- [ ] **Step 4: Update the deployed entry point** (bottom of `handler.ts`). The secret must be KMS-decrypted from `SHARE_SECRET_CIPHERTEXT`, but module scope can't `await` — resolve it lazily on first invoke. Replace the `export const handler = makeHandler({...})` block with:
```ts
import { fromBase64ToBytes } from './payload.js' // see note — if not present, inline below

let cachedSecret: Uint8Array | null = null
async function resolveShareSecret(kms: Pick<KMSClient, 'send'>): Promise<Uint8Array> {
  if (cachedSecret) return cachedSecret
  const blobB64 = process.env['SHARE_SECRET_CIPHERTEXT'] ?? ''
  const blob = Buffer.from(blobB64, 'base64')
  const out = (await kms.send(new DecryptCommand({ CiphertextBlob: blob }) as never)) as { Plaintext?: Uint8Array }
  if (!out.Plaintext) throw new Error('SHARE_SECRET_CIPHERTEXT decrypt returned no plaintext')
  cachedSecret = new Uint8Array(out.Plaintext)
  return cachedSecret
}

const s3 = new S3Client({})
const kms = new KMSClient({})
const baseDeps = {
  s3, kms, renderPdf: defaultRenderPdf,
  bucket: process.env['DOCS_BUCKET'] ?? '',
  keyId: process.env['KMS_KEY_ID'] ?? '',
  prefix: process.env['DOCS_PREFIX'] ?? 'docs',
}

export async function handler(event: Parameters<ReturnType<typeof makeHandler>>[0]) {
  const shareSecret = await resolveShareSecret(kms)
  return makeHandler({ ...baseDeps, shareSecret })(event)
}
```
NOTE on `fromBase64ToBytes`: do NOT add that import — `Buffer.from(b64,'base64')` is used directly above (Node 22 runtime has Buffer). Remove the speculative import line; it was a placeholder. The `DecryptCommand` here omits `KeyId` deliberately — KMS infers the key from the ciphertext for decrypt (the doc-decrypt path passes `KeyId` but it's optional; either works). Keep tsc clean.

- [ ] **Step 5: Run, verify PASS:** `npx vitest run --project aws-kms-pdf-attestation src/handler.test.ts` (4 tests) — then the whole project to ensure no regression: `npx vitest run --project aws-kms-pdf-attestation`.

- [ ] **Step 6: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && (cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit)
git add recipes/aws-kms-pdf-attestation/src/handler.ts recipes/aws-kms-pdf-attestation/src/handler.test.ts
git commit -m "feat(recipe/aws-kms-pdf): gate the Lambda on a share token; remove bare-docId path

The handler now requires a valid, unexpired HMAC share token (403 otherwise) —
there is no longer any path to fetch by bare docId. Deployed entry lazily
KMS-decrypts the 256-bit share secret from SHARE_SECRET_CIPHERTEXT (cached)."
```

---

## Task 3: CDK — generate + KMS-seal the share secret into the function env

**Files:** modify `recipes/aws-kms-pdf-attestation/infra/stack.ts`, `infra/synth.test.ts`.

CDK has no built-in "generate random + KMS-encrypt at deploy" primitive, so use an `AwsCustomResource` that calls `kms:GenerateRandom` + `kms:Encrypt` at deploy time and feeds the ciphertext into the function's env. Anchors: the `lambda.Function` is created as `fn` in `stack.ts` (read it first).

- [ ] **Step 1: Read the current stack** to confirm the `fn`, `key`, and import lines:
```bash
sed -n '1,75p' recipes/aws-kms-pdf-attestation/infra/stack.ts
```

- [ ] **Step 2: Add the custom-resource import** at the top of `stack.ts`:
```ts
import * as cr from 'aws-cdk-lib/custom-resources'
```

- [ ] **Step 3: Before the `lambda.Function` is created, generate + seal the secret.** Insert after the `key` is declared:
```ts
    // Deploy-time: ask KMS for 32 random bytes, then encrypt them under our key.
    // The ciphertext (base64) becomes the function's SHARE_SECRET_CIPHERTEXT env
    // var; the function KMS-decrypts it lazily at runtime. The plaintext secret
    // never appears in the template (only the ciphertext does).
    const genSecret = new cr.AwsCustomResource(this, 'GenShareSecret', {
      onCreate: {
        service: 'KMS',
        action: 'generateRandom',
        parameters: { NumberOfBytes: 32 },
        physicalResourceId: cr.PhysicalResourceId.of('share-secret-plaintext'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    })
    const plaintextB64 = genSecret.getResponseField('Plaintext') // base64 (SDK returns blobs base64)

    const sealSecret = new cr.AwsCustomResource(this, 'SealShareSecret', {
      onCreate: {
        service: 'KMS',
        action: 'encrypt',
        parameters: { KeyId: key.keyId, Plaintext: plaintextB64 },
        physicalResourceId: cr.PhysicalResourceId.of('share-secret-ciphertext'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['kms:Encrypt'], resources: [key.keyArn] }),
      ]),
    })
    sealSecret.node.addDependency(genSecret)
    const shareSecretCiphertext = sealSecret.getResponseField('CiphertextBlob') // base64
```
Add the iam import if not present:
```ts
import * as iam from 'aws-cdk-lib/aws-iam'
```
NOTE: confirm the KMS SDK actions for `AwsCustomResource` are `generateRandom`/`encrypt` (lowerCamel for v3 SDK) — if synth/deploy rejects them, check the installed `aws-cdk-lib` custom-resources docs for the exact action casing and adjust. The `Plaintext`/`CiphertextBlob` response fields are base64 strings.

- [ ] **Step 4: Wire the env var** — add to the function's `environment` map:
```ts
      environment: {
        DOCS_BUCKET: bucket.bucketName,
        KMS_KEY_ID: key.keyArn,
        DOCS_PREFIX,
        SHARE_SECRET_CIPHERTEXT: shareSecretCiphertext,
      },
```
(The function already has `kms:Decrypt` via `key.grantDecrypt(fn)`, which covers decrypting this ciphertext at runtime — no extra permission needed.)

- [ ] **Step 5: Update `infra/synth.test.ts`** — add an assertion that the env var is wired. After the existing `hasResourceProperties('AWS::Lambda::Function', {...})`, add a check that `SHARE_SECRET_CIPHERTEXT` appears in the function's environment. Since its value is a CFN token (resolved at deploy), assert presence of the key rather than a literal:
```ts
    const fns2 = t.findResources('AWS::Lambda::Function')
    const renderFn = Object.values(fns2).find(
      (r) => (r as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties?.Environment?.Variables?.['SHARE_SECRET_CIPHERTEXT'] !== undefined,
    )
    expect(renderFn).toBeDefined()
```

- [ ] **Step 6: Run synth test + typecheck:** `npx vitest run --project aws-kms-pdf-attestation infra/synth.test.ts` (PASS), then `cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit` (clean).

- [ ] **Step 7: Commit**
```bash
cd /Users/vicio/_github/noy-db
git add recipes/aws-kms-pdf-attestation/infra/stack.ts recipes/aws-kms-pdf-attestation/infra/synth.test.ts
git commit -m "feat(recipe/aws-kms-pdf): CDK generates + KMS-seals the share secret into the fn env

Deploy-time AwsCustomResource: kms:GenerateRandom (32 bytes) → kms:Encrypt under
the recipe key → base64 ciphertext set as SHARE_SECRET_CIPHERTEXT. Plaintext
never lands in the template; the fn decrypts it at runtime via its existing
kms:Decrypt grant. Synth test asserts the env var is wired."
```

---

## Task 4: Showcase + RUNBOOK + recipe doc + full gate

**Files:** modify `showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts`, `recipes/aws-kms-pdf-attestation/RUNBOOK.md`, `docs/recipes/aws-kms-pdf-attestation.md`.

- [ ] **Step 1: Extend the showcase** to demonstrate the link gate (CI-safe — mint + verify are pure HMAC; the handler runs with mocked S3/KMS). Add a second test to the existing `describe(...)` block in `showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts`:
```ts
  it('a minted share link gates the render endpoint; unsigned requests are rejected', async () => {
    const { makeHandler } = await import('@noy-db/recipe-aws-kms-pdf-attestation/handler')
    const { mintShareLink } = await import('@noy-db/recipe-aws-kms-pdf-attestation/share-link')
    const { encodeRenderPayload } = await import('@noy-db/recipe-aws-kms-pdf-attestation')

    const shareSecret = new Uint8Array(32).fill(5)
    const stored = encodeRenderPayload({ docId: 'inv-1', qr: 'q', fields: { invoiceNo: 'INV-1', total: 1, issueDate: '2026-05-29' } })
    const s3 = { send: async () => ({ Body: { transformToByteArray: async () => stored } }) }
    const kms = { send: async (cmd: { input: { CiphertextBlob: Uint8Array } }) => ({ Plaintext: cmd.input.CiphertextBlob }) }
    const renderPdf = async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const handler = makeHandler({ s3: s3 as never, kms: kms as never, renderPdf, bucket: 'b', keyId: 'k', prefix: 'docs', shareSecret })

    // unsigned → rejected
    const unsigned = await handler({ rawPath: '/inv-1', queryStringParameters: { docId: 'inv-1' } } as never)
    expect(unsigned.statusCode).toBe(403)

    // minted link → accepted
    const url = await mintShareLink('inv-1', { secret: shareSecret, baseUrl: 'https://fn/' })
    const q = new URL(url).searchParams
    const ok = await handler({ rawPath: '/', queryStringParameters: { d: q.get('d')!, exp: q.get('exp')!, sig: q.get('sig')! } } as never)
    expect(ok.statusCode).toBe(200)
  })
```
This needs the recipe package to export `./handler` and `./share-link` subpaths. Add them to `recipes/aws-kms-pdf-attestation/package.json` `exports`:
```json
    "./handler": "./src/handler.ts",
    "./share-link": "./src/share-link.ts"
```

- [ ] **Step 2: Run the showcase** (rebuild hub first if stale): `cd showcases && npx vitest run src/recipe-aws-kms-pdf-attestation.recipe.test.ts` → 2 tests pass. If `@noy-db/recipe-aws-kms-pdf-attestation/handler` doesn't resolve, run `pnpm install` (new exports subpaths) and retry.

- [ ] **Step 3: Update `RUNBOOK.md`** — replace the "Invoke + verify" curl step (§3) so it mints a link first. New §3:
```markdown
## 3. Invoke + verify (via a magic link)
The endpoint now requires a signed share link — a bare `?docId=` is rejected (403).
Mint a link firm-side (you need the plaintext share secret: decrypt the function's
`SHARE_SECRET_CIPHERTEXT` once with the recipe KMS key), then fetch:
```ts
import { mintShareLink } from '@noy-db/recipe-aws-kms-pdf-attestation/share-link'
const url = mintShareLink('<docId>', { secret: <32-byte secret>, baseUrl: '<FunctionUrl>' })
// → https://<fn-url>/?d=<docId>&exp=<ms>&sig=<...>
```
```bash
curl -s "<minted-url>" -o invoice.pdf && file invoice.pdf   # → PDF document
curl -s -o /dev/null -w '%{http_code}\n' "<FunctionUrl>?docId=<docId>"  # → 403 (no token)
```
Links are multi-use until `exp` (default 24h, 7d cap). **Revocation = rotate the
share secret** (re-run deploy / re-seal) — this invalidates all live links.
```
(Adjust the surrounding section numbers if needed.)

- [ ] **Step 4: Update `docs/recipes/aws-kms-pdf-attestation.md`** — in the "Trust + scope" section, replace the Function-URL-`NONE` sentence with:
```markdown
The render endpoint is gated by a **stateless signed magic link** (HMAC over
`{docId, exp}` with a KMS-sealed secret): a data-holder mints a self-expiring,
shareable URL; the hub-free Lambda verifies it with no AWS authorizer / Cognito.
A bare `?docId=` is rejected. Multi-use within the TTL (public-audience share);
revocation = rotate the secret. The Function URL stays `authType: NONE` at the
AWS layer — the Lambda itself is the gate.
```

- [ ] **Step 5: Full gate**
```bash
cd /Users/vicio/_github/noy-db
node scripts/validate-features.mjs 2>&1 | tail -2
(cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit)
npx vitest run --project aws-kms-pdf-attestation --reporter=dot 2>&1 | tail -6
cd showcases && npx vitest run src/recipe-aws-kms-pdf-attestation.recipe.test.ts --reporter=dot 2>&1 | tail -6
```
Expected: validator passes; tsc clean; recipe project all pass (payload 4 + render-core 3 + seal 1 + handler 4 + synth 1 + share-link 9 = 22); showcase 2 pass.

- [ ] **Step 6: Commit**
```bash
cd /Users/vicio/_github/noy-db
git add recipes/aws-kms-pdf-attestation/package.json pnpm-lock.yaml showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts recipes/aws-kms-pdf-attestation/RUNBOOK.md docs/recipes/aws-kms-pdf-attestation.md
git commit -m "docs+test(recipe/aws-kms-pdf): magic-link in showcase, RUNBOOK, recipe doc

Showcase asserts the link gate (unsigned 403 / minted 200) with mocked AWS;
RUNBOOK mint-a-link step + rotation note; recipe doc documents the magic-link
access model. Recipe package exports ./handler + ./share-link subpaths."
```

---

## Self-Review (completed)

- **Spec coverage** (spec §1–§10): §1 close-the-door → T2 (gate + remove bare-docId path); §2 token format (canonicalJson{v,docId,exp}, epoch-ms, b64url) → T1 `signedMaterial`; §3 verify (missing/malformed/expired/constant-time invalid-sig) → T1 `verifyShareToken` + tests; §4 mint (24h default, 7d cap) → T1 `mintShareLink` + clamp test; §5 handler gating → T2; §6 secret seam (KMS-sealed `SHARE_SECRET_CIPHERTEXT`, lazy decrypt, DI) → T2 Step 4 + T3 CDK; §7 security props → reflected in tests + RUNBOOK/doc (T4); §8 testing (round-trip/expired/tampered/missing/wrong-secret/cap + path-closure) → T1 9 tests + T2 4 tests; §9 YAGNI → no nonce/revocation-list/`/mint`; §10 build order → task order.
- **Placeholder scan:** removed the speculative `fromBase64ToBytes` import (T2 Step 4 note tells the implementer to use `Buffer.from` and delete it). All code blocks complete.
- **Type consistency:** `ShareVerdict`/`ShareTokenParams`/`MintShareLinkOptions` defined T1, consumed T2 (`verifyShareToken`) + tests; `HandlerDeps.shareSecret: Uint8Array` added T2, supplied by deployed entry (T2 Step 4) + CDK env (T3) + showcase/tests; `mintShareLink(docId, opts)` + `verifyShareToken(params, secret, nowMs)` signatures identical across T1/T2/T4; `SHARE_LINK_DEFAULT_TTL_MS`/`SHARE_LINK_MAX_TTL_MS` consistent.
- **Known risks:** (1) the CDK `AwsCustomResource` KMS action casing (`generateRandom`/`encrypt`) + base64 response fields — T3 Step 3 note says verify against installed cdk-lib and adjust; this is the one part not provable without a synth/deploy. (2) `DecryptCommand` without `KeyId` for the share secret — valid for KMS decrypt; T2 note documents it. (3) new `exports` subpaths need `pnpm install` before the showcase resolves them — T4 Step 2 notes it.
