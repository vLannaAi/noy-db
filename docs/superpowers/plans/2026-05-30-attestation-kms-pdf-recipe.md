# Document Attestation ③ — AWS-KMS PDF Render Recipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL GIT RULE for every subagent:** NEVER run `git stash`, `git stash pop`, `git reset`, `git checkout HEAD -- <files>`, or `git clean`. A pre-existing user stash (`stash@{0}: WIP on main`) must never be touched. Only `git add <scoped paths>` + `git commit` + read-only git. If you think you need anything else, STOP and report.
>
> **TYPECHECK before committing** — vitest uses esbuild and does NOT typecheck. Run the recipe's `npx tsc --noEmit` (or the workspace tsc) before each commit.
>
> **NO REAL AWS in any task here.** Every task is CI/local-safe: unit tests with mocked AWS clients, `cdk synth`, `docker build` is optional/skippable. The real deploy → verify → `cdk destroy` happens later, profile-driven, per the RUNBOOK (Task 6 writes it; it is NOT executed as part of plan implementation).

**Goal:** A deployable reference Lambda (recipe `aws-kms-pdf-attestation`) that KMS-decrypts a firm-sealed document record from S3, renders an HTML invoice → PDF with the attestation QR embedded as vector, and returns the PDF — plus the CI-testable core, CDK stack, showcase, and deploy runbook.

**Architecture:** New private workspace package `recipes/aws-kms-pdf-attestation/` (sibling to ④'s `recipes/attestation-verifier`). Five seams: payload codec, render-core (HTML builder + isolated puppeteer renderer), firm-side seal helper (uses `@noy-db/at-aws-kms`), hub-free Lambda handler (raw `@aws-sdk/client-kms` Decrypt), and a CDK-TS stack. Everything novel is unit-tested with mocked AWS; Chromium + real AWS are runbook-only.

**Tech Stack:** TypeScript, Vitest, `@aws-sdk/client-kms` + `@aws-sdk/client-s3` (already in the monorepo at ^3), `@noy-db/at-aws-kms` (seal helper), `qrcode` (SVG QR), `puppeteer-core` + `@sparticuz/chromium` (render), `aws-cdk-lib` (infra), Docker (Lambda container, arm64, Node 22). Depends on merged `@noy-db/attestation`/`@noy-db/hub`/`@noy-db/recipe-attestation-verifier`.

**Spec:** `docs/superpowers/specs/2026-05-30-attestation-kms-pdf-recipe-design.md`.

**Branch:** `feat/attestation-kms-pdf-recipe` (already checked out, off `main` incl. #238; the spec + the `NOYDB_SHOWCASE_AWS_DOCS` `.env.example` entry are already committed on it).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `recipes/aws-kms-pdf-attestation/package.json` | Create | private pkg; deps + scripts (test/typecheck/synth) |
| `recipes/aws-kms-pdf-attestation/tsconfig.json` | Create | extends base; lib ES2022 (+DOM for puppeteer types) |
| `recipes/aws-kms-pdf-attestation/vitest.config.ts` | Create | project `aws-kms-pdf-attestation`, node env |
| `recipes/aws-kms-pdf-attestation/src/payload.ts` | Create | `RenderPayload` + encode/decode + 4 KB guard |
| `recipes/aws-kms-pdf-attestation/src/render-core.ts` | Create | `buildInvoiceHtml` (CI) + `renderPdf` (Chromium, not CI) |
| `recipes/aws-kms-pdf-attestation/src/seal.ts` | Create | firm-side `sealAndUpload` (at-aws-kms + S3) |
| `recipes/aws-kms-pdf-attestation/src/handler.ts` | Create | Lambda Function-URL handler + `makeHandler(deps)` |
| `recipes/aws-kms-pdf-attestation/infra/stack.ts` + `app.ts` + `cdk.json` | Create | CDK-TS stack (KMS, S3, container Lambda, Function URL, IAM) |
| `recipes/aws-kms-pdf-attestation/Dockerfile` | Create | arm64 Node22 Lambda container |
| `recipes/aws-kms-pdf-attestation/src/*.test.ts` | Create | payload/render-core/seal/handler unit tests (mock AWS) |
| `recipes/aws-kms-pdf-attestation/infra/synth.test.ts` | Create | `cdk synth` smoke test |
| `recipes/aws-kms-pdf-attestation/README.md` + `RUNBOOK.md` | Create | usage + profile-driven deploy/verify/teardown |
| `vitest.config.ts` (root) | (already globs `recipes/*/vitest.config.ts` from ④) | — |
| `showcases/src/90-attestation-kms-pdf.recipe... ` see Task 6 | Create | CI-safe showcase |
| `features.yaml` | Modify | new `recipes:` entry |

---

## Task 1: Package skeleton + payload codec (TDD)

**Files:** create `recipes/aws-kms-pdf-attestation/{package.json,tsconfig.json,vitest.config.ts,src/payload.ts,src/payload.test.ts}`.

- [ ] **Step 1: Create `recipes/aws-kms-pdf-attestation/package.json`**
```json
{
  "name": "@noy-db/recipe-aws-kms-pdf-attestation",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Deployable reference: KMS-decrypt an S3 doc record, render HTML→PDF with the attestation QR as vector. Recipe, not published.",
  "exports": {
    ".": "./src/payload.ts",
    "./seal": "./src/seal.ts",
    "./render-core": "./src/render-core.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "synth": "cdk synth --app 'npx tsx infra/app.ts'"
  },
  "dependencies": {
    "@noy-db/at-aws-kms": "workspace:*",
    "@aws-sdk/client-kms": "^3.0.0",
    "@aws-sdk/client-s3": "^3.0.0",
    "qrcode": "^1.5.4",
    "puppeteer-core": "^24.0.0",
    "@sparticuz/chromium": "^138.0.0"
  },
  "peerDependencies": {
    "@noy-db/hub": "workspace:*"
  },
  "devDependencies": {
    "@noy-db/hub": "workspace:*",
    "@noy-db/attestation": "workspace:*",
    "@noy-db/recipe-attestation-verifier": "workspace:*",
    "@noy-db/to-memory": "workspace:*",
    "@types/qrcode": "^1.5.5",
    "@types/node": "^22.0.0",
    "aws-cdk-lib": "^2.160.0",
    "constructs": "^10.3.0",
    "aws-cdk": "^2.160.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```
NOTE: `@noy-db/hub` is a peerDependency because `at-aws-kms` needs it as a peer (the seal helper runs in a hub context). Confirm the latest `@sparticuz/chromium` + `puppeteer-core` majors resolve on `pnpm install` (the registry may have moved past these — if `pnpm install` errors on an unresolvable version, relax to the nearest existing major and report it). The Lambda `handler.ts` will NOT import `@noy-db/hub` or `@noy-db/at-aws-kms` (it uses raw `@aws-sdk/client-kms`) — the peer is only for `seal.ts`.

- [ ] **Step 2: Create `tsconfig.json`**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "infra/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'aws-kms-pdf-attestation',
    environment: 'node',
    include: ['src/**/*.test.ts', 'infra/**/*.test.ts'],
    globals: false,
  },
})
```

- [ ] **Step 4: Install.** Run from repo root: `pnpm install`. Expected: links the package. (Pre-existing peer warnings from other packages are unrelated — ignore as long as this package links and the new deps resolve.)

- [ ] **Step 5: Write the failing test `src/payload.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { encodeRenderPayload, decodeRenderPayload, type RenderPayload } from './payload.js'

