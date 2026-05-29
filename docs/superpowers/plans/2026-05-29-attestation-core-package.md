# @noy-db/attestation (pure core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@noy-db/attestation` — the pure, zero-runtime-dependency package that owns the document-attestation cryptographic + format contracts: canonical hashing, the closed normalizer set, per-field salted commitment, Ed25519 sign/verify, the QR payload codec, and the revocation format + check. Runs in Node and the browser with no vault.

**Architecture:** One new workspace package `packages/attestation/`, modeled on `packages/on-shamir/` (zero deps, dual ESM/CJS via tsup, vitest). All crypto uses WebCrypto globals (`globalThis.crypto.subtle`) — no native deps. The hub-side issue path (`@noy-db/hub/attestation`) is a **separate follow-up plan** that depends on this package; it is NOT in this plan.

**Tech Stack:** TypeScript, WebCrypto (SHA-256, Ed25519), Vitest, tsup, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-05-29-attestation-core-and-issue-design.md` (§3 is this package; §4 is the deferred hub plan). Umbrella: `docs/superpowers/specs/2026-05-29-document-attestation-umbrella-design.md`.

**Branch:** `docs/document-attestation-umbrella` (already checked out; both specs committed at `660ce05`/`c53c613`). Create work here or a fresh branch off it — confirm with `git rev-parse --abbrev-ref HEAD`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/attestation/package.json` | Package manifest (mirror on-shamir; zero deps) |
| `packages/attestation/tsup.config.ts` | Build config (copy on-shamir) |
| `packages/attestation/vitest.config.ts` | Test config (copy on-shamir, `name: 'attestation'`) |
| `packages/attestation/tsconfig.json` | TS config (copy on-shamir) |
| `packages/attestation/src/encoding.ts` | `canonicalJson`, `sha256Bytes`, `sha256Hex`, `bytesToHex`, `bytesToB64url`, `b64urlToBytes`, `utf8` |
| `packages/attestation/src/normalize.ts` | `Normalizer` type, `normalizeField`, `validateFieldSchema`, `getPath` |
| `packages/attestation/src/hashing.ts` | `computeFieldHashes` |
| `packages/attestation/src/ed25519.ts` | `generateDocSigningKeyPair`, `ed25519Sign`, `ed25519Verify` |
| `packages/attestation/src/qr.ts` | `QrPayload`, `encodeQr`, `decodeQr` |
| `packages/attestation/src/verify.ts` | `signPayloadCore`, `verifyAttestation`, types `VerifyInput`/`VerifyResult` |
| `packages/attestation/src/revocation.ts` | `RevocationList`, `isRevoked`, `verifyRevocationList` |
| `packages/attestation/src/types.ts` | `AttestationFieldSpec`, `AttestationFieldSchema` |
| `packages/attestation/src/index.ts` | Barrel re-export of the public API |
| `packages/attestation/__tests__/*.test.ts` | One test file per src module |

---

## Task 1: Package scaffold + encoding primitives

**Files:**
- Create: `packages/attestation/package.json`, `tsup.config.ts`, `vitest.config.ts`, `tsconfig.json`
- Create: `packages/attestation/src/encoding.ts`
- Test: `packages/attestation/__tests__/encoding.test.ts`

- [ ] **Step 1: Scaffold the package files**

`packages/attestation/package.json`:
```json
{
  "name": "@noy-db/attestation",
  "version": "0.2.0-pre.1",
  "description": "Pure, zero-dependency document-attestation primitive for noy-db — per-field salted commitments, Ed25519 sign/verify, QR credential codec, and revocation checks. Runs in Node and the browser; the offline verifier imports only this.",
  "license": "MIT",
  "author": "vLannaAi <vicio@lanna.ai>",
  "homepage": "https://github.com/vLannaAi/noy-db/tree/main/packages/attestation#readme",
  "repository": { "type": "git", "url": "git+https://github.com/vLannaAi/noy-db.git", "directory": "packages/attestation" },
  "bugs": { "url": "https://github.com/vLannaAi/noy-db/issues" },
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=18.0.0" },
  "scripts": { "build": "tsup", "test": "vitest run", "lint": "eslint src/", "typecheck": "tsc --noEmit" },
  "keywords": ["noy-db", "attestation", "document", "commitment", "ed25519", "verification", "qr", "tamper-evident"],
  "publishConfig": { "access": "public", "tag": "latest" }
}
```

`packages/attestation/tsup.config.ts` (identical to on-shamir):
```ts
import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
})
```

`packages/attestation/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { name: 'attestation', include: ['__tests__/**/*.test.ts'], environment: 'node' },
})
```

`packages/attestation/tsconfig.json` — copy `packages/on-shamir/tsconfig.json` verbatim (read it first with `cat packages/on-shamir/tsconfig.json` and replicate).

Copy `packages/on-shamir/LICENSE` to `packages/attestation/LICENSE`. Create a minimal `packages/attestation/README.md` with the package description (one paragraph from package.json).

- [ ] **Step 2: Write the failing test**

