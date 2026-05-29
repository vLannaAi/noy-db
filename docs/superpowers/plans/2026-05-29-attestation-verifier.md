# Document Attestation ④ — Offline Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL GIT RULE for every subagent:** NEVER run `git stash`, `git stash pop`, `git reset`, `git checkout HEAD -- <files>`, or `git clean`. A pre-existing user stash (`stash@{0}: WIP on main`) must never be touched. Only `git add <scoped paths>` + `git commit` + read-only git. If you think you need anything else, STOP and report.
>
> **ALWAYS typecheck before committing** — vitest uses esbuild and does NOT typecheck. Run the relevant `tsc --noEmit` per task. Repo-wide `moduleResolution: bundler`; the repo passes `Uint8Array` to WebCrypto via `as BufferSource` casts where needed.

**Goal:** Ship the offline, client-side, no-server document-attestation verifier — a self-contained static `verifier.html` plus the registered recipe (doc + showcase) — consuming only `@noy-db/attestation`.

**Architecture:** A new private workspace package `recipes/attestation-verifier/` (④ pioneers the top-level `recipes/` code dir). It centres on one shared `verify-core.ts` (`verifyDocument()`), used by both the page (`app.ts` → built to a single inlined `dist/verifier.html` via esbuild) and the tests. Public keys, the field schema, and a signed revocation snapshot are bundled at build time. The recipe doc + a `.recipe.test.ts` showcase demonstrate the end-to-end **firm issues (hub) → third party verifies (pure, offline)** boundary.

**Tech Stack:** TypeScript, WebCrypto, Vitest, esbuild, pnpm workspace. Depends on the merged `@noy-db/attestation` (①a) and `@noy-db/hub` (①b).

**Spec:** `docs/superpowers/specs/2026-05-29-attestation-verifier-design.md`.

**Branch:** `feat/attestation-verifier` (already checked out, based on `main` incl. #236).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `pnpm-workspace.yaml` | Modify | add `recipes/*` to `packages` globs |
| `vitest.config.ts` | Modify | add `recipes/*/vitest.config.ts` to root `projects` |
| `recipes/attestation-verifier/package.json` | Create | private pkg, exports `verify-core`, scripts build/typecheck |
| `recipes/attestation-verifier/tsconfig.json` | Create | extends base, lib ES2022+DOM |
| `recipes/attestation-verifier/vitest.config.ts` | Create | project `attestation-verifier`, node env |
| `recipes/attestation-verifier/src/verify-core.ts` | Create | `verifyDocument()` — the one shared verdict fn |
| `recipes/attestation-verifier/src/verify-core.test.ts` | Create | unit test — all 7 outcomes |
| `recipes/attestation-verifier/scripts/gen-sample.mjs` | Create | mint demo keypair → write config.ts + sample-qr.txt |
| `recipes/attestation-verifier/src/config.ts` | Create (generated) | bundled `config` + `sample` demo data |
| `recipes/attestation-verifier/public/sample-qr.txt` | Create (generated) | the demo QR to paste |
| `recipes/attestation-verifier/src/config.test.ts` | Create | demo-data self-consistency guard |
| `recipes/attestation-verifier/index.html` | Create | layout A markup + `<!-- APP_BUNDLE -->` slot |
| `recipes/attestation-verifier/src/app.ts` | Create | DOM glue → verifyDocument → render |
| `recipes/attestation-verifier/build.mjs` | Create | esbuild → inline → `dist/verifier.html` |
| `recipes/attestation-verifier/build.test.ts` | Create | build smoke test (exists, self-contained) |
| `recipes/attestation-verifier/README.md` | Create | configure → build → open |
| `showcases/package.json` | Modify | add recipe pkg as devDependency |
| `showcases/src/recipe-attestation-verifier.recipe.test.ts` | Create | end-to-end showcase |
| `docs/recipes/attestation-verifier.md` | Create | narrative recipe doc |
| `features.yaml` | Modify | new `recipes:` entry + cross-ref on `attestation` feature row |

---

## Task 1: Recipe package skeleton + workspace/vitest wiring + `verify-core` (TDD)

**Files:** modify `pnpm-workspace.yaml`, `vitest.config.ts`; create `recipes/attestation-verifier/{package.json,tsconfig.json,vitest.config.ts,src/verify-core.ts}`; test `recipes/attestation-verifier/src/verify-core.test.ts`.

- [ ] **Step 1: Add `recipes/*` to the workspace + root vitest projects**

In `pnpm-workspace.yaml`, add under `packages:` (after `showcases`):
```yaml
  - "recipes/*"
```
In `vitest.config.ts`, change `projects` to include the recipes glob:
```ts
    projects: [
      'packages/*/vitest.config.ts',
      'test-harnesses/*/vitest.config.ts',
      'recipes/*/vitest.config.ts',
    ],
```

- [ ] **Step 2: Create `recipes/attestation-verifier/package.json`**
```json
{
  "name": "@noy-db/recipe-attestation-verifier",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Offline document-attestation verifier — self-contained static page + shared verify core. Reference recipe, not published.",
  "exports": {
    ".": "./src/verify-core.ts"
  },
  "scripts": {
    "build": "node build.mjs",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@noy-db/attestation": "workspace:*"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "typescript": "^5.7.0",
    "vitest": "^3.2.4"
  }
}
```
(Confirm the `typescript`/`vitest` versions match the repo root `package.json`; if they differ, mirror the root versions exactly.)

- [ ] **Step 3: Create `recipes/attestation-verifier/tsconfig.json`**
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
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "build.mjs", "scripts/**/*.mjs"]
}
```
(If `tsc` errors on `.mjs` includes, drop them from `include` — the `.mjs` files are run by node, not typechecked.)

- [ ] **Step 4: Create `recipes/attestation-verifier/vitest.config.ts`**
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'attestation-verifier',
    environment: 'node',
    include: ['src/**/*.test.ts', 'build.test.ts'],
    globals: false,
  },
})
```