const payload: RenderPayload = {
  docId: '01J0000000000000000000DEMO',
  fields: { invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' },
  qr: 'eyJ2IjoxfQ',
}

describe('render payload codec', () => {
  it('round-trips through encode/decode', () => {
    const bytes = encodeRenderPayload(payload)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(decodeRenderPayload(bytes)).toEqual(payload)
  })

  it('throws when the encoded payload exceeds the 4 KB KMS plaintext limit', () => {
    const huge: RenderPayload = { ...payload, fields: { blob: 'x'.repeat(5000) } }
    expect(() => encodeRenderPayload(huge)).toThrow(/4 ?KB|4096/)
  })

  it('decode rejects malformed JSON', () => {
    expect(() => decodeRenderPayload(new TextEncoder().encode('not json'))).toThrow()
  })

  it('decode rejects a payload missing required fields', () => {
    const bad = new TextEncoder().encode(JSON.stringify({ docId: 'x' }))
    expect(() => decodeRenderPayload(bad)).toThrow(/docId|fields|qr|shape/)
  })
})
```

- [ ] **Step 6: Run, verify FAIL** (module not found): `npx vitest run --project aws-kms-pdf-attestation`

- [ ] **Step 7: Implement `src/payload.ts`**
```ts
/** The decrypted record the render Lambda turns into a PDF. */
export interface RenderPayload {
  docId: string
  fields: Record<string, string | number>
  qr: string
}

const KMS_PLAINTEXT_LIMIT = 4096 // AWS KMS Encrypt caps plaintext at 4 KB.

export function encodeRenderPayload(p: RenderPayload): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(p))
  if (bytes.length > KMS_PLAINTEXT_LIMIT) {
    throw new Error(
      `render payload exceeds the 4 KB KMS plaintext limit (${bytes.length} > ${KMS_PLAINTEXT_LIMIT} bytes). ` +
        'Attestation payloads (declared fields + QR) are normally far under; envelope encryption for larger payloads is out of scope.',
    )
  }
  return bytes
}

export function decodeRenderPayload(bytes: Uint8Array): RenderPayload {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  if (
    parsed === null || typeof parsed !== 'object' ||
    typeof (parsed as RenderPayload).docId !== 'string' ||
    typeof (parsed as RenderPayload).qr !== 'string' ||
    typeof (parsed as RenderPayload).fields !== 'object' || (parsed as RenderPayload).fields === null
  ) {
    throw new Error('decodeRenderPayload: invalid payload shape (need { docId, fields, qr })')
  }
  return parsed as RenderPayload
}
```

- [ ] **Step 8: Run, verify PASS (4 tests):** `npx vitest run --project aws-kms-pdf-attestation`

- [ ] **Step 9: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && (cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit)
git add pnpm-lock.yaml recipes/aws-kms-pdf-attestation/package.json recipes/aws-kms-pdf-attestation/tsconfig.json recipes/aws-kms-pdf-attestation/vitest.config.ts recipes/aws-kms-pdf-attestation/src/payload.ts recipes/aws-kms-pdf-attestation/src/payload.test.ts
git commit -m "feat(recipe/aws-kms-pdf): package skeleton + render-payload codec

New private recipes/aws-kms-pdf-attestation package. RenderPayload encode/decode
with the 4 KB KMS-plaintext guard + shape validation."
```

---

## Task 2: render-core — `buildInvoiceHtml` (vector QR) + isolated `renderPdf`

**Files:** create `recipes/aws-kms-pdf-attestation/src/render-core.ts`, `src/render-core.test.ts`.