`packages/attestation/__tests__/encoding.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { canonicalJson, sha256Hex, sha256Bytes, bytesToHex, bytesToB64url, b64urlToBytes, utf8 } from '../src/encoding.js'

describe('canonicalJson', () => {
  it('sorts object keys and is deterministic regardless of literal order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}')
  })
  it('encodes arrays in order and nests', () => {
    expect(canonicalJson([1, 'x', { z: true }])).toBe('[1,"x",{"z":true}]')
  })
  it('matches a fixed conformance vector (shared contract with the ledger)', () => {
    expect(canonicalJson(['s4lt', 'total', '123450'])).toBe('["s4lt","total","123450"]')
  })
  it('throws on non-finite numbers and undefined', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/)
    expect(() => canonicalJson(undefined)).toThrow(/undefined/)
  })
})

describe('sha256', () => {
  it('sha256Hex matches a known vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
  it('sha256Hex matches a known vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('sha256Bytes returns 32 bytes', async () => {
    expect((await sha256Bytes('abc')).length).toBe(32)
  })
})

describe('hex + base64url round-trips', () => {
  it('bytesToHex of a known buffer', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 254, 255]))).toBe('0001feff')
  })
  it('base64url round-trips arbitrary bytes and is url-safe (no +,/,=)', () => {
    const b = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const enc = bytesToB64url(b)
    expect(enc).not.toMatch(/[+/=]/)
    expect([...b64urlToBytes(enc)]).toEqual([...b])
  })
  it('utf8 encodes to bytes', () => {
    expect([...utf8('A')]).toEqual([65])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/attestation && npx vitest run __tests__/encoding.test.ts`
Expected: FAIL — `Cannot find module '../src/encoding.js'`.

- [ ] **Step 4: Implement `src/encoding.ts`**

```ts
/**
 * Pure encoding + hashing primitives. Zero deps; WebCrypto only.
 *
 * `canonicalJson` and `sha256Hex` are intentionally byte-identical to
 * hub's `history/ledger/entry.ts` implementations. They are REPLICATED
 * here (not imported) because this package is upstream of hub — importing
 * from hub would invert the dependency. The conformance test pins the
 * shared contract via fixed vectors.
 */

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function bytesToB64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: refusing to encode non-finite number ${String(value)}`)
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') throw new Error('canonicalJson: BigInt is not JSON-serializable')
  if (typeof value === 'undefined' || typeof value === 'function') {
    throw new Error(`canonicalJson: refusing to encode ${typeof value} — include all fields explicitly`)
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const key of keys) parts.push(JSON.stringify(key) + ':' + canonicalJson(obj[key]))
    return '{' + parts.join(',') + '}'
  }
  throw new Error(`canonicalJson: unexpected value type: ${typeof value}`)
}

export async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8(input))
  return new Uint8Array(digest)
}

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await sha256Bytes(input))
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/attestation && pnpm install && npx vitest run __tests__/encoding.test.ts`
Expected: PASS (all encoding tests). `pnpm install` registers the new workspace package.

- [ ] **Step 6: Commit**

```bash
git add packages/attestation/
git commit -m "feat(attestation): scaffold @noy-db/attestation + encoding primitives

New zero-dependency package (on-shamir template). canonicalJson +
sha256 replicated hub-free with fixed-vector conformance tests; hex +
base64url codecs."
```

---

## Task 2: Normalizers + field-schema validation + path resolver

**Files:**
- Create: `packages/attestation/src/types.ts`, `packages/attestation/src/normalize.ts`
- Test: `packages/attestation/__tests__/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/attestation/__tests__/normalize.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { normalizeField, validateFieldSchema, getPath } from '../src/normalize.js'

describe('normalizeField', () => {
  it('trim / lower / upper', () => {
    expect(normalizeField('  Hi ', 'trim')).toBe('Hi')
    expect(normalizeField(' Hi ', 'lower')).toBe('hi')
    expect(normalizeField(' Hi ', 'upper')).toBe('HI')
  })
  it('alnum-upper strips punctuation and uppercases', () => {
    expect(normalizeField('gb-12 34.56', 'alnum-upper')).toBe('GB123456')
  })
  it('digits keeps only digits', () => {
    expect(normalizeField('+1 (415) 555', 'digits')).toBe('1415555')
  })
  it('cents converts money to integer-cents string', () => {
    expect(normalizeField(1234.5, 'cents')).toBe('123450')
    expect(normalizeField('19.99', 'cents')).toBe('1999')
    expect(normalizeField(0, 'cents')).toBe('0')
  })
  it('cents throws on non-numeric', () => {
    expect(() => normalizeField('abc', 'cents')).toThrow(/cents/)
  })
  it('iso-date normalizes Date and ISO string to YYYY-MM-DD', () => {
    expect(normalizeField('2026-05-29T10:00:00Z', 'iso-date')).toBe('2026-05-29')
    expect(normalizeField(new Date('2026-05-29T23:59:59Z'), 'iso-date')).toBe('2026-05-29')
  })
  it('iso-date throws on unparseable', () => {
    expect(() => normalizeField('not-a-date', 'iso-date')).toThrow(/iso-date/)
  })
})