- [ ] **Step 5: Install**

Run from repo root: `pnpm install`
Expected: links `@noy-db/recipe-attestation-verifier`; no errors.

- [ ] **Step 6: Write the failing test `src/verify-core.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { verifyDocument } from './verify-core.js'
import {
  generateDocSigningKeyPair, computeFieldHashes, signPayloadCore, encodeQr,
  signRevocationList, bytesToB64url,
  type AttestationFieldSchema, type QrPayload,
} from '@noy-db/attestation'

const fieldSchema: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}
// The verifier types STRINGS (HTML inputs); normalizers canonicalize them.
const record = { invoiceNo: 'INV-1', total: '1234.5', issueDate: '2026-05-29' }
const DOC = '01J0000000000000000000000A'

async function mint(
  signer: { keyId: string; privateKeyPkcs8B64: string },
  rec: Record<string, unknown> = record,
  docId = DOC,
): Promise<string> {
  const salt = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))
  const fieldHashes = await computeFieldHashes(salt, fieldSchema, rec)
  const sig = await signPayloadCore({ v: 1, docId, salt, keyId: signer.keyId, fieldHashes }, signer.privateKeyPkcs8B64)
  const payload: QrPayload = { v: 1, docId, salt, alg: 'ed25519', keyId: signer.keyId, fieldHashes, sig }
  return encodeQr(payload)
}

describe('verifyDocument', () => {
  it('authentic-valid for correct fields, no revocation list', async () => {
    const k = await generateDocSigningKeyPair()
    const qr = await mint(k)
    const v = await verifyDocument(qr, record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('authentic-valid')
    expect(v.revocationTrusted).toBeNull()
    expect(v.perField.every((f) => f.match)).toBe(true)
  })

  it('altered when a field differs — localizes which', async () => {
    const k = await generateDocSigningKeyPair()
    const qr = await mint(k)
    const v = await verifyDocument(qr, { ...record, total: '9999' }, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('altered')
    expect(v.perField.find((f) => f.path === 'total')!.match).toBe(false)
    expect(v.perField.find((f) => f.path === 'invoiceNo')!.match).toBe(true)
  })

  it('authentic-revoked when a trusted list contains the docId', async () => {
    const k = await generateDocSigningKeyPair()
    const qr = await mint(k)
    const list = await signRevocationList([DOC], '2026-05-29T00:00:00.000Z', k.keyId, k.privateKeyPkcs8B64)
    const v = await verifyDocument(qr, record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema, revocationList: list })
    expect(v.outcome).toBe('authentic-revoked')
    expect(v.revocationTrusted).toBe(true)
  })

  it('rotation-safe: keyId selects among multiple bundled keys', async () => {
    const k1 = await generateDocSigningKeyPair()
    const k2 = await generateDocSigningKeyPair()
    const qr = await mint(k1)
    const v = await verifyDocument(qr, record, { publicKeys: { [k1.keyId]: k1.publicKeyB64, [k2.keyId]: k2.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('authentic-valid')
  })

  it('unknown-key when the QR keyId is not bundled', async () => {
    const k = await generateDocSigningKeyPair()
    const other = await generateDocSigningKeyPair()
    const qr = await mint(k)
    const v = await verifyDocument(qr, record, { publicKeys: { [other.keyId]: other.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('unknown-key')
  })

  it('unreadable-qr for a malformed QR string', async () => {
    const k = await generateDocSigningKeyPair()
    const v = await verifyDocument('this-is-not-a-qr', record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('unreadable-qr')
  })

  it('untrusted revocation list never marks a valid doc revoked', async () => {
    const k = await generateDocSigningKeyPair()
    const wrong = await generateDocSigningKeyPair()
    const qr = await mint(k)
    // list signed by the WRONG key but verified against k's public key → sig fails
    const badList = await signRevocationList([DOC], '2026-05-29T00:00:00.000Z', k.keyId, wrong.privateKeyPkcs8B64)
    const v = await verifyDocument(qr, record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema, revocationList: badList })
    expect(v.outcome).toBe('authentic-valid')
    expect(v.revocationTrusted).toBe(false)
  })
})
```