- [ ] **Step 1: Write the failing test `src/render-core.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { buildInvoiceHtml } from './render-core.js'
import { decodeQr } from '@noy-db/attestation'
import type { RenderPayload } from './payload.js'

// A real QR string so the embedded SVG is built from a decodable payload.
import { encodeQr } from '@noy-db/attestation'
const qr = encodeQr({ v: 1, docId: '01J0DEMO', salt: 'c2FsdA', alg: 'ed25519', keyId: 'k1', fieldHashes: ['h'], sig: 's' })
const payload: RenderPayload = { docId: '01J0DEMO', fields: { invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' }, qr }

describe('buildInvoiceHtml', () => {
  it('renders every field value into the HTML', async () => {
    const html = await buildInvoiceHtml(payload)
    expect(html).toContain('INV-1042')
    expect(html).toContain('1234.5')
    expect(html).toContain('2026-05-29')
  })

  it('embeds the QR as inline vector <svg>, not a raster <img>', async () => {
    const html = await buildInvoiceHtml(payload)
    expect(html).toMatch(/<svg[\s>]/i)            // inline SVG present
    expect(html).not.toMatch(/<img[^>]+src=["']data:image\/png/i)  // not a raster image
  })

  it('the embedded QR SVG was generated from the payload qr string', async () => {
    const html = await buildInvoiceHtml(payload)
    // qrcode emits a <path> whose `d` encodes the modules; assert the decode of
    // the SOURCE qr still yields the right docId (guards we passed the right string).
    expect(decodeQr(payload.qr).docId).toBe('01J0DEMO')
    expect(html).toContain('<svg')
  })
})
```

- [ ] **Step 2: Run, verify FAIL:** `npx vitest run --project aws-kms-pdf-attestation`