describe('validateFieldSchema', () => {
  it('accepts a valid schema', () => {
    expect(() => validateFieldSchema({ fields: [{ path: 'total', normalize: 'cents' }] })).not.toThrow()
  })
  it('rejects an unknown normalizer', () => {
    // @ts-expect-error testing runtime guard
    expect(() => validateFieldSchema({ fields: [{ path: 'x', normalize: 'bogus' }] })).toThrow(/normalizer/)
  })
  it('rejects empty fields and duplicate paths', () => {
    expect(() => validateFieldSchema({ fields: [] })).toThrow(/at least one/)
    expect(() => validateFieldSchema({ fields: [{ path: 'a', normalize: 'trim' }, { path: 'a', normalize: 'upper' }] })).toThrow(/duplicate/)
  })
})

describe('getPath', () => {
  it('resolves dot paths', () => {
    expect(getPath({ a: { b: 7 } }, 'a.b')).toBe(7)
    expect(getPath({ total: 5 }, 'total')).toBe(5)
  })
  it('returns undefined for a missing path', () => {
    expect(getPath({ a: {} }, 'a.b.c')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/attestation && npx vitest run __tests__/normalize.test.ts`
Expected: FAIL — `Cannot find module '../src/normalize.js'`.

- [ ] **Step 3: Implement `src/types.ts` then `src/normalize.ts`**

`packages/attestation/src/types.ts`:
```ts
export type Normalizer = 'trim' | 'lower' | 'upper' | 'alnum-upper' | 'digits' | 'cents' | 'iso-date'

export interface AttestationFieldSpec {
  readonly path: string
  readonly normalize: Normalizer
}
export interface AttestationFieldSchema {
  readonly fields: readonly AttestationFieldSpec[]
}
```

`packages/attestation/src/normalize.ts`:
```ts
import type { AttestationFieldSchema, Normalizer } from './types.js'

const NORMALIZERS: ReadonlySet<string> = new Set<Normalizer>([
  'trim', 'lower', 'upper', 'alnum-upper', 'digits', 'cents', 'iso-date',
])

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj)
}

export function normalizeField(value: unknown, n: Normalizer): string {
  switch (n) {
    case 'trim': return String(value).trim()
    case 'lower': return String(value).trim().toLowerCase()
    case 'upper': return String(value).trim().toUpperCase()
    case 'alnum-upper': return String(value).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    case 'digits': return String(value).replace(/[^0-9]/g, '')
    case 'cents': {
      const num = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.\-]/g, ''))
      if (!Number.isFinite(num)) throw new Error(`normalizeField(cents): not a finite number: ${String(value)}`)
      return String(Math.round(num * 100))
    }
    case 'iso-date': {
      const d = value instanceof Date ? value : new Date(String(value))
      if (Number.isNaN(d.getTime())) throw new Error(`normalizeField(iso-date): unparseable date: ${String(value)}`)
      return d.toISOString().slice(0, 10)
    }
    default: {
      const exhaustive: never = n
      throw new Error(`normalizeField: unknown normalizer ${String(exhaustive)}`)
    }
  }
}

export function validateFieldSchema(schema: AttestationFieldSchema): void {
  if (!schema.fields || schema.fields.length === 0) {
    throw new Error('validateFieldSchema: schema must declare at least one field')
  }
  const seen = new Set<string>()
  for (const f of schema.fields) {
    if (!NORMALIZERS.has(f.normalize)) {
      throw new Error(`validateFieldSchema: unknown normalizer '${String(f.normalize)}' for path '${f.path}'`)
    }
    if (seen.has(f.path)) throw new Error(`validateFieldSchema: duplicate path '${f.path}'`)
    seen.add(f.path)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/attestation && npx vitest run __tests__/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attestation/src/types.ts packages/attestation/src/normalize.ts packages/attestation/__tests__/normalize.test.ts
git commit -m "feat(attestation): closed normalizer set + field-schema validation + dot-path resolver"
```

---

## Task 3: Per-field salted hashing

**Files:**
- Create: `packages/attestation/src/hashing.ts`
- Test: `packages/attestation/__tests__/hashing.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/attestation/__tests__/hashing.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { computeFieldHashes } from '../src/hashing.js'
import type { AttestationFieldSchema } from '../src/types.js'

const schema: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
  ],
}
const salt = 'c2FsdHNhbHRzYWx0c2Fs' // base64url, arbitrary