- [ ] **Step 7: Run the test — verify it FAILS** (module not found)

Run: `npx vitest run --project attestation-verifier`
Expected: FAIL — cannot resolve `./verify-core.js`.

- [ ] **Step 8: Implement `src/verify-core.ts`**
```ts
import {
  decodeQr, verifyAttestation, verifyRevocationList,
  type AttestationFieldSchema, type RevocationList,
} from '@noy-db/attestation'

export interface VerifierConfig {
  publicKeys: Record<string, string>          // keyId → publicKeyB64 (rotation-safe; QR's keyId selects)
  fieldSchema: AttestationFieldSchema           // which fields + normalizers + order (NOT carried by the QR)
  revocationList?: RevocationList               // optional bundled signed snapshot
}

export type VerifierOutcome =
  | 'authentic-valid'
  | 'authentic-revoked'
  | 'altered'
  | 'signature-invalid'
  | 'unknown-key'
  | 'unreadable-qr'

export interface Verdict {
  outcome: VerifierOutcome
  perField: Array<{ path: string; match: boolean }>
  revocationTrusted: boolean | null             // null = no list bundled; false = list sig failed
  keyId?: string
  docId?: string
}

export async function verifyDocument(
  qr: string,
  claimedFields: Record<string, unknown>,
  config: VerifierConfig,
): Promise<Verdict> {
  let payload
  try {
    payload = decodeQr(qr)
  } catch {
    return { outcome: 'unreadable-qr', perField: [], revocationTrusted: null }
  }

  if (!(payload.keyId in config.publicKeys)) {
    return { outcome: 'unknown-key', perField: [], revocationTrusted: null, keyId: payload.keyId, docId: payload.docId }
  }

  // Revocation list signature FIRST (locked ①a contract: verifyAttestation does NOT check it).
  let revocationTrusted: boolean | null = null
  if (config.revocationList) {
    revocationTrusted = await verifyRevocationList(config.revocationList, config.publicKeys[payload.keyId])
  }

  // Pass the list to verifyAttestation only when trusted, so an untrusted list never influences `revoked`.
  const result = await verifyAttestation({
    qr,
    claimedFields,
    fieldSchema: config.fieldSchema,
    publicKeys: config.publicKeys,
    ...(revocationTrusted === true && config.revocationList ? { revocation: { list: config.revocationList } } : {}),
  })

  const perField = result.perField.map((f) => ({ path: f.path, match: f.match }))
  const allMatch = perField.length > 0 && perField.every((f) => f.match)

  let outcome: VerifierOutcome
  if (!result.signatureValid) outcome = 'signature-invalid'
  else if (!allMatch) outcome = 'altered'
  else if (result.revoked === true) outcome = 'authentic-revoked'
  else outcome = 'authentic-valid'

  return { outcome, perField, revocationTrusted, keyId: payload.keyId, docId: payload.docId }
}
```

- [ ] **Step 9: Run the test — verify it PASSES (7 tests)**

Run: `npx vitest run --project attestation-verifier`
Expected: PASS.

- [ ] **Step 10: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && (cd recipes/attestation-verifier && npx tsc --noEmit)   # clean
git add pnpm-workspace.yaml pnpm-lock.yaml vitest.config.ts recipes/attestation-verifier/package.json recipes/attestation-verifier/tsconfig.json recipes/attestation-verifier/vitest.config.ts recipes/attestation-verifier/src/verify-core.ts recipes/attestation-verifier/src/verify-core.test.ts
git commit -m "feat(recipe/attestation-verifier): verify-core + package skeleton

New private recipes/attestation-verifier package (pioneers recipes/). One
shared verifyDocument() composing @noy-db/attestation: decodeQr → keyId
membership → verifyRevocationList (sig first) → verifyAttestation. Untrusted
revocation lists are fail-soft (never flip a valid doc to revoked)."
```

---

## Task 2: Demo data — `gen-sample.mjs` → `config.ts` + `sample-qr.txt`

**Files:** create `recipes/attestation-verifier/scripts/gen-sample.mjs`, `recipes/attestation-verifier/src/config.ts` (generated), `recipes/attestation-verifier/public/sample-qr.txt` (generated); test `recipes/attestation-verifier/src/config.test.ts`.

- [ ] **Step 1: Write `scripts/gen-sample.mjs`**

Mints a throwaway demo keypair, issues a sample attestation, and writes the bundled config + a sample QR. The private key is discarded — only the public key, schema, signed (empty) revocation list, sample record, and sample QR are persisted.
```js
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateDocSigningKeyPair, computeFieldHashes, signPayloadCore, encodeQr,
  signRevocationList, bytesToB64url,
} from '@noy-db/attestation'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const fieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}
const sampleRecord = { invoiceNo: 'INV-1042', total: '1234.50', issueDate: '2026-05-29' }
const docId = '01J0000000000000000000DEMO'