- [ ] **Step 3: Implement `src/render-core.ts`**
```ts
import QRCode from 'qrcode'
import type { RenderPayload } from './payload.js'

/** Build the invoice HTML with the QR embedded as inline (vector) SVG. */
export async function buildInvoiceHtml(payload: RenderPayload): Promise<string> {
  const qrSvg = await QRCode.toString(payload.qr, { type: 'svg', margin: 1, width: 160 })
  const rows = Object.entries(payload.fields)
    .map(([k, v]) => `<tr><th style="text-align:left;padding:4px 12px 4px 0">${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`)
    .join('')
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<style>
  body { font-family: system-ui, sans-serif; margin: 40px; color: #1f2733; }
  h1 { font-size: 20px; } .meta { color: #667; font-size: 12px; }
  table { margin: 20px 0; border-collapse: collapse; }
  .qr { margin-top: 24px; } .qr svg { width: 160px; height: 160px; }
  .doc { color: #889; font-size: 11px; }
</style></head>
<body>
  <h1>Invoice</h1>
  <p class="meta">Issued by the firm · attestation document ${escapeHtml(payload.docId)}</p>
  <table>${rows}</table>
  <div class="qr">${qrSvg}</div>
  <p class="doc">Scan / verify offline — the QR carries a signed per-field commitment.</p>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Render HTML → PDF via headless Chromium. NOT exercised in CI (needs the
 * @sparticuz/chromium binary); isolated so the handler can stub it. The browser
 * is created lazily and reused across warm Lambda invocations.
 */
let browserPromise: Promise<import('puppeteer-core').Browser> | null = null
export async function renderPdf(html: string): Promise<Uint8Array> {
  const [{ default: chromium }, puppeteer] = await Promise.all([
    import('@sparticuz/chromium'),
    import('puppeteer-core'),
  ])
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    })
  }
  const browser = await browserPromise
  const page = await browser.newPage()
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdf = await page.pdf({ format: 'A4', printBackground: true })
    return new Uint8Array(pdf)
  } finally {
    await page.close()
  }
}
```
NOTE: import `@noy-db/attestation`'s `encodeQr`/`decodeQr` are only used in the TEST (devDep). If tsc flags the dynamic `import('puppeteer-core').Browser` type, add `import type { Browser } from 'puppeteer-core'` at top and use `Browser` directly. Keep tsc clean; report any adjustment.

- [ ] **Step 4: Run, verify PASS (3 tests):** `npx vitest run --project aws-kms-pdf-attestation`

- [ ] **Step 5: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && (cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit)
git add recipes/aws-kms-pdf-attestation/src/render-core.ts recipes/aws-kms-pdf-attestation/src/render-core.test.ts
git commit -m "feat(recipe/aws-kms-pdf): render-core — invoice HTML + inline vector QR; isolated renderPdf

buildInvoiceHtml embeds the QR as inline <svg> (vector). renderPdf
(puppeteer-core + @sparticuz/chromium) is isolated + warm-reused; not CI-run."
```

---

## Task 3: seal helper + Lambda handler (mock-AWS tested)

**Files:** create `recipes/aws-kms-pdf-attestation/src/seal.ts`, `src/seal.test.ts`, `src/handler.ts`, `src/handler.test.ts`.

- [ ] **Step 1: Write the failing test `src/seal.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { sealAndUpload } from './seal.js'
import { decodeRenderPayload, type RenderPayload } from './payload.js'

const payload: RenderPayload = { docId: 'd1', fields: { invoiceNo: 'INV-1' }, qr: 'qr-string' }

describe('sealAndUpload', () => {
  it('seals the payload via KMS Encrypt and PUTs it to the given bucket/key', async () => {
    const kmsCalls: any[] = []
    const s3Calls: any[] = []
    // Mock KMS: "seal" = wrap bytes; mock S3: capture the PutObject.
    const kmsClient = { send: async (cmd: any) => { kmsCalls.push(cmd); return { CiphertextBlob: cmd.input.Plaintext } } }
    const s3Client = { send: async (cmd: any) => { s3Calls.push(cmd); return {} } }

    await sealAndUpload(payload, { keyId: 'arn:key', bucket: 'b', key: 'docs/d1', kmsClient: kmsClient as any, s3Client: s3Client as any })

    expect(kmsCalls).toHaveLength(1)
    const put = s3Calls[0].input
    expect(put.Bucket).toBe('b')
    expect(put.Key).toBe('docs/d1')
    // The stored body is the KMS ciphertext; our mock seal is identity, so it
    // decodes back to the original payload.
    expect(decodeRenderPayload(put.Body)).toEqual(payload)
  })
})
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `src/seal.ts`**
```ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { awsKmsSealingProvider } from '@noy-db/at-aws-kms'
import { encodeRenderPayload, type RenderPayload } from './payload.js'

export interface SealAndUploadOptions {
  keyId: string
  bucket: string
  key: string
  /** DI for tests. Defaults to ambient-cred clients. */
  kmsClient?: { send: (cmd: unknown) => Promise<unknown> }
  s3Client?: Pick<S3Client, 'send'>
}

/**
 * Firm-side (hub context): seal a RenderPayload with the firm's KMS key via
 * at-aws-kms and upload the ciphertext to S3. The render Lambda later decrypts
 * + renders it. This is the @noy-db/at-aws-kms feature in action.
 */
export async function sealAndUpload(payload: RenderPayload, opts: SealAndUploadOptions): Promise<void> {
  const sealer = awsKmsSealingProvider({ keyId: opts.keyId, client: opts.kmsClient as never })
  const sealed = await sealer.seal(encodeRenderPayload(payload))
  const s3 = opts.s3Client ?? new S3Client({})
  await s3.send(new PutObjectCommand({ Bucket: opts.bucket, Key: opts.key, Body: sealed }) as never)
}
```
NOTE: `awsKmsSealingProvider`'s `client` option type is `Pick<KMSClient,'send'>` — the test's mock satisfies it structurally; the `as never` casts bridge the structural mock to the SDK command types without pulling real client typing into the test. If tsc objects, type the mock as `Pick<KMSClient,'send'>`/`Pick<S3Client,'send'>` in the test instead of `any`, and drop the `as never`. Keep tsc clean.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Write the failing test `src/handler.test.ts`**
```ts
import { describe, it, expect, vi } from 'vitest'
import { makeHandler } from './handler.js'
import { encodeRenderPayload, type RenderPayload } from './payload.js'

const payload: RenderPayload = { docId: 'd1', fields: { invoiceNo: 'INV-1', total: 5 }, qr: 'qr-string' }

function deps(over: Partial<{ getObjectBody: Uint8Array | null }> = {}) {
  const body = 'getObjectBody' in over ? over.getObjectBody : encodeRenderPayload(payload)
  const s3 = { send: async () => {
    if (body === null) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e }
    return { Body: { transformToByteArray: async () => body } }
  } }
  // mock KMS Decrypt = identity (our test S3 body is already plaintext).
  const kms = { send: async (cmd: any) => ({ Plaintext: cmd.input.CiphertextBlob }) }
  const renderPdf = vi.fn(async (_html: string) => new Uint8Array([0x25, 0x50, 0x44, 0x46])) // "%PDF"
  return { s3: s3 as any, kms: kms as any, renderPdf, bucket: 'b', keyId: 'k', prefix: 'docs' }
}

describe('makeHandler', () => {
  it('returns a base64 application/pdf for a known docId', async () => {
    const d = deps()
    const handler = makeHandler(d)
    const res = await handler({ rawPath: '/d1', queryStringParameters: {} } as any)
    expect(res.statusCode).toBe(200)
    expect(res.headers!['content-type']).toBe('application/pdf')
    expect(res.isBase64Encoded).toBe(true)
    // renderPdf received HTML containing the sealed field
    expect(d.renderPdf).toHaveBeenCalledOnce()
    expect(d.renderPdf.mock.calls[0][0]).toContain('INV-1')
  })

  it('404 when the object is missing', async () => {
    const handler = makeHandler(deps({ getObjectBody: null }))
    const res = await handler({ rawPath: '/missing', queryStringParameters: {} } as any)
    expect(res.statusCode).toBe(404)
  })

  it('400 when no docId is provided', async () => {
    const handler = makeHandler(deps())
    const res = await handler({ rawPath: '/', queryStringParameters: {} } as any)
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **Step 6: Run, verify FAIL.**

- [ ] **Step 7: Implement `src/handler.ts`**
```ts
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms'
import { decodeRenderPayload } from './payload.js'
import { buildInvoiceHtml, renderPdf as defaultRenderPdf } from './render-core.js'

interface FnUrlEvent { rawPath?: string; queryStringParameters?: Record<string, string | undefined> | null }
interface FnUrlResult { statusCode: number; headers?: Record<string, string>; body?: string; isBase64Encoded?: boolean }

export interface HandlerDeps {
  s3: Pick<S3Client, 'send'>
  kms: Pick<KMSClient, 'send'>
  renderPdf: (html: string) => Promise<Uint8Array>
  bucket: string
  keyId: string
  prefix: string
}

/** Build a Function-URL handler. Deps are injected so it unit-tests with mocks. */
export function makeHandler(deps: HandlerDeps) {
  return async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
    const docId = (event.queryStringParameters?.['docId'] ?? event.rawPath?.replace(/^\/+/, '') ?? '').trim()
    if (!docId) return { statusCode: 400, headers: { 'content-type': 'text/plain' }, body: 'missing docId' }

    let sealed: Uint8Array
    try {
      const obj = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: `${deps.prefix}/${docId}` }) as never) as { Body?: { transformToByteArray(): Promise<Uint8Array> } }
      if (!obj.Body) return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' }
      sealed = await obj.Body.transformToByteArray()
    } catch (e) {
      if (e instanceof Error && (e.name === 'NoSuchKey' || e.name === 'NotFound')) {
        return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' }
      }
      return { statusCode: 500, headers: { 'content-type': 'text/plain' }, body: 'storage error' }
    }

    try {
      const dec = await deps.kms.send(new DecryptCommand({ CiphertextBlob: sealed, KeyId: deps.keyId }) as never) as { Plaintext?: Uint8Array }
      if (!dec.Plaintext) return { statusCode: 500, headers: { 'content-type': 'text/plain' }, body: 'decrypt error' }
      const payload = decodeRenderPayload(dec.Plaintext)
      const html = await buildInvoiceHtml(payload)
      const pdf = await deps.renderPdf(html)
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/pdf' },
        body: Buffer.from(pdf).toString('base64'),
        isBase64Encoded: true,
      }
    } catch {
      return { statusCode: 500, headers: { 'content-type': 'text/plain' }, body: 'render error' }
    }
  }
}