describe('computeFieldHashes', () => {
  it('returns one base64url hash per field, in schema order', async () => {
    const h = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 12.34 })
    expect(h).toHaveLength(2)
    for (const x of h) expect(x).not.toMatch(/[+/=]/)
  })
  it('is deterministic for the same salt+schema+values', async () => {
    const a = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 12.34 })
    const b = await computeFieldHashes(salt, schema, { invoiceNo: 'inv 1', total: '12.34' })
    expect(a).toEqual(b) // normalization makes these equal
  })
  it('changes when a field value changes', async () => {
    const a = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 12.34 })
    const b = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 99.99 })
    expect(a[0]).toBe(b[0])
    expect(a[1]).not.toBe(b[1])
  })
  it('changes when the salt changes', async () => {
    const a = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 12.34 })
    const b = await computeFieldHashes('ZGlmZmVyZW50c2FsdGRpZmY', schema, { invoiceNo: 'INV-1', total: 12.34 })
    expect(a[0]).not.toBe(b[0])
  })
  it('domain-separates fields with equal values (path is in the hash input)', async () => {
    const s2: AttestationFieldSchema = { fields: [{ path: 'a', normalize: 'trim' }, { path: 'b', normalize: 'trim' }] }
    const h = await computeFieldHashes(salt, s2, { a: 'same', b: 'same' })
    expect(h[0]).not.toBe(h[1])
  })
  it('throws when a declared field is missing from the record', async () => {
    await expect(computeFieldHashes(salt, schema, { invoiceNo: 'INV-1' })).rejects.toThrow(/missing/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/attestation && npx vitest run __tests__/hashing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/hashing.ts`**

```ts
import type { AttestationFieldSchema } from './types.js'
import { canonicalJson, sha256Bytes, bytesToB64url } from './encoding.js'
import { getPath, normalizeField } from './normalize.js'

/**
 * One salted, domain-separated hash per declared field, in schema order:
 *   fieldHash[i] = base64url( sha256( canonicalJson([salt, path, normalizedValue]) ) )
 * Per-document salt defeats brute-force of low-entropy fields and cross-
 * document correlation; the path in the input domain-separates fields
 * that happen to share a value.
 */
export async function computeFieldHashes(
  saltB64: string,
  schema: AttestationFieldSchema,
  values: Record<string, unknown>,
): Promise<string[]> {
  const out: string[] = []
  for (const f of schema.fields) {
    const raw = getPath(values, f.path)
    if (raw === undefined || raw === null) {
      throw new Error(`computeFieldHashes: missing value at declared path '${f.path}'`)
    }
    const norm = normalizeField(raw, f.normalize)
    const digest = await sha256Bytes(canonicalJson([saltB64, f.path, norm]))
    out.push(bytesToB64url(digest))
  }
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/attestation && npx vitest run __tests__/hashing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attestation/src/hashing.ts packages/attestation/__tests__/hashing.test.ts
git commit -m "feat(attestation): per-field salted, domain-separated commitment hashing"
```

---

## Task 4: Ed25519 keygen / sign / verify

**Files:**
- Create: `packages/attestation/src/ed25519.ts`
- Test: `packages/attestation/__tests__/ed25519.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/attestation/__tests__/ed25519.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { generateDocSigningKeyPair, ed25519Sign, ed25519Verify } from '../src/ed25519.js'
import { utf8 } from '../src/encoding.js'

describe('Ed25519', () => {
  it('generates a keypair with a stable 16-char keyId and base64url keys', async () => {
    const kp = await generateDocSigningKeyPair()
    expect(kp.keyId).toHaveLength(16)
    expect(kp.publicKeyB64).not.toMatch(/[+/=]/)
    expect(kp.privateKeyPkcs8B64).not.toMatch(/[+/=]/)
  })
  it('sign → verify round-trips', async () => {
    const kp = await generateDocSigningKeyPair()
    const msg = utf8('hello document')
    const sig = await ed25519Sign(kp.privateKeyPkcs8B64, msg)
    expect(sig).not.toMatch(/[+/=]/)
    expect(await ed25519Verify(kp.publicKeyB64, sig, msg)).toBe(true)
  })
  it('verify fails for a different message', async () => {
    const kp = await generateDocSigningKeyPair()
    const sig = await ed25519Sign(kp.privateKeyPkcs8B64, utf8('original'))
    expect(await ed25519Verify(kp.publicKeyB64, sig, utf8('tampered'))).toBe(false)
  })
  it('verify fails for a different key', async () => {
    const a = await generateDocSigningKeyPair()
    const b = await generateDocSigningKeyPair()
    const sig = await ed25519Sign(a.privateKeyPkcs8B64, utf8('m'))
    expect(await ed25519Verify(b.publicKeyB64, sig, utf8('m'))).toBe(false)
  })
  it('the same public key yields the same keyId', async () => {
    const kp = await generateDocSigningKeyPair()
    const { keyIdFor } = await import('../src/ed25519.js')
    expect(await keyIdFor(kp.publicKeyB64)).toBe(kp.keyId)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/attestation && npx vitest run __tests__/ed25519.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/ed25519.ts`**

```ts
import { bytesToB64url, b64urlToBytes, sha256Hex } from './encoding.js'

const ALG = 'Ed25519'

/** Stable key identifier: first 16 hex chars of sha256(publicKeyB64). */
export async function keyIdFor(publicKeyB64: string): Promise<string> {
  return (await sha256Hex(publicKeyB64)).slice(0, 16)
}

export async function generateDocSigningKeyPair(): Promise<{
  keyId: string
  publicKeyB64: string        // base64url raw (32 bytes) — non-secret, publishable
  privateKeyPkcs8B64: string  // base64url pkcs8 — secret, wrap before persisting
}> {
  const kp = (await globalThis.crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair
  const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey))
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', kp.privateKey))
  const publicKeyB64 = bytesToB64url(rawPub)
  return { keyId: await keyIdFor(publicKeyB64), publicKeyB64, privateKeyPkcs8B64: bytesToB64url(pkcs8) }
}

export async function ed25519Sign(privateKeyPkcs8B64: string, message: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('pkcs8', b64urlToBytes(privateKeyPkcs8B64), ALG, false, ['sign'])
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign(ALG, key, message))
  return bytesToB64url(sig)
}

export async function ed25519Verify(publicKeyB64: string, sigB64url: string, message: Uint8Array): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', b64urlToBytes(publicKeyB64), ALG, false, ['verify'])
    return await globalThis.crypto.subtle.verify(ALG, key, b64urlToBytes(sigB64url), message)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/attestation && npx vitest run __tests__/ed25519.test.ts`
Expected: PASS. If `exportKey('raw', publicKey)` throws on this runtime (older WebCrypto), fall back to `'spki'` export for the public key and `importKey('spki', ...)` in verify — adjust both sites together and note it in the commit. (Node 20 supports `'raw'` for Ed25519 public keys.)

- [ ] **Step 5: Commit**

```bash
git add packages/attestation/src/ed25519.ts packages/attestation/__tests__/ed25519.test.ts
git commit -m "feat(attestation): Ed25519 keygen/sign/verify via WebCrypto + stable keyId"
```

---

## Task 5: QR payload codec

**Files:**
- Create: `packages/attestation/src/qr.ts`
- Test: `packages/attestation/__tests__/qr.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/attestation/__tests__/qr.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { encodeQr, decodeQr } from '../src/qr.js'
import type { QrPayload } from '../src/qr.js'

const payload: QrPayload = {
  v: 1, docId: '01J0ABCDEF', salt: 'c2FsdA', alg: 'ed25519', keyId: 'abcdef0123456789',
  fieldHashes: ['aaa', 'bbb'], sig: 'c2ln',
}

describe('QR codec', () => {
  it('encode → decode round-trips', () => {
    expect(decodeQr(encodeQr(payload))).toEqual(payload)
  })
  it('encoded string is url-safe', () => {
    expect(encodeQr(payload)).not.toMatch(/[+/=]/)
  })
  it('rejects a non-v1 payload on decode', () => {
    const bad = encodeQr({ ...payload, v: 2 as unknown as 1 })
    expect(() => decodeQr(bad)).toThrow(/version/)
  })
  it('rejects structurally invalid payloads', () => {
    expect(() => decodeQr('not-base64url!!!')).toThrow()
    const missing = encodeQr({ ...payload, sig: undefined as unknown as string })
    expect(() => decodeQr(missing)).toThrow(/sig|invalid/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/attestation && npx vitest run __tests__/qr.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/qr.ts`**

```ts
import { bytesToB64url, b64urlToBytes, utf8 } from './encoding.js'

export interface QrPayload {
  readonly v: 1
  readonly docId: string
  readonly salt: string
  readonly alg: 'ed25519'
  readonly keyId: string
  readonly fieldHashes: readonly string[]
  readonly sig: string
}

/** Compact JSON → base64url. (CBOR + base45 density optimisation deferred.) */
export function encodeQr(p: QrPayload): string {
  return bytesToB64url(utf8(JSON.stringify(p)))
}

export function decodeQr(s: string): QrPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(s)))
  } catch {
    throw new Error('decodeQr: not a valid base64url-encoded JSON payload')
  }
  const p = parsed as Record<string, unknown>
  if (p['v'] !== 1) throw new Error(`decodeQr: unsupported version ${String(p['v'])} (expected 1)`)
  if (typeof p['docId'] !== 'string' || typeof p['salt'] !== 'string' || p['alg'] !== 'ed25519'
      || typeof p['keyId'] !== 'string' || typeof p['sig'] !== 'string'
      || !Array.isArray(p['fieldHashes']) || !p['fieldHashes'].every((h) => typeof h === 'string')) {
    throw new Error('decodeQr: invalid payload shape')
  }
  return {
    v: 1, docId: p['docId'], salt: p['salt'], alg: 'ed25519',
    keyId: p['keyId'], fieldHashes: p['fieldHashes'] as string[], sig: p['sig'],
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/attestation && npx vitest run __tests__/qr.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attestation/src/qr.ts packages/attestation/__tests__/qr.test.ts
git commit -m "feat(attestation): QR payload codec (compact-JSON → base64url) with structural validation"
```

---

## Task 6: signPayloadCore + verifyAttestation

**Files:**
- Create: `packages/attestation/src/verify.ts`
- Test: `packages/attestation/__tests__/verify.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/attestation/__tests__/verify.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { signPayloadCore, verifyAttestation } from '../src/verify.js'
import { computeFieldHashes } from '../src/hashing.js'
import { generateDocSigningKeyPair } from '../src/ed25519.js'
import { encodeQr } from '../src/qr.js'
import type { QrPayload } from '../src/qr.js'
import type { AttestationFieldSchema } from '../src/types.js'

const schema: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}
const fields = { invoiceNo: 'INV-1001', total: 1234.5, issueDate: '2026-05-29' }

async function issue() {
  const kp = await generateDocSigningKeyPair()
  const salt = 'c2FsdHNhbHRzYWx0c2Fs'
  const docId = '01J0DOC0001'
  const fieldHashes = await computeFieldHashes(salt, schema, fields)
  const sig = await signPayloadCore({ v: 1, docId, salt, keyId: kp.keyId, fieldHashes }, kp.privateKeyPkcs8B64)
  const payload: QrPayload = { v: 1, docId, salt, alg: 'ed25519', keyId: kp.keyId, fieldHashes, sig }
  return { kp, payload, qr: encodeQr(payload), salt, docId }
}

describe('verifyAttestation', () => {
  it('valid: matching fields + correct key → valid', async () => {
    const { kp, qr } = await issue()
    const r = await verifyAttestation({ qr, claimedFields: fields, fieldSchema: schema, publicKeys: { [kp.keyId]: kp.publicKeyB64 } })
    expect(r.valid).toBe(true)
    expect(r.signatureValid).toBe(true)
    expect(r.perField.every((f) => f.match)).toBe(true)
    expect(r.revoked).toBeNull()
  })
  it('localizes a single altered field', async () => {
    const { kp, qr } = await issue()
    const r = await verifyAttestation({ qr, claimedFields: { ...fields, total: 9999.0 }, fieldSchema: schema, publicKeys: { [kp.keyId]: kp.publicKeyB64 } })
    expect(r.valid).toBe(false)
    expect(r.signatureValid).toBe(true)
    expect(r.perField.find((f) => f.path === 'total')!.match).toBe(false)
    expect(r.perField.find((f) => f.path === 'invoiceNo')!.match).toBe(true)
    expect(r.reason).toMatch(/field/)
  })
  it('forged QR (attacker key not in publicKeys) → signatureValid false', async () => {
    const { qr } = await issue()
    const attacker = await generateDocSigningKeyPair()
    const r = await verifyAttestation({ qr, claimedFields: fields, fieldSchema: schema, publicKeys: { [attacker.keyId]: attacker.publicKeyB64 } })
    expect(r.signatureValid).toBe(false)
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/keyId/)
  })
  it('schema/payload field-count mismatch → invalid', async () => {
    const { kp, qr } = await issue()
    const shortSchema: AttestationFieldSchema = { fields: [{ path: 'invoiceNo', normalize: 'alnum-upper' }] }
    const r = await verifyAttestation({ qr, claimedFields: fields, fieldSchema: shortSchema, publicKeys: { [kp.keyId]: kp.publicKeyB64 } })
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/count/)
  })
  it('revoked docId → valid false, revoked true', async () => {
    const { kp, qr, docId } = await issue()
    const r = await verifyAttestation({
      qr, claimedFields: fields, fieldSchema: schema, publicKeys: { [kp.keyId]: kp.publicKeyB64 },
      revocation: { list: { v: 1, revokedDocIds: [docId], asOf: '2026-06-01T00:00:00Z', keyId: kp.keyId, sig: 'x' } },
    })
    expect(r.revoked).toBe(true)
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/revoked/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/attestation && npx vitest run __tests__/verify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/verify.ts`**

```ts
import type { AttestationFieldSchema } from './types.js'
import type { QrPayload } from './qr.js'
import type { RevocationList } from './revocation.js'
import { canonicalJson, utf8 } from './encoding.js'
import { ed25519Sign, ed25519Verify } from './ed25519.js'
import { computeFieldHashes } from './hashing.js'
import { decodeQr } from './qr.js'
import { isRevoked } from './revocation.js'

export interface VerifyInput {
  readonly qr: string
  readonly claimedFields: Record<string, unknown>
  readonly fieldSchema: AttestationFieldSchema
  readonly publicKeys: Readonly<Record<string, string>>
  readonly revocation?: { list: RevocationList }
}
export interface VerifyResult {
  readonly valid: boolean
  readonly signatureValid: boolean
  readonly perField: ReadonlyArray<{ path: string; match: boolean }>
  readonly revoked: boolean | null
  readonly reason?: string
}

/** The bytes the signature covers: canonicalJson of the payload minus `alg`/`sig`. */
function signedCore(core: { v: 1; docId: string; salt: string; keyId: string; fieldHashes: readonly string[] }): Uint8Array {
  return utf8(canonicalJson({ v: core.v, docId: core.docId, salt: core.salt, keyId: core.keyId, fieldHashes: core.fieldHashes }))
}

export async function signPayloadCore(
  core: { v: 1; docId: string; salt: string; keyId: string; fieldHashes: readonly string[] },
  privateKeyPkcs8B64: string,
): Promise<string> {
  return ed25519Sign(privateKeyPkcs8B64, signedCore(core))
}

export async function verifyAttestation(input: VerifyInput): Promise<VerifyResult> {
  const p: QrPayload = decodeQr(input.qr)
  const pub = input.publicKeys[p.keyId]
  const signatureValid = pub
    ? await ed25519Verify(pub, p.sig, signedCore({ v: p.v, docId: p.docId, salt: p.salt, keyId: p.keyId, fieldHashes: p.fieldHashes }))
    : false

  const schema = input.fieldSchema
  const perField: Array<{ path: string; match: boolean }> = []
  let allMatch = true
  let countMismatch = false
  if (schema.fields.length !== p.fieldHashes.length) {
    countMismatch = true
    allMatch = false
    for (const f of schema.fields) perField.push({ path: f.path, match: false })
  } else {
    const recomputed = await computeFieldHashes(p.salt, schema, input.claimedFields)
    for (let i = 0; i < schema.fields.length; i++) {
      const match = recomputed[i] === p.fieldHashes[i]
      perField.push({ path: schema.fields[i]!.path, match })
      if (!match) allMatch = false
    }
  }

  const revoked = input.revocation ? isRevoked(p.docId, input.revocation.list) : null
  const valid = signatureValid && allMatch && revoked !== true

  let reason: string | undefined
  if (!signatureValid) reason = pub ? 'signature invalid' : 'unknown keyId'
  else if (countMismatch) reason = 'schema/payload field-count mismatch'
  else if (!allMatch) reason = 'field mismatch'
  else if (revoked === true) reason = 'revoked'

  return { valid, signatureValid, perField, revoked, reason }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/attestation && npx vitest run __tests__/verify.test.ts`
Expected: PASS. (`revocation.ts` is created in Task 7; the import will fail until then. To keep this task green standalone, create a minimal `src/revocation.ts` stub now exporting `RevocationList` + `isRevoked` — Task 7 adds `verifyRevocationList` + its tests. If you prefer strict ordering, do Task 7 before Task 6's Step 4.)

- [ ] **Step 5: Commit**

```bash
git add packages/attestation/src/verify.ts packages/attestation/__tests__/verify.test.ts
git commit -m "feat(attestation): signPayloadCore + verifyAttestation (per-field localization, forgery + revocation gates)"
```

---

## Task 7: Revocation format + check

**Files:**
- Create (or complete the stub from Task 6): `packages/attestation/src/revocation.ts`
- Test: `packages/attestation/__tests__/revocation.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/attestation/__tests__/revocation.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { isRevoked, verifyRevocationList, signRevocationList } from '../src/revocation.js'
import { generateDocSigningKeyPair } from '../src/ed25519.js'

describe('revocation', () => {
  it('isRevoked checks membership', () => {
    const list = { v: 1 as const, revokedDocIds: ['a', 'b'], asOf: '2026-06-01T00:00:00Z', keyId: 'k', sig: 'x' }
    expect(isRevoked('a', list)).toBe(true)
    expect(isRevoked('z', list)).toBe(false)
  })
  it('signRevocationList → verifyRevocationList round-trips', async () => {
    const kp = await generateDocSigningKeyPair()
    const list = await signRevocationList(['01J0DOC0001', '01J0DOC0002'], '2026-06-01T00:00:00Z', kp.keyId, kp.privateKeyPkcs8B64)
    expect(await verifyRevocationList(list, kp.publicKeyB64)).toBe(true)
  })
  it('verifyRevocationList fails on tamper', async () => {
    const kp = await generateDocSigningKeyPair()
    const list = await signRevocationList(['01J0DOC0001'], '2026-06-01T00:00:00Z', kp.keyId, kp.privateKeyPkcs8B64)
    const tampered = { ...list, revokedDocIds: [...list.revokedDocIds, '01J0EVIL'] }
    expect(await verifyRevocationList(tampered, kp.publicKeyB64)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/attestation && npx vitest run __tests__/revocation.test.ts`
Expected: FAIL — `signRevocationList`/`verifyRevocationList` not exported (or module missing).

- [ ] **Step 3: Implement `src/revocation.ts`**

```ts
import { canonicalJson, utf8 } from './encoding.js'
import { ed25519Sign, ed25519Verify } from './ed25519.js'

export interface RevocationList {
  readonly v: 1
  readonly revokedDocIds: readonly string[]
  readonly asOf: string
  readonly keyId: string
  readonly sig: string
}

function listCore(revokedDocIds: readonly string[], asOf: string, keyId: string): Uint8Array {
  return utf8(canonicalJson({ v: 1, revokedDocIds: [...revokedDocIds].sort(), asOf, keyId }))
}

export function isRevoked(docId: string, list: RevocationList): boolean {
  return list.revokedDocIds.includes(docId)
}

export async function signRevocationList(
  revokedDocIds: readonly string[], asOf: string, keyId: string, privateKeyPkcs8B64: string,
): Promise<RevocationList> {
  const sorted = [...revokedDocIds].sort()
  const sig = await ed25519Sign(privateKeyPkcs8B64, listCore(sorted, asOf, keyId))
  return { v: 1, revokedDocIds: sorted, asOf, keyId, sig }
}

export async function verifyRevocationList(list: RevocationList, publicKeyB64: string): Promise<boolean> {
  if (list.v !== 1) return false
  return ed25519Verify(publicKeyB64, list.sig, listCore(list.revokedDocIds, list.asOf, list.keyId))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/attestation && npx vitest run __tests__/revocation.test.ts && npx vitest run`
Expected: PASS for revocation, and the full package suite green (verify.test.ts now resolves its `revocation.js` import against the real module).

- [ ] **Step 5: Commit**

```bash
git add packages/attestation/src/revocation.ts packages/attestation/__tests__/revocation.test.ts
git commit -m "feat(attestation): signed revocation list — format, isRevoked, sign/verify"
```

---

## Task 8: Barrel exports + integration (build, lint, typecheck, workspace, features)

**Files:**
- Create: `packages/attestation/src/index.ts`
- Modify: `features.yaml` (only if the validator requires it)

- [ ] **Step 1: Write the failing test**

`packages/attestation/__tests__/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import * as api from '../src/index.js'

describe('public API surface', () => {
  it('exports the documented functions', () => {
    for (const name of [
      'canonicalJson', 'sha256Hex', 'normalizeField', 'validateFieldSchema',
      'computeFieldHashes', 'generateDocSigningKeyPair', 'encodeQr', 'decodeQr',
      'signPayloadCore', 'verifyAttestation', 'isRevoked', 'verifyRevocationList', 'signRevocationList',
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/attestation && npx vitest run __tests__/index.test.ts`
Expected: FAIL — `../src/index.js` not found.

- [ ] **Step 3: Implement `src/index.ts`**

```ts
/**
 * @noy-db/attestation — pure document-attestation primitive.
 * @packageDocumentation
 */
export type { Normalizer, AttestationFieldSpec, AttestationFieldSchema } from './types.js'
export type { QrPayload } from './qr.js'
export type { RevocationList } from './revocation.js'
export type { VerifyInput, VerifyResult } from './verify.js'

export { canonicalJson, sha256Hex, sha256Bytes, bytesToHex, bytesToB64url, b64urlToBytes, utf8 } from './encoding.js'
export { normalizeField, validateFieldSchema, getPath } from './normalize.js'
export { computeFieldHashes } from './hashing.js'
export { generateDocSigningKeyPair, ed25519Sign, ed25519Verify, keyIdFor } from './ed25519.js'
export { encodeQr, decodeQr } from './qr.js'
export { signPayloadCore, verifyAttestation } from './verify.js'
export { isRevoked, verifyRevocationList, signRevocationList } from './revocation.js'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/attestation && npx vitest run`
Expected: PASS — all test files green.

- [ ] **Step 5: Build + lint + typecheck the package**

Run (from repo root):
```bash
npx turbo run build lint typecheck --filter=@noy-db/attestation
```
Expected: build emits `dist/index.{js,cjs,d.ts,d.cts}`; lint + typecheck clean. Fix any issues (e.g. eslint config inclusion for the new package — mirror on-shamir's setup if the package isn't picked up).

- [ ] **Step 6: Spec-coverage / features registry**

Run:
```bash
node scripts/validate-features.mjs 2>&1 | tail -10
```
If it passes with the new package present, no edit needed (this package has no user-facing hub feature row yet — that lands with the ①b hub plan). If it reports the new package as an unregistered/dangling artifact, add the minimal registration it asks for (likely an `exports`/package entry; mirror how `on-shamir` appears, if at all). Do NOT invent a hub `attestation` feature row here — the subsystem doesn't exist until ①b.

- [ ] **Step 7: Full-suite smoke + commit**

Run:
```bash
npx vitest run --reporter=dot --project attestation
```
Expected: all attestation tests pass.

```bash
git add packages/attestation/src/index.ts packages/attestation/__tests__/index.test.ts features.yaml
git commit -m "feat(attestation): public API barrel + workspace/build integration

@noy-db/attestation builds (ESM+CJS), lints, typechecks, and ships the
full pure primitive: commitment, normalizers, per-field hashing, Ed25519
sign/verify, QR codec, signed revocation list. Ready for the hub issue
side (@noy-db/hub/attestation) to depend on."
```

---

## Self-Review (completed)

- **Spec coverage** (sub-spec §3): canonicalJson/sha256 (T1) ✓; normalizers + validateFieldSchema (T2) ✓; per-field salted hashing §3.2 (T3) ✓; Ed25519 + keyId §3.5 (T4) ✓; QR codec §3.5 (T5) ✓; signedCore §3.4 + verifyAttestation §3.6 (T6) ✓; revocation §3.1/§3.5 (T7) ✓; full public API §3.5 (T8) ✓. Deferred-by-design (sub-spec §4/§8): hub issue side, `_attestations`, collection option, QR image, list hosting — explicitly the ①b plan, not here.
- **Placeholder scan:** none — every step has complete code.
- **Type consistency:** `QrPayload` (T5) reused identically in T6; `signedCore` excludes `alg`+`sig` consistently in T6 sign + verify; `RevocationList` defined T7, forward-imported as a type in T6 (stub note in T6 Step 4 handles ordering); `keyId` = `sha256Hex(pub).slice(0,16)` consistent T4/T6/T7; `computeFieldHashes(salt, schema, values)` signature identical T3/T6.
- **Known ordering dependency:** T6 imports `./revocation.js` (T7). Documented in T6 Step 4 with two resolutions (stub-first or reorder). The subagent executing T6 must create the revocation stub or do T7 first — called out explicitly.