const k = await generateDocSigningKeyPair()
const salt = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))
const fieldHashes = await computeFieldHashes(salt, fieldSchema, sampleRecord)
const sig = await signPayloadCore({ v: 1, docId, salt, keyId: k.keyId, fieldHashes }, k.privateKeyPkcs8B64)
const qr = encodeQr({ v: 1, docId, salt, alg: 'ed25519', keyId: k.keyId, fieldHashes, sig })
const revocationList = await signRevocationList([], '2026-05-29T00:00:00.000Z', k.keyId, k.privateKeyPkcs8B64)

const configTs = `// GENERATED by scripts/gen-sample.mjs — demo values. A real deployment
// replaces \`publicKeys\` + \`fieldSchema\` + \`revocationList\` with the firm's
// published key(s), the collection's attestation schema, and the latest signed
// revocation list. Re-run \`node scripts/gen-sample.mjs\` to refresh the demo.
import type { VerifierConfig } from './verify-core.js'

export const config: VerifierConfig = {
  publicKeys: ${JSON.stringify({ [k.keyId]: k.publicKeyB64 }, null, 2)},
  fieldSchema: ${JSON.stringify(fieldSchema, null, 2)},
  revocationList: ${JSON.stringify(revocationList, null, 2)},
}

/** Demo document a reader can load to see a green verdict without a real QR. */
export const sample: { qr: string; record: Record<string, unknown> } = {
  qr: ${JSON.stringify(qr)},
  record: ${JSON.stringify(sampleRecord, null, 2)},
}
`
writeFileSync(join(root, 'src/config.ts'), configTs)
mkdirSync(join(root, 'public'), { recursive: true })
writeFileSync(join(root, 'public/sample-qr.txt'), qr + '\n')
console.log('wrote src/config.ts + public/sample-qr.txt (keyId', k.keyId + ')')
```

- [ ] **Step 2: Generate the demo data**

Run: `cd recipes/attestation-verifier && node scripts/gen-sample.mjs`
Expected: writes `src/config.ts` + `public/sample-qr.txt`.

- [ ] **Step 3: Write the self-consistency guard `src/config.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { config, sample } from './config.js'
import { verifyDocument } from './verify-core.js'

describe('bundled demo data', () => {
  it('the committed sample QR verifies authentic-valid against the bundled config', async () => {
    const v = await verifyDocument(sample.qr, sample.record, config)
    expect(v.outcome).toBe('authentic-valid')
    expect(v.revocationTrusted).toBe(true)   // bundled list is signed by the same demo key
  })
})
```

- [ ] **Step 4: Run — verify it PASSES**

Run: `npx vitest run --project attestation-verifier`
Expected: PASS (8 tests total now).

- [ ] **Step 5: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && (cd recipes/attestation-verifier && npx tsc --noEmit)
git add recipes/attestation-verifier/scripts/gen-sample.mjs recipes/attestation-verifier/src/config.ts recipes/attestation-verifier/public/sample-qr.txt recipes/attestation-verifier/src/config.test.ts
git commit -m "feat(recipe/attestation-verifier): bundled demo data (gen-sample → config + sample QR)

gen-sample.mjs mints a throwaway demo keypair, issues a sample attestation,
and writes the bundled VerifierConfig + a paste-ready sample QR. A
self-consistency test proves the committed demo data verifies out of the box."
```

---

## Task 3: The page — `index.html` + `app.ts` + `build.mjs` + smoke test

**Files:** create `recipes/attestation-verifier/{index.html,src/app.ts,build.mjs,build.test.ts,README.md}`.