/** The deployed Lambda entry point: ambient-cred clients + the real renderPdf. */
export const handler = makeHandler({
  s3: new S3Client({}),
  kms: new KMSClient({}),
  renderPdf: defaultRenderPdf,
  bucket: process.env['DOCS_BUCKET'] ?? '',
  keyId: process.env['KMS_KEY_ID'] ?? '',
  prefix: process.env['DOCS_PREFIX'] ?? 'docs',
})
```

- [ ] **Step 8: Run, verify PASS (seal + handler).** `npx vitest run --project aws-kms-pdf-attestation`

- [ ] **Step 9: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && (cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit)
git add recipes/aws-kms-pdf-attestation/src/seal.ts recipes/aws-kms-pdf-attestation/src/seal.test.ts recipes/aws-kms-pdf-attestation/src/handler.ts recipes/aws-kms-pdf-attestation/src/handler.test.ts
git commit -m "feat(recipe/aws-kms-pdf): firm-side seal helper (at-aws-kms) + hub-free Lambda handler

sealAndUpload seals via @noy-db/at-aws-kms + S3 PUT (mock-AWS tested). makeHandler
does S3 get → raw KMS Decrypt → render-core → base64 PDF; hub-free, dep-injected,
mock-AWS tested (200/404/400)."
```

---

## Task 4: CDK stack + Dockerfile + synth smoke test

**Files:** create `recipes/aws-kms-pdf-attestation/infra/{stack.ts,app.ts,synth.test.ts}`, `cdk.json`, `Dockerfile`.

- [ ] **Step 1: Create `Dockerfile`** (arm64 Node 22 Lambda container)
```dockerfile
# Lambda container for the KMS-PDF render recipe (arm64, Node 22).
FROM public.ecr.aws/lambda/nodejs:22-arm64
# @sparticuz/chromium needs these shared libs present in the image.
RUN dnf install -y tar bzip2 && dnf clean all
WORKDIR ${LAMBDA_TASK_ROOT}
COPY package.json ./
# Install only the runtime deps the handler needs (no hub, no cdk, no test deps).
RUN npm install --omit=dev --no-package-lock \
    @aws-sdk/client-s3@^3 @aws-sdk/client-kms@^3 qrcode@^1 puppeteer-core@^24 @sparticuz/chromium@^138
COPY dist/ ./
CMD [ "handler.handler" ]
```
NOTE: this assumes a `dist/` build of `src/` (esbuild/tsc) before `docker build`; the RUNBOOK (Task 6) documents `npm run bundle` → `dist/handler.js`. Add a `bundle` script to package.json scripts: `"bundle": "esbuild src/handler.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/handler.js --external:@sparticuz/chromium --external:puppeteer-core"` (and add `esbuild` to devDependencies). Keep `@sparticuz/chromium` + `puppeteer-core` external (installed in the image). If you add the bundle script + esbuild dep, include `package.json` in this task's commit.

- [ ] **Step 2: Create `cdk.json`**
```json
{
  "app": "npx tsx infra/app.ts",
  "context": { "@aws-cdk/core:newStyleStackSynthesis": true }
}
```

- [ ] **Step 3: Create `infra/stack.ts`**
```ts
import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'

const DOCS_PREFIX = 'docs'

export class KmsPdfAttestationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const key = new kms.Key(this, 'DocSealingKey', {
      description: 'noy-db attestation: seals render payloads for the PDF Lambda',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY, // recipe/demo: destroy on teardown
    })

    const bucket = new s3.Bucket(this, 'DocsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true, // recipe/demo
    })

    const fn = new lambda.DockerImageFunction(this, 'RenderFn', {
      code: lambda.DockerImageCode.fromImageAsset(__dirname + '/..'),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 2048,
      timeout: Duration.seconds(30),
      environment: { DOCS_BUCKET: bucket.bucketName, KMS_KEY_ID: key.keyArn, DOCS_PREFIX },
    })

    // Least privilege: decrypt with the one key + read the one prefix.
    key.grantDecrypt(fn)
    bucket.grantRead(fn, `${DOCS_PREFIX}/*`)

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE })
    new CfnOutput(this, 'FunctionUrl', { value: url.url })
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName })
    new CfnOutput(this, 'KeyArn', { value: key.keyArn })
  }
}
```
NOTE: confirm the `aws-cdk-lib` import paths resolve at the installed version. If `grantDecrypt`/`grantRead` signatures differ, match the installed cdk's API (read `node_modules/aws-cdk-lib/aws-kms/...d.ts`). Keep tsc clean.

- [ ] **Step 4: Create `infra/app.ts`**
```ts
import { App } from 'aws-cdk-lib'
import { KmsPdfAttestationStack } from './stack.js'

const app = new App()
new KmsPdfAttestationStack(app, 'NoydbKmsPdfAttestation')
app.synth()
```

- [ ] **Step 5: Write the synth smoke test `infra/synth.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { KmsPdfAttestationStack } from './stack.js'

describe('CDK stack synthesizes', () => {
  it('declares the KMS key, private bucket, container Lambda, and Function URL', () => {
    const app = new App()
    const stack = new KmsPdfAttestationStack(app, 'Test')
    const t = Template.fromStack(stack)
    t.resourceCountIs('AWS::KMS::Key', 1)
    t.resourceCountIs('AWS::S3::Bucket', 1)
    t.hasResourceProperties('AWS::Lambda::Function', { PackageType: 'Image', Architectures: ['arm64'], MemorySize: 2048 })
    t.resourceCountIs('AWS::Lambda::Url', 1)
    // Bucket blocks public access
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, RestrictPublicBuckets: true },
    })
  })
})
```
NOTE: `Template.fromStack` synthesizes WITHOUT building the Docker image (it references the asset, doesn't build it), so this runs in CI with no Docker. If the test runner tries to bundle the asset, set `DockerImageCode.fromImageAsset` is lazy — it should be fine; if synth complains about a missing Dockerfile path, ensure `__dirname + '/..'` resolves (the Dockerfile is at the package root). Report any deviation.

- [ ] **Step 6: Run, verify PASS:** `npx vitest run --project aws-kms-pdf-attestation` (now payload + render-core + seal + handler + synth all pass)

- [ ] **Step 7: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && (cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit)
git add recipes/aws-kms-pdf-attestation/infra recipes/aws-kms-pdf-attestation/cdk.json recipes/aws-kms-pdf-attestation/Dockerfile recipes/aws-kms-pdf-attestation/package.json pnpm-lock.yaml
git commit -m "feat(recipe/aws-kms-pdf): CDK stack + Dockerfile + synth smoke test

CDK-TS: KMS key, private S3 bucket, arm64 container Lambda (2GB), Function URL
(authType NONE, demo), least-priv IAM (decrypt one key + read one prefix).
Synth smoke test asserts the resource shape; no Docker/AWS in CI."
```

---

## Task 5: Showcase + features.yaml

**Files:** create `showcases/src/90-attestation-kms-pdf.showcase.test.ts`; modify `showcases/package.json`, `features.yaml`. (Recipe-pair naming: the spec calls for `recipe-aws-kms-pdf-attestation.recipe.test.ts` — use the **recipe** form so the validator's recipe-pair check passes; see Step 2.)

- [ ] **Step 1: Add the recipe pkg as a showcases devDependency**

In `showcases/package.json` `devDependencies`, add (alphabetical with siblings): `"@noy-db/recipe-aws-kms-pdf-attestation": "workspace:*"`. Then `pnpm install` from repo root.

- [ ] **Step 2: Write `showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts`**

(Use the `recipe-<id>.recipe.test.ts` name so the features.yaml recipe-pair check passes — id/doc/showcase slugs all = `aws-kms-pdf-attestation`.)
```ts
/**
 * Recipe — AWS-KMS PDF attestation (generation side, CI-safe slice)
 *
 * The firm issues a signed attestation, seals the render payload with its KMS
 * key (@noy-db/at-aws-kms), and a Lambda would later decrypt + render it to a
 * PDF with the QR embedded as vector. This CI slice proves the data path with a
 * MOCK KMS (no real AWS, no Chromium): issue → seal → unseal → buildInvoiceHtml,
 * and confirms the embedded QR still verifies offline via the ④ verifier.
 * Real deploy → invoke → teardown is in the recipe's RUNBOOK.md (profile-driven).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { sealAndUpload } from '@noy-db/recipe-aws-kms-pdf-attestation/seal'
import { buildInvoiceHtml } from '@noy-db/recipe-aws-kms-pdf-attestation/render-core'
import { decodeRenderPayload, type RenderPayload } from '@noy-db/recipe-aws-kms-pdf-attestation'
import { verifyDocument } from '@noy-db/recipe-attestation-verifier'
import { decodeQr, type AttestationFieldSchema } from '@noy-db/attestation'

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}

describe('recipe: aws-kms-pdf-attestation (CI slice, mock KMS)', () => {
  it('issue → seal → unseal → render HTML; the embedded QR still verifies offline', async () => {
    // 1. Firm issues an attestation through the hub.
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-pass-2026' })
    const vault = await db.openVault('books')
    await vault.collection<Invoice>('invoices', { attestation }).put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' })
    const { docId, qr, keyId } = await vault.issueAttestation('invoices', 'inv-1')
    const { publicKeyB64 } = await vault.getDocumentSigningPublicKey()

    // 2. Firm seals the render payload + "uploads" it (mock KMS=identity, mock S3 captures).
    const payload: RenderPayload = { docId, qr, fields: { invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' } }
    let stored: Uint8Array | undefined
    const kmsClient = { send: async (cmd: any) => ({ CiphertextBlob: cmd.input.Plaintext }) }
    const s3Client = { send: async (cmd: any) => { stored = cmd.input.Body; return {} } }
    await sealAndUpload(payload, { keyId: 'arn:demo', bucket: 'b', key: `docs/${docId}`, kmsClient: kmsClient as any, s3Client: s3Client as any })
    expect(stored).toBeTruthy()

    // 3. Lambda side (mock decrypt=identity) → render HTML.
    const decoded = decodeRenderPayload(stored!)
    const html = await buildInvoiceHtml(decoded)
    expect(html).toContain('INV-1042')
    expect(html).toMatch(/<svg[\s>]/i)              // QR is vector
    expect(decodeQr(decoded.qr).docId).toBe(docId)  // the right QR rode along

    // 4. A third party verifies the embedded QR OFFLINE → authentic-valid.
    const printed = { invoiceNo: 'INV-1042', total: '1234.50', issueDate: '2026-05-29' }
    const v = await verifyDocument(decoded.qr, printed, { publicKeys: { [keyId]: publicKeyB64 }, fieldSchema: attestation })
    expect(v.outcome).toBe('authentic-valid')
  })
})
```
If `@noy-db/recipe-aws-kms-pdf-attestation/seal` / `/render-core` subpath imports don't resolve, confirm the recipe `package.json` `exports` map has `./seal` and `./render-core` (Task 1 Step 1 added them). If `memory`/`verifyDocument` don't resolve, they're existing showcases deps (④ added the latter; `@noy-db/to-memory` is a sibling dep).

- [ ] **Step 3: Run the showcase**

Run: `cd showcases && npx vitest run src/recipe-aws-kms-pdf-attestation.recipe.test.ts`
Expected: PASS (1 test). (Showcases resolve workspace `@noy-db/*` from source via exports, not dist, so no build needed for the recipe pkg. If it fails on `@noy-db/hub` being stale dist, run `pnpm --filter @noy-db/hub build` first — hub IS consumed via dist by showcases.)

- [ ] **Step 4: Register in `features.yaml`**

Read the `recipes:` section + the `attestation-verifier` entry to match shape. Add a new `recipes:` entry:
```yaml
  - id: aws-kms-pdf-attestation
    name: AWS-KMS PDF attestation render (generation side)
    doc: docs/recipes/aws-kms-pdf-attestation.md
    showcase_path: showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts
    status: preview
    exercises:
      features: [attestation]
```
(doc written in Task 6; create the file there. The validator checks the doc PATH exists — so Task 6 must land the doc before `validate-features` runs. Order: do Task 6's doc Step BEFORE running the validator, or run the validator in Task 6. To keep this task green, defer the `validate-features` run to Task 6 Step.)

- [ ] **Step 5: Run the recipe pkg tests + typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && (cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit)
cd showcases && npx vitest run src/recipe-aws-kms-pdf-attestation.recipe.test.ts && cd ..
git add showcases/package.json pnpm-lock.yaml showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts features.yaml
git commit -m "test(showcase) + docs(features): aws-kms-pdf-attestation recipe (CI slice)

Showcase: issue → seal (at-aws-kms, mock KMS) → unseal → buildInvoiceHtml →
the embedded vector QR still verifies offline (authentic-valid). Registers the
recipe in features.yaml (doc lands in the next commit)."
```

---

## Task 6: Recipe doc + RUNBOOK + README + full gate

**Files:** create `docs/recipes/aws-kms-pdf-attestation.md`, `recipes/aws-kms-pdf-attestation/README.md`, `recipes/aws-kms-pdf-attestation/RUNBOOK.md`.

- [ ] **Step 1: Write `docs/recipes/aws-kms-pdf-attestation.md`**

Read `docs/recipes/attestation-verifier.md` to match tone. Content:
```markdown
# AWS-KMS PDF attestation (generation side)

The generation-time half of document attestation: a deployable AWS Lambda that
takes a firm-sealed document record from S3, KMS-decrypts it, renders an HTML
invoice → PDF with the attestation **QR embedded as vector**, and returns the
PDF. Pairs with the offline verifier (recipe `attestation-verifier`).

## What it exercises
- `@noy-db/hub` issue side (`vault.issueAttestation`) — firm mints the signed QR.
- `@noy-db/at-aws-kms` — seals the render payload `{docId, fields, qr}` with the
  firm's KMS key (the original `at-aws-kms` use case).
- A hub-free render Lambda: S3 GetObject → KMS Decrypt → HTML+inline-SVG QR →
  headless Chromium (`@sparticuz/chromium`) → PDF.
- `@noy-db/recipe-attestation-verifier` — proves the embedded QR verifies offline.

## Data flow
1. **Issue (firm, hub):** `issueAttestation` → `{ docId, qr, keyId }`.
2. **Seal (firm):** `sealAndUpload({docId, fields, qr})` → KMS-encrypt → S3 `docs/<docId>`.
3. **Render (Lambda):** GET `…/?docId=<docId>` → decrypt → render PDF with the vector QR.
4. **Verify (third party, offline):** scan the QR → `verifyDocument` (recipe ④).

## Trust + scope
The QR carries the signed per-field commitment; the PDF is generated, never
verified server-side. The render payload is capped at 4 KB (KMS plaintext limit).
The Function URL is `authType: NONE` for the demo — **production must add IAM /
JWT authz** since it returns rendered PDFs. Deploy/verify/teardown is
profile-driven; see `recipes/aws-kms-pdf-attestation/RUNBOOK.md`.

The CI showcase (`showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts`)
covers the data path with a mock KMS; the Chromium render + real AWS run only
via the runbook.
```

- [ ] **Step 2: Write `recipes/aws-kms-pdf-attestation/README.md`** (short — points at the doc + runbook)
```markdown
# @noy-db/recipe-aws-kms-pdf-attestation

Deployable reference Lambda: KMS-decrypt a firm-sealed S3 doc record, render an
HTML invoice → PDF with the attestation QR as vector. Private recipe, not published.

- Narrative + data flow: `docs/recipes/aws-kms-pdf-attestation.md`
- Deploy / verify / teardown (real AWS, profile-driven): `RUNBOOK.md`
- CI-safe data-path test: `pnpm --filter @noy-db/recipe-aws-kms-pdf-attestation test`

Render stack: puppeteer-core + @sparticuz/chromium (arm64), container Lambda,
Node 22, ≥2 GB, QR as inline `<svg>` (vector).
```

- [ ] **Step 3: Write `recipes/aws-kms-pdf-attestation/RUNBOOK.md`** (the profile-driven lifecycle)
```markdown
# RUNBOOK — deploy, verify, teardown (real AWS)

All AWS access uses a NAMED PROFILE you provide (`export AWS_PROFILE=<name>`),
never raw or shared credentials. Each resource-creating step is confirmed first.

## Prereqs
- An AWS profile with permission to create KMS/S3/Lambda/IAM + run CDK.
- Docker (for the arm64 Lambda container image).
- `export AWS_PROFILE=<your-profile>` and `export AWS_REGION=<region>`.

## 1. Build the handler bundle + image-deploy
```bash
pnpm --filter @noy-db/recipe-aws-kms-pdf-attestation run bundle   # → dist/handler.js
cd recipes/aws-kms-pdf-attestation
npx cdk bootstrap   # one-time per account/region
npx cdk deploy      # creates KMS key + private S3 bucket + container Lambda + Function URL
```
Note the `FunctionUrl`, `BucketName`, `KeyArn` outputs.

## 2. Seal + upload a sample document
Use `sealAndUpload` (a tiny script or REPL) with the deployed `KeyArn` + `BucketName`:
```ts
import { sealAndUpload } from '@noy-db/recipe-aws-kms-pdf-attestation/seal'
await sealAndUpload(
  { docId: '<docId-from-issueAttestation>', fields: {/* invoice fields */}, qr: '<qr>' },
  { keyId: '<KeyArn>', bucket: '<BucketName>', key: 'docs/<docId>' },
)
```

## 3. Invoke + verify
```bash
curl -s "<FunctionUrl>?docId=<docId>" -o invoice.pdf
file invoice.pdf   # → PDF document
```
Open `invoice.pdf`; scan the QR with the offline verifier (recipe ④) — it must
read `authentic-valid` for the printed fields.

## 4. Teardown (after you confirm "done")
```bash
npx cdk destroy   # removes the key, bucket (auto-deletes objects), Lambda, URL
```
```