- [ ] **Step 1: Create `index.html` (layout A)**
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Document Attestation — Offline Verifier</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1f2733; }
  h1 { font-size: 1.3rem; } .sub { color: #667; font-size: .9rem; }
  textarea, input { width: 100%; box-sizing: border-box; padding: .5rem; border: 1px solid #cdd6e6; border-radius: 6px; font: inherit; }
  textarea { font-family: monospace; font-size: .8rem; min-height: 84px; }
  .field { display: flex; gap: .5rem; align-items: center; margin: .4rem 0; }
  .field span { width: 7rem; color: #556; }
  button { background: #2f6df0; color: #fff; border: 0; border-radius: 6px; padding: .6rem 1rem; font: inherit; font-weight: 600; cursor: pointer; margin: .6rem 0; }
  .link { background: none; color: #2f6df0; padding: 0; font-weight: 400; text-decoration: underline; }
  .banner { border-radius: 8px; padding: .8rem; font-weight: 700; margin: .6rem 0; }
  .ok { background: #e7f8ee; color: #15703f; border: 1px solid #5ec98c; }
  .bad { background: #fdeceb; color: #a32; border: 1px solid #e88; }
  .warn { background: #fff7e6; color: #946200; border: 1px solid #e8c870; }
  .row { display: flex; justify-content: space-between; border-bottom: 1px dashed #dde; padding: .25rem 0; }
  .row.m { color: #15703f; } .row.x { color: #c0392b; }
  .foot { color: #889; font-size: .8rem; margin-top: .6rem; }
</style>
</head>
<body>
  <h1>Offline document verifier</h1>
  <p class="sub">Runs entirely in your browser. No data leaves this page. The firm's public key is built in.</p>
  <label class="sub">1 · Paste the QR payload from the document</label>
  <textarea id="qr" placeholder="paste QR string…"></textarea>
  <button class="link" id="load-sample" type="button">load a sample document</button>
  <p class="sub">2 · Type the values printed on the document</p>
  <div id="fields"></div>
  <button id="verify" type="button">Verify</button>
  <div id="result"></div>
  <!-- APP_BUNDLE -->
</body>
</html>
```

- [ ] **Step 2: Create `src/app.ts` (DOM glue)**
```ts
import { config, sample } from './config.js'
import { verifyDocument, type Verdict } from './verify-core.js'

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function renderFields(): void {
  const wrap = byId('fields')
  wrap.innerHTML = ''
  for (const f of config.fieldSchema.fields) {
    const row = document.createElement('label')
    row.className = 'field'
    row.innerHTML = `<span>${f.path}</span>`
    const input = document.createElement('input')
    input.dataset['path'] = f.path
    row.appendChild(input)
    wrap.appendChild(row)
  }
}

function readClaimed(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const el of document.querySelectorAll<HTMLInputElement>('input[data-path]')) {
    out[el.dataset['path'] as string] = el.value
  }
  return out
}

const BANNER: Record<Verdict['outcome'], { cls: string; text: string }> = {
  'authentic-valid': { cls: 'ok', text: '✓ AUTHENTIC & VALID' },
  'authentic-revoked': { cls: 'warn', text: '⚠ REVOKED — issued by the firm, since withdrawn' },
  'altered': { cls: 'bad', text: '✗ ALTERED — does not match the signature' },
  'signature-invalid': { cls: 'bad', text: '✗ SIGNATURE INVALID' },
  'unknown-key': { cls: 'warn', text: '⚠ UNRECOGNIZED KEY — update this verifier' },
  'unreadable-qr': { cls: 'warn', text: '⚠ UNREADABLE QR' },
}

function render(v: Verdict): void {
  const out = byId('result')
  const b = BANNER[v.outcome]
  // Downgrade the "valid" claim when the bundled revocation list could not be trusted.
  const text = v.outcome === 'authentic-valid' && v.revocationTrusted === false
    ? '✓ AUTHENTIC & UNALTERED · revocation status could not be confirmed'
    : b.text
  const cls = v.outcome === 'authentic-valid' && v.revocationTrusted === false ? 'warn' : b.cls
  const rows = v.perField.map((f) => `<div class="row ${f.match ? 'm' : 'x'}"><span>${f.path}</span><span>${f.match ? '✓ match' : '✗ differs'}</span></div>`).join('')
  const revBadge = v.revocationTrusted === false ? 'revocation status untrusted'
    : v.outcome === 'authentic-revoked' ? 'revoked'
    : v.revocationTrusted === true ? 'not revoked' : '—'
  out.innerHTML = `<div class="banner ${cls}">${text}</div>${rows}<div class="foot">keyId ${v.keyId ?? '—'} · docId ${v.docId ?? '—'} · ${revBadge}</div>`
}

function init(): void {
  renderFields()
  byId('verify').addEventListener('click', () => {
    void verifyDocument((byId<HTMLTextAreaElement>('qr')).value.trim(), readClaimed(), config).then(render)
  })
  byId('load-sample').addEventListener('click', () => {
    (byId<HTMLTextAreaElement>('qr')).value = sample.qr
    for (const el of document.querySelectorAll<HTMLInputElement>('input[data-path]')) {
      el.value = String(sample.record[el.dataset['path'] as string] ?? '')
    }
  })
}

init()
```

- [ ] **Step 3: Create `build.mjs`**
```js
import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const result = await esbuild.build({
  entryPoints: [join(root, 'src/app.ts')],
  bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022', minify: true,
})
const js = result.outputFiles[0].text
const html = readFileSync(join(root, 'index.html'), 'utf8')
const out = html.replace('<!-- APP_BUNDLE -->', `<script>${js}</script>`)
mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist/verifier.html'), out)
console.log(`wrote dist/verifier.html (${out.length} bytes)`)
```

- [ ] **Step 4: Build the page**

Run: `cd recipes/attestation-verifier && node build.mjs`
Expected: writes `dist/verifier.html`.

- [ ] **Step 5: Write the build smoke test `build.test.ts`**
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname)
const dist = join(root, 'dist/verifier.html')

describe('verifier.html build', () => {
  beforeAll(() => { execFileSync('node', ['build.mjs'], { cwd: root }) })

  it('emits a single self-contained file with no external network references', () => {
    expect(existsSync(dist)).toBe(true)
    const html = readFileSync(dist, 'utf8')
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:\/\//i)  // nothing fetched at runtime
    expect(html).toContain('AUTHENTIC')                            // the verdict logic is inlined
  })
})
```
(If `__dirname` is unavailable under the ESM test, replace with `dirname(fileURLToPath(import.meta.url))` and import `fileURLToPath`/`dirname`.)

- [ ] **Step 6: Run the smoke test — verify it PASSES**

Run: `npx vitest run --project attestation-verifier`
Expected: PASS (9 tests total).

- [ ] **Step 7: Create `README.md`**
```markdown
# Offline attestation verifier (reference recipe)

A single self-contained `verifier.html` that checks a document attestation
**fully offline** — no server, no network. It consumes only `@noy-db/attestation`.

## Use
1. Edit `src/config.ts`: set `publicKeys` to the firm's published key(s) (`keyId → publicKeyB64`), `fieldSchema` to the collection's attestation schema, and `revocationList` to the latest signed list. (Run `node scripts/gen-sample.mjs` to regenerate demo values.)
2. `node build.mjs` → `dist/verifier.html`.
3. Open `dist/verifier.html` in any browser (double-click — no server). Paste the QR payload, type the printed field values, click **Verify**.

## Verdict
`AUTHENTIC & VALID` · `REVOKED` · `ALTERED` (per-field localized) · `SIGNATURE INVALID` · `UNRECOGNIZED KEY` · `UNREADABLE QR`. An untrusted bundled revocation list downgrades the wording but never flips a real authenticity pass.
```

- [ ] **Step 8: Confirm `dist/` is ignored, then commit (do NOT commit `dist/`)**
```bash
cd /Users/vicio/_github/noy-db
grep -qxF 'dist/' recipes/attestation-verifier/.gitignore 2>/dev/null || printf 'dist/\n' >> recipes/attestation-verifier/.gitignore
git add recipes/attestation-verifier/index.html recipes/attestation-verifier/src/app.ts recipes/attestation-verifier/build.mjs recipes/attestation-verifier/build.test.ts recipes/attestation-verifier/README.md recipes/attestation-verifier/.gitignore
git commit -m "feat(recipe/attestation-verifier): layout-A page + esbuild single-file build

index.html + app.ts (DOM glue → verifyDocument → verdict + per-field rows,
load-sample), built by build.mjs into a self-contained dist/verifier.html.
Smoke test asserts the output has no external network references."
```
(If the repo root `.gitignore` already covers `dist/` globally, skip creating the local one and drop it from `git add`.)

---

## Task 4: The showcase — end-to-end firm-issue → offline-verify

**Files:** modify `showcases/package.json`; create `showcases/src/recipe-attestation-verifier.recipe.test.ts`.

- [ ] **Step 1: Add the recipe package as a showcases devDependency**

In `showcases/package.json`, add to `devDependencies` (create the block if absent; keep alphabetical with siblings):
```json
    "@noy-db/recipe-attestation-verifier": "workspace:*"
```
Then `pnpm install` from repo root.

- [ ] **Step 2: Write the showcase `showcases/src/recipe-attestation-verifier.recipe.test.ts`**
```ts
/**
 * Recipe — Offline document-attestation verifier
 *
 * The firm issues a signed attestation (hub side); a third party verifies it
 * with NO hub, NO server, NO network — only @noy-db/attestation via the
 * recipe's shared verifyDocument(). Demonstrates the authentic / altered /
 * revoked paths and the firm-issue → offline-verify boundary.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { verifyDocument } from '@noy-db/recipe-attestation-verifier'
import {
  generateDocSigningKeyPair, computeFieldHashes, signPayloadCore, encodeQr,
  signRevocationList, bytesToB64url, type AttestationFieldSchema, type QrPayload,
} from '@noy-db/attestation'

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}

describe('recipe: offline attestation verifier', () => {
  it('firm issues via the hub; a third party verifies offline (authentic + altered)', async () => {
    const db = await createNoydb({ store: undefined as never, user: 'firm', secret: 'firm-pass-2026' })
    // ^ Use the in-memory store helper the other recipe tests use. If createNoydb
    //   requires a store, import { memoryStore } or the showcase's standard helper
    //   (grep an existing recipe test for the exact store bootstrap) and pass it.
    const vault = await db.openVault('books')
    const invoices = vault.collection<Invoice>('invoices', { attestation })
    await invoices.put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' })

    const { qr, keyId } = await vault.issueAttestation('invoices', 'inv-1')
    const { publicKeyB64 } = await vault.getDocumentSigningPublicKey()
    const config = { publicKeys: { [keyId]: publicKeyB64 }, fieldSchema: attestation }

    // verifier types what's printed (strings):
    const printed = { invoiceNo: 'INV-1042', total: '1234.50', issueDate: '2026-05-29' }
    expect((await verifyDocument(qr, printed, config)).outcome).toBe('authentic-valid')
    expect((await verifyDocument(qr, { ...printed, total: '9999.00' }, config)).outcome).toBe('altered')
  })

  it('a revoked document reads authentic-revoked (revocation needs the firm private key — pure keypair here)', async () => {
    // Signing a revocation list requires the firm's PRIVATE key, which the hub does
    // not expose (getDocumentSigningPublicKey returns only the public key). So this
    // case mints a pure keypair and signs both the QR and the list in-process.
    const k = await generateDocSigningKeyPair()
    const docId = '01J0000000000000000000RVK0'
    const record = { invoiceNo: 'INV-9', total: '50', issueDate: '2026-05-29' }
    const salt = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))
    const fieldHashes = await computeFieldHashes(salt, attestation, record)
    const sig = await signPayloadCore({ v: 1, docId, salt, keyId: k.keyId, fieldHashes }, k.privateKeyPkcs8B64)
    const qr = encodeQr({ v: 1, docId, salt, alg: 'ed25519', keyId: k.keyId, fieldHashes, sig } as QrPayload)
    const list = await signRevocationList([docId], '2026-05-29T00:00:00.000Z', k.keyId, k.privateKeyPkcs8B64)

    const v = await verifyDocument(qr, record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema: attestation, revocationList: list })
    expect(v.outcome).toBe('authentic-revoked')
  })
})
```
NOTE for the implementer: the `createNoydb({ store })` bootstrap must match how the OTHER recipe tests build an in-memory vault (grep `showcases/src/recipe-*.recipe.test.ts` for `createNoydb`). Use that exact store helper rather than the `undefined as never` placeholder above — the placeholder is a signpost, not final code. Everything else is final.

- [ ] **Step 3: Run the showcase**

Run: `cd showcases && npx vitest run src/recipe-attestation-verifier.recipe.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**
```bash
cd /Users/vicio/_github/noy-db
git add showcases/package.json pnpm-lock.yaml showcases/src/recipe-attestation-verifier.recipe.test.ts
git commit -m "test(showcase): recipe-attestation-verifier — firm-issue → offline-verify

Issues a real attestation through the hub, then verifies it with the recipe's
verifyDocument (pure, no hub): authentic-valid + altered. A second case uses a
pure keypair to demonstrate authentic-revoked (revocation-list signing needs
the firm private key the hub does not expose)."
```

---

## Task 5: Recipe doc + `features.yaml` + full verification

**Files:** create `docs/recipes/attestation-verifier.md`; modify `features.yaml`.

- [ ] **Step 1: Write `docs/recipes/attestation-verifier.md`**

Read an existing recipe doc first (`docs/recipes/personal-notebook.md`) and match its section shape. Content:
```markdown
# Offline document-attestation verifier

Verify that a printed or forwarded accounting document is **authentic and
unaltered — fully offline**, with no server holding or returning any document
content. The firm issues a signed, per-field commitment that travels inside a
QR on the document; a third party recomputes the commitment from what they can
read off the paper and checks the firm's Ed25519 signature against a built-in
public key.

## What it exercises
- `@noy-db/hub` issue side (`vault.issueAttestation`, `getDocumentSigningPublicKey`).
- `@noy-db/attestation` verify side (`decodeQr`, `verifyAttestation`, `verifyRevocationList`) — composed by the recipe's `verifyDocument()`.
- A self-contained static `verifier.html` (see `recipes/attestation-verifier/`) that runs the whole verdict client-side.

## Flow
1. **Issue (firm, hub):** declare an `attestation` field-schema on the collection, `vault.issueAttestation(collection, id)` → `{ docId, qr, keyId }`. Publish the public key (`getDocumentSigningPublicKey`).
2. **Render:** draw the QR (`qr`) on the document (see recipe ③, the KMS PDF Lambda — not required to verify).
3. **Verify (third party, offline):** open `verifier.html`, paste the QR, type the printed field values → `verifyDocument()` returns `authentic-valid` / `authentic-revoked` / `altered` / `signature-invalid` / `unknown-key` / `unreadable-qr`, localizing any differing field.

## Trust model
The verifier **bundles** the firm's public key(s) and the field schema at build time (most trustworthy — no fetch-time trust anchor; the QR's `keyId` selects the key so rotation does not break old documents). An optional bundled signed revocation list answers "still valid today?"; an untrusted list downgrades the wording but never flips a genuine authenticity pass.

See `showcases/src/recipe-attestation-verifier.recipe.test.ts` for the runnable end-to-end.
```

- [ ] **Step 2: Add the `recipes:` entry + cross-ref in `features.yaml`**

In the `recipes:` section, add (match sibling indentation exactly):
```yaml
  - id: attestation-verifier
    name: Offline document-attestation verifier
    doc: docs/recipes/attestation-verifier.md
    showcase_path: showcases/src/recipe-attestation-verifier.recipe.test.ts
    status: preview
    exercises:
      features: [attestation]
```
Then update the existing `attestation` feature row: change `recipes: []` to `recipes: [attestation-verifier]`.

- [ ] **Step 3: Validate features**

Run: `node scripts/validate-features.mjs 2>&1 | tail -8`
Expected: passes (recipes count +1). The `recipe-pair` check is satisfied (doc slug = showcase slug = id = `attestation-verifier`). Fix per any validator message.

- [ ] **Step 4: Full gate**
```bash
cd /Users/vicio/_github/noy-db
npx turbo run build typecheck --filter=@noy-db/recipe-attestation-verifier --filter=@noy-db/attestation 2>&1 | tail -20
npx vitest run --project attestation-verifier --reporter=dot 2>&1 | tail -6
cd showcases && npx vitest run src/recipe-attestation-verifier.recipe.test.ts --reporter=dot 2>&1 | tail -6
```
Expected: turbo green (the recipe builds `dist/verifier.html` + typechecks); the `attestation-verifier` vitest project passes (9 tests); the showcase passes (2 tests). If `turbo run lint` is part of the repo's standard gate and the recipe has no `lint` script, either add a `lint` script mirroring a sibling package or omit `lint` from the filter (do not fail the gate on a missing script).

- [ ] **Step 5: Commit**
```bash
cd /Users/vicio/_github/noy-db
git add docs/recipes/attestation-verifier.md features.yaml
git commit -m "docs(recipe): register attestation-verifier recipe + feature cross-ref

docs/recipes/attestation-verifier.md + features.yaml recipes entry (paired
doc/showcase) and the attestation feature row's recipes cross-ref."
```

---

## Self-Review (completed)

- **Spec coverage** (spec §1–§9): §1 deliverables → all tasks; §2 file structure → the File Structure table + Tasks 1–5; §3 verify-core algorithm → Task 1 Step 8 (uses `verifyAttestation`'s `revocation` param exactly as the spec's refined §3); §4 layout-A states/banners → Task 3 `app.ts`; §5 esbuild single-file build → Task 3 `build.mjs`; §6 testing (7 verify-core outcomes + build smoke + showcase two-key-source) → Tasks 1/3/4; §7 features.yaml → Task 5; §8 YAGNI (no camera/fetch/publishing/non-Ed25519) → respected; §9 build order → Task order.
- **Placeholder scan:** one deliberate signpost — Task 4 Step 2's `createNoydb({ store })` bootstrap, flagged for the implementer to copy the exact in-memory store helper from a sibling `recipe-*.recipe.test.ts` (the showcase store idiom varies; everything else is final code).
- **Type consistency:** `VerifierConfig`/`Verdict`/`VerifierOutcome` defined in Task 1 `verify-core.ts`, imported unchanged by `config.ts` (T2), `app.ts` (T3), and the showcase (T4 via the package's `.` export → `verify-core.ts`). `verifyDocument(qr, claimedFields, config)` signature identical across all call sites. `@noy-db/attestation` symbols (`decodeQr`/`verifyAttestation`/`verifyRevocationList`/`signRevocationList`/`computeFieldHashes`/`signPayloadCore`/`encodeQr`/`bytesToB64url`/`generateDocSigningKeyPair` + types `AttestationFieldSchema`/`QrPayload`/`RevocationList`) all confirmed exported from the merged package.
- **Known risks:** (1) the recipe's `exports` point at source `.ts` — valid under repo-wide `moduleResolution: bundler` (test-harnesses precedent); (2) `recipes/*` must be in BOTH `pnpm-workspace.yaml` and the root vitest `projects` (Task 1 Step 1) or the package won't link / its tests won't run; (3) the showcase runs under `showcases`' own vitest (happy-dom) + tsc, not the root `attestation-verifier` project.