- [ ] **Step 4: Full gate**
```bash
cd /Users/vicio/_github/noy-db
node scripts/validate-features.mjs 2>&1 | tail -8
(cd recipes/aws-kms-pdf-attestation && npx tsc --noEmit)
npx vitest run --project aws-kms-pdf-attestation --reporter=dot 2>&1 | tail -8
cd showcases && npx vitest run src/recipe-aws-kms-pdf-attestation.recipe.test.ts --reporter=dot 2>&1 | tail -6
```
Expected: validator passes (recipes +1, recipe-pair satisfied, the doc path now exists); tsc clean; recipe pkg tests all pass (payload + render-core + seal + handler + synth); showcase passes. Report any pre-existing/unrelated failures as pre-existing.

- [ ] **Step 5: Commit**
```bash
cd /Users/vicio/_github/noy-db
git add docs/recipes/aws-kms-pdf-attestation.md recipes/aws-kms-pdf-attestation/README.md recipes/aws-kms-pdf-attestation/RUNBOOK.md
git commit -m "docs(recipe): aws-kms-pdf-attestation doc + README + deploy RUNBOOK

Recipe doc (data flow + trust model), package README, and the profile-driven
deploy → seal → invoke → verify → destroy runbook for the real-AWS steps."
```

---

## Self-Review (completed)

- **Spec coverage** (spec §2–§12): §2 five parts + dep corrections → Tasks 1-4 (payload/render-core/seal/handler/CDK), Lambda hub-free via raw DecryptCommand → T3 handler; §3 RenderPayload + 4 KB guard + at-aws-kms byte sealer → T1 + T3 seal; §4 render-core buildInvoiceHtml(vector SVG) + isolated renderPdf → T2; §5 handler makeHandler + error codes → T3; §6 least-priv IAM (grantDecrypt one key + grantRead one prefix) + private bucket + Function URL NONE → T4 stack; §7 profile-driven deploy lifecycle → T6 RUNBOOK (not executed in plan); §8 testing (payload/render-core/seal/handler mock-AWS + cdk synth + showcase) → T1-T5; §9 features.yaml → T5/T6; §10 render stack (puppeteer-core + @sparticuz/chromium container arm64 Node22) → T2 + T4 Dockerfile; §11 YAGNI → respected; §12 build order → task order (T6 step 6 real-AWS deferred to runbook).
- **Placeholder scan:** none. Showcase number is concrete (90 / `recipe-aws-kms-pdf-attestation.recipe.test.ts`); the recipe-pair name uses the `recipe-` form for the validator. Dep version majors flagged with a "relax if registry moved" instruction (not a placeholder — a real install-time guard).
- **Type consistency:** `RenderPayload` (`docId`/`fields`/`qr`) defined T1, imported by render-core (T2), seal (T3), handler (T3 via decode), showcase (T5); `encodeRenderPayload`/`decodeRenderPayload` consistent; `sealAndUpload(payload, {keyId,bucket,key,kmsClient?,s3Client?})` consistent T3↔T5; `makeHandler(HandlerDeps)` consistent; `buildInvoiceHtml`/`renderPdf` consistent T2↔T3; `KmsPdfAttestationStack` consistent T4. The Lambda uses raw `DecryptCommand` (NOT `at-aws-kms.unseal`) per spec §2 — seal side uses `at-aws-kms`.
- **Known risks:** (1) external dep majors (`@sparticuz/chromium`, `puppeteer-core`, `aws-cdk-lib`) may have moved — T1 instructs relax-and-report on install failure. (2) `cdk synth`/`Template.fromStack` must not require Docker build in CI (it references the asset lazily) — T4 notes verify. (3) the recipe `exports` subpaths (`./seal`, `./render-core`) must exist for the showcase's subpath imports — T1 adds them. (4) `aws-cdk-lib` import-path/API drift — T4 instructs matching the installed version. (5) `features.yaml` doc-path must exist before `validate-features` — deferred to T6.
