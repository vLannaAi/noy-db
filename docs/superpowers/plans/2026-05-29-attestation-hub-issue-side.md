# @noy-db/hub/attestation (issue side, ①b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL GIT RULE for every subagent:** NEVER run `git stash`, `git stash pop`, `git reset`, `git checkout HEAD -- <files>`, or `git clean`. A pre-existing user stash must never be touched. Only ever `git add <scoped paths>` + `git commit` + read-only git. If you think you need anything else, STOP and report.
>
> **ALWAYS run `npx tsc --noEmit` (or `npx tsc -p packages/hub/tsconfig.json --noEmit`) before committing** — vitest uses esbuild and does NOT typecheck. The repo passes `Uint8Array` to WebCrypto via `as BufferSource` casts (see `packages/hub/src/crypto.ts`).

**Goal:** Add the vault-coupled issue side of document attestation — `vault.issueAttestation(collection, id)` mints a docId, extracts the declared fields from the source record, signs a per-field commitment with the firm's Ed25519 key, writes an encrypted `_attestations/<docId>` index record, and returns the QR string. Exposed as the `@noy-db/hub/attestation` subpath.

**Architecture:** A new hub subsystem `src/attestation/` that depends on the published `@noy-db/attestation` pure package for all crypto/format. The firm's signing keypair is lazily minted and stored as an **encrypted `_attestations/_signer` record** under a dedicated `_attestations` collection DEK (the idiomatic hub pattern — the KEK is AES-KW-only and cannot AES-GCM-encrypt bytes directly). Per-collection verification field-schemas are declared via a new `attestation?: {fields}` collection option (per-vault registry, mirroring `blobFieldsRegistry`). Owner-only.

**Tech Stack:** TypeScript, WebCrypto, Vitest, tsup, pnpm workspace. Depends on `@noy-db/attestation` (workspace).

**Specs:** `docs/superpowers/specs/2026-05-29-attestation-core-and-issue-design.md` §4 (this plan), umbrella `…-document-attestation-umbrella-design.md`. ①a (`@noy-db/attestation`) is already merged to `main`.

**Branch:** create `feat/attestation-hub` off `main` (`git checkout main && git pull --ff-only && git checkout -b feat/attestation-hub`).

---

## Deviation from the approved sub-spec (one, forced)

Sub-spec §4.2/§4.3 said store the signing private key in a new `KeyringFile.doc_signing_key?` field "AES-GCM-encrypted under the owner KEK." That is **impossible**: the hub KEK is created non-extractable with usages `['wrapKey','unwrapKey']` only (`crypto.ts` `deriveKey`), so it cannot perform AES-GCM. **Corrected design:** the signer keypair is stored as an encrypted record `_attestations/_signer`, AES-GCM-encrypted under the `_attestations` collection DEK obtained via `vault.getDEK('_attestations')` (that DEK is AES-KW-wrapped under the KEK and persisted in the keyring by the existing `ensureCollectionDEK` machinery). No `KeyringFile` schema change. Same security posture as any collection DEK. Everything else follows §4.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/hub/package.json` | Modify | Add `@noy-db/attestation` to `dependencies`; add `./attestation` to `exports` |
| `packages/hub/tsup.config.ts` | Modify | Add `'attestation/index': 'src/attestation/index.ts'` to ENTRIES |
| `packages/hub/src/errors.ts` | Modify | Add `AttestationError extends NoydbError` |
| `packages/hub/src/attestation/signer.ts` | Create | Lazy signer keypair: load-or-create the encrypted `_attestations/_signer` record |
| `packages/hub/src/attestation/issue.ts` | Create | `issueAttestationCore(ctx, args)` — extract fields, hash, sign, write index, return QR |
| `packages/hub/src/attestation/index.ts` | Create | Subpath barrel |
| `packages/hub/src/vault.ts` | Modify | `attestation?` collection option + registry; `issueAttestation()` + `getDocumentSigningPublicKey()` methods |
| `packages/hub/src/collection.ts` | Modify | Accept + store `attestation?` in Collection constructor opts (parity with other opts) |
| `features.yaml` | Modify | New `attestation` feature row (cluster `time-and-audit`) |
| `packages/hub/__tests__/attestation-*.test.ts` | Create | Unit + integration tests |

---

## Task 1: Hub dependency + AttestationError + signer lifecycle

**Files:**
- Modify: `packages/hub/package.json` (dependencies only — subpath wiring is Task 4)
- Modify: `packages/hub/src/errors.ts`
- Create: `packages/hub/src/attestation/signer.ts`
- Test: `packages/hub/__tests__/attestation-signer.test.ts`

- [ ] **Step 1: Add the workspace dependency**

In `packages/hub/package.json`, change the empty `"dependencies": {}` to:
```json
  "dependencies": {
    "@noy-db/attestation": "workspace:*"
  },
```
Then run `pnpm install` from the repo root (registers the dep). Verify `node -e "require.resolve('@noy-db/attestation')"` resolves from within `packages/hub` (or just rely on the test in Step 5).

- [ ] **Step 2: Add `AttestationError`**

In `packages/hub/src/errors.ts`, find the existing `NoydbError` subclasses (e.g. `ValidationError`, `AdoptionStateError`) and add, following the identical pattern:
```ts
/** Document-attestation failures: undeclared field-schema, non-owner issue, missing field, signer failure. */
export class AttestationError extends NoydbError {
  constructor(message: string) {
    super(message)
    this.name = 'AttestationError'
  }
}
```
(Match the EXACT shape of a neighbouring error class — if they set a `code` or call `super` differently, mirror that. Read 2-3 sibling classes first.)

- [ ] **Step 3: Write the failing test for the signer lifecycle**

`packages/hub/__tests__/attestation-signer.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { loadOrCreateSigner } from '../src/attestation/signer.js'
import { generateDEK } from '../src/crypto.js'
import { ed25519Verify, signPayloadCore } from '@noy-db/attestation'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) { const coll = gc(v, c); const ex = coll.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); coll.set(id, env) },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { const coll = store.get(v)?.get(c); return coll ? [...coll.keys()] : [] },
    async loadAll(v) { const comp = store.get(v); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(v, data) { const comp = new Map<string, Map<string, EncryptedEnvelope>>(); for (const [n, recs] of Object.entries(data)) { const coll = new Map<string, EncryptedEnvelope>(); for (const [id, e] of Object.entries(recs)) coll.set(id, e); comp.set(n, coll) } const ex = store.get(v); if (ex) for (const [n, coll] of ex) if (n.startsWith('_')) comp.set(n, coll); store.set(v, comp) },
  }
}

describe('loadOrCreateSigner', () => {
  it('mints + persists a signer on first call, reuses it on the second (same keyId)', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    const a = await loadOrCreateSigner(store, 'v1', getDEK)
    expect(a.keyId).toHaveLength(16)
    expect(a.publicKeyB64).toBeTruthy()

    // second call loads the SAME signer (no new keypair)
    const b = await loadOrCreateSigner(store, 'v1', getDEK)
    expect(b.keyId).toBe(a.keyId)
    expect(b.publicKeyB64).toBe(a.publicKeyB64)
    expect(b.privateKeyPkcs8B64).toBe(a.privateKeyPkcs8B64)
  })

  it('the persisted _signer record is encrypted (non-empty _iv) and round-trips a real signature', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek
    const signer = await loadOrCreateSigner(store, 'v1', getDEK)

    const env = await store.get('v1', '_attestations', '_signer')
    expect(env).toBeTruthy()
    expect(env!._iv).not.toBe('')            // encrypted, not a plaintext bypass

    // the recovered private key actually signs, verifiable under the public key
    const sig = await signPayloadCore({ v: 1, docId: 'd', salt: 's', keyId: signer.keyId, fieldHashes: ['h'] }, signer.privateKeyPkcs8B64)
    const { utf8, canonicalJson } = await import('@noy-db/attestation')
    const core = utf8(canonicalJson({ v: 1, docId: 'd', salt: 's', keyId: signer.keyId, fieldHashes: ['h'] }))
    expect(await ed25519Verify(signer.publicKeyB64, sig, core)).toBe(true)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/attestation-signer.test.ts`
Expected: FAIL — `Cannot find module '../src/attestation/signer.js'`.

- [ ] **Step 5: Implement `src/attestation/signer.ts`**

```ts
import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { encrypt, decrypt } from '../crypto.js'
import { generateDocSigningKeyPair } from '@noy-db/attestation'

export const ATTESTATIONS_COLLECTION = '_attestations'
export const SIGNER_RECORD_ID = '_signer'

export interface DocSigner {
  readonly keyId: string
  readonly publicKeyB64: string
  readonly privateKeyPkcs8B64: string
}

/**
 * Lazily mint (or load) the firm's Ed25519 document-signing keypair.
 *
 * Stored as an encrypted record `_attestations/_signer` under the
 * `_attestations` collection DEK (resolved via `getDEK`, which is
 * AES-KW-wrapped under the owner KEK + persisted by the keyring). The
 * KEK itself is AES-KW-only and cannot AES-GCM-encrypt these bytes —
 * hence storage under a normal collection DEK.
 */
export async function loadOrCreateSigner(
  store: NoydbStore,
  vault: string,
  getDEK: (collection: string) => Promise<CryptoKey>,
): Promise<DocSigner> {
  const dek = await getDEK(ATTESTATIONS_COLLECTION)
  const existing = await store.get(vault, ATTESTATIONS_COLLECTION, SIGNER_RECORD_ID)
  if (existing) {
    const json = await decrypt(existing._iv, existing._data, dek)
    return JSON.parse(json) as DocSigner
  }
  const signer = await generateDocSigningKeyPair()
  const { iv, data } = await encrypt(JSON.stringify(signer), dek)
  const env: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: new Date().toISOString(), _iv: iv, _data: data,
  }
  // expectedVersion 0 = "must not already exist" — guards a concurrent first-mint race.
  await store.put(vault, ATTESTATIONS_COLLECTION, SIGNER_RECORD_ID, env, 0)
  return signer
}
```
Notes: confirm `encrypt`/`decrypt`/`generateDEK` signatures in `packages/hub/src/crypto.ts` (`encrypt(plaintext, dek) → {iv,data}`, `decrypt(iv, data, dek) → string`). Confirm `EncryptedEnvelope` required fields in `types.ts:95` — if `_v`/`_ts`/`_noydb` differ, match them. If `store.put`'s 5th arg (`expectedVersion`) isn't supported by the signature, drop it (the lazy check already guards the common case).

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/attestation-signer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck + commit**

```bash
cd /Users/vicio/_github/noy-db && npx tsc -p packages/hub/tsconfig.json --noEmit   # clean
git add packages/hub/package.json pnpm-lock.yaml packages/hub/src/errors.ts packages/hub/src/attestation/signer.ts packages/hub/__tests__/attestation-signer.test.ts
git commit -m "feat(hub/attestation): lazy Ed25519 signer stored as encrypted _attestations/_signer

Depends on @noy-db/attestation. The signer keypair is AES-GCM-encrypted
under the _attestations collection DEK (the hub KEK is AES-KW-only and
cannot encrypt bytes directly), not a KeyringFile field. Adds
AttestationError."
```

---

## Task 2: issueAttestation core

**Files:**
- Create: `packages/hub/src/attestation/issue.ts`
- Test: `packages/hub/__tests__/attestation-issue.test.ts`

**Single signer design:** `issueAttestationCore` takes an `IssueContext` that carries a `store` + `vault` + `getDEK` + `role` + `readRecord`. It calls the ONE `loadOrCreateSigner(store, vault, getDEK)` from `signer.ts` (Task 1) — no second signer implementation. Tests inject a `memory()` store as `ctx.store`.

- [ ] **Step 1: Write the failing test**

`packages/hub/__tests__/attestation-issue.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { issueAttestationCore } from '../src/attestation/issue.js'
import { verifyAttestation } from '@noy-db/attestation'
import type { AttestationFieldSchema } from '@noy-db/attestation'
import { generateDEK, decrypt } from '../src/crypto.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => { let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) } let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) } return coll }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) { const coll = gc(v, c); const ex = coll.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); coll.set(id, env) },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { const coll = store.get(v)?.get(c); return coll ? [...coll.keys()] : [] },
    async loadAll(v) { const comp = store.get(v); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(v, data) { const comp = new Map<string, Map<string, EncryptedEnvelope>>(); for (const [n, recs] of Object.entries(data)) { const coll = new Map<string, EncryptedEnvelope>(); for (const [id, e] of Object.entries(recs)) coll.set(id, e); comp.set(n, coll) } const ex = store.get(v); if (ex) for (const [n, coll] of ex) if (n.startsWith('_')) comp.set(n, coll); store.set(v, comp) },
  }
}

const schema: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}
const record = { invoiceNo: 'INV-1001', total: 1234.5, issueDate: '2026-05-29' }

async function makeCtx(over: Partial<{ role: string; readRecord: (c: string, id: string) => Promise<{ record: Record<string, unknown>; version: number } | null> }> = {}) {
  const store = memory()
  const dek = await generateDEK()
  return {
    store, dek,
    ctx: {
      store, vault: 'v1', role: 'owner',
      getDEK: async () => dek,
      readRecord: async (_c: string, _id: string) => ({ record, version: 3 }),
      ...over,
    },
  }
}

describe('issueAttestationCore', () => {
  it('issues a QR that verifyAttestation accepts for the same fields + published key', async () => {
    const { ctx } = await makeCtx()
    const out = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })
    expect(out.docId).toHaveLength(26) // ULID
    expect(out.keyId).toHaveLength(16)
    const r = await verifyAttestation({ qr: out.qr, claimedFields: record, fieldSchema: schema, publicKeys: { [out.keyId]: out.publicKeyB64 } })
    expect(r.valid).toBe(true)
    expect(r.perField.every((f) => f.match)).toBe(true)
  })

  it('detects a later edit: verifying against altered fields fails that field', async () => {
    const { ctx } = await makeCtx()
    const out = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })
    const r = await verifyAttestation({ qr: out.qr, claimedFields: { ...record, total: 9999 }, fieldSchema: schema, publicKeys: { [out.keyId]: out.publicKeyB64 } })
    expect(r.valid).toBe(false)
    expect(r.perField.find((f) => f.path === 'total')!.match).toBe(false)
  })

  it('writes an encrypted _attestations/<docId> index pinning the source version', async () => {
    const { ctx, store, dek } = await makeCtx()
    const out = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })
    const env = await store.get('v1', '_attestations', out.docId)
    expect(env).toBeTruthy()
    expect(env!._iv).not.toBe('')
    const idx = JSON.parse(await decrypt(env!._iv, env!._data, dek)) as { sourceRefs: { collection: string; id: string; version: number }[] }
    expect(idx.sourceRefs[0]).toEqual({ collection: 'invoices', id: 'inv-1001', version: 3 })
  })

  it('reuses the same signer across issues (stable keyId)', async () => {
    const { ctx } = await makeCtx()
    const a = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })
    const b = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1002', fieldSchema: schema })
    expect(b.keyId).toBe(a.keyId)
  })

  it('rejects a non-owner caller', async () => {
    const { ctx } = await makeCtx({ role: 'admin' })
    await expect(issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })).rejects.toThrow(/owner/)
  })

  it('rejects a missing source record', async () => {
    const { ctx } = await makeCtx({ readRecord: async () => null })
    await expect(issueAttestationCore(ctx, { collection: 'invoices', id: 'nope', fieldSchema: schema })).rejects.toThrow(/not found/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/attestation-issue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/attestation/issue.ts`**

```ts
import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { encrypt } from '../crypto.js'
import { AttestationError } from '../errors.js'
import { generateULID } from '../bundle/ulid.js'
import { loadOrCreateSigner, ATTESTATIONS_COLLECTION } from './signer.js'
import {
  computeFieldHashes, signPayloadCore, encodeQr,
  type AttestationFieldSchema, type QrPayload,
} from '@noy-db/attestation'

/** Everything issueAttestationCore needs from the Vault, injected for testability. */
export interface IssueContext {
  readonly store: NoydbStore
  readonly vault: string
  readonly role: string
  /** The _attestations collection DEK (AES-KW-wrapped under KEK by the keyring). */
  getDEK(): Promise<CryptoKey>
  /** Decrypted source record + its envelope version, or null if absent. */
  readRecord(collection: string, id: string): Promise<{ record: Record<string, unknown>; version: number } | null>
}

export interface IssueArgs {
  readonly collection: string
  readonly id: string
  readonly fieldSchema: AttestationFieldSchema
}
export interface IssueResult {
  readonly docId: string
  readonly qr: string
  readonly payload: QrPayload
  readonly keyId: string
  readonly publicKeyB64: string
}

export async function issueAttestationCore(ctx: IssueContext, args: IssueArgs): Promise<IssueResult> {
  if (ctx.role !== 'owner') {
    throw new AttestationError(`issueAttestation requires the 'owner' role; caller is '${ctx.role}'. Issuing a signed attestation is the firm's identity operation.`)
  }
  const src = await ctx.readRecord(args.collection, args.id)
  if (!src) throw new AttestationError(`issueAttestation: source record '${args.collection}/${args.id}' not found.`)

  const dek = await ctx.getDEK()
  // ONE signer implementation, from signer.ts. Lazily minted + persisted.
  const signer = await loadOrCreateSigner(ctx.store, ctx.vault, () => Promise.resolve(dek))

  const saltB64 = toB64url(crypto.getRandomValues(new Uint8Array(16)))
  const fieldHashes = await computeFieldHashes(saltB64, args.fieldSchema, src.record)
  const docId = generateULID()

  const sig = await signPayloadCore({ v: 1, docId, salt: saltB64, keyId: signer.keyId, fieldHashes }, signer.privateKeyPkcs8B64)
  const payload: QrPayload = { v: 1, docId, salt: saltB64, alg: 'ed25519', keyId: signer.keyId, fieldHashes, sig }

  const index = {
    docId, issuedAt: new Date().toISOString(), keyId: signer.keyId,
    fieldPaths: args.fieldSchema.fields.map((f) => f.path),
    sourceRefs: [{ collection: args.collection, id: args.id, version: src.version }],
  }
  const { iv, data } = await encrypt(JSON.stringify(index), dek)
  const env: EncryptedEnvelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: index.issuedAt, _iv: iv, _data: data }
  await ctx.store.put(ctx.vault, ATTESTATIONS_COLLECTION, docId, env)

  return { docId, qr: encodeQr(payload), payload, keyId: signer.keyId, publicKeyB64: signer.publicKeyB64 }
}

function toB64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
```
Notes:
- `loadOrCreateSigner(store, vault, getDEK)` is the SINGLE signer impl from `signer.ts` (Task 1). `issue.ts` passes `() => Promise.resolve(dek)` since it already resolved the `_attestations` DEK. There is no second signer implementation anywhere.
- `computeFieldHashes` THROWS (`/missing/`) if a declared field path is absent — acceptable surface (the tests' records have all fields). Wrapping it as `AttestationError` is optional, not required by tests.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/attestation-issue.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/vicio/_github/noy-db && npx tsc -p packages/hub/tsconfig.json --noEmit
git add packages/hub/src/attestation/issue.ts packages/hub/__tests__/attestation-issue.test.ts
git commit -m "feat(hub/attestation): issueAttestationCore — extract, sign, write encrypted index

Owner-only. Extracts the declared fields from the decrypted source
record, mints a docId, signs the per-field commitment using the single
signer.ts signer, writes an encrypted _attestations/<docId> index pinning
the source version, returns the QR. Verified by @noy-db/attestation."
```
There is exactly ONE signer implementation (`signer.ts`); `issue.ts` imports it. No reconciliation needed.

---

## Task 3: Vault wiring — collection option + issueAttestation method

**Files:**
- Modify: `packages/hub/src/vault.ts`
- Modify: `packages/hub/src/collection.ts`
- Test: `packages/hub/__tests__/attestation-vault.test.ts`

Exact anchors (verify before editing — line numbers drift):
- `vault.collection(name, opts)` inline options type: `vault.ts:493–540`.
- collOpts construction: `vault.ts:~595–697`; per-vault registries pattern e.g. `blobFieldsRegistry` at `vault.ts:225`, registered at `~582`.
- `this.adapter` (115), `this.keyring` (133, an `UnlockedKeyring` with `.role`/`.kek`/`.deks`/`.userId`), `this.name`, `this.getDEK` (189), `get role()` (943).
- `this.getDEK('_attestations')` auto-creates+persists the DEK (via `ensureCollectionDEK`).

- [ ] **Step 1: Write the failing integration test**

`packages/hub/__tests__/attestation-vault.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { verifyAttestation } from '@noy-db/attestation'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, AttestationError } from '../src/errors.js'

function memory(): NoydbStore { /* same memory() helper as attestation-signer.test.ts — copy it verbatim */ 
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => { let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) } let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) } return coll }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) { const coll = gc(v, c); const ex = coll.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); coll.set(id, env) },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { const coll = store.get(v)?.get(c); return coll ? [...coll.keys()] : [] },
    async loadAll(v) { const comp = store.get(v); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(v, data) { const comp = new Map<string, Map<string, EncryptedEnvelope>>(); for (const [n, recs] of Object.entries(data)) { const coll = new Map<string, EncryptedEnvelope>(); for (const [id, e] of Object.entries(recs)) coll.set(id, e); comp.set(n, coll) } const ex = store.get(v); if (ex) for (const [n, coll] of ex) if (n.startsWith('_')) comp.set(n, coll); store.set(v, comp) },
  }
}

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation = { fields: [
  { path: 'invoiceNo', normalize: 'alnum-upper' as const },
  { path: 'total', normalize: 'cents' as const },
  { path: 'issueDate', normalize: 'iso-date' as const },
] }

async function ownerVault() {
  const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-passphrase-2026' })
  const vault = await db.openVault('books')
  const invoices = vault.collection<Invoice>('invoices', { attestation })
  await invoices.put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1', total: 1234.5, issueDate: '2026-05-29' })
  return { db, vault }
}

describe('vault.issueAttestation (integration)', () => {
  it('issues a QR a third party verifies offline with the published public key', async () => {
    const { vault } = await ownerVault()
    const { docId, qr, keyId } = await vault.issueAttestation('invoices', 'inv-1')
    expect(docId).toHaveLength(26)

    const { keyId: pubKeyId, publicKeyB64 } = await vault.getDocumentSigningPublicKey()
    expect(pubKeyId).toBe(keyId)

    const r = await verifyAttestation({
      qr, claimedFields: { invoiceNo: 'INV-1', total: 1234.5, issueDate: '2026-05-29' },
      fieldSchema: attestation, publicKeys: { [pubKeyId]: publicKeyB64 },
    })
    expect(r.valid).toBe(true)
  })

  it('reuses the same signer across issues (stable keyId)', async () => {
    const { vault } = await ownerVault()
    const a = await vault.issueAttestation('invoices', 'inv-1')
    await vault.collection<Invoice>('invoices').put('inv-2', { id: 'inv-2', invoiceNo: 'INV-2', total: 5, issueDate: '2026-05-29' })
    const b = await vault.issueAttestation('invoices', 'inv-2')
    expect(b.keyId).toBe(a.keyId)
  })

  it('throws AttestationError when the collection has no attestation schema declared', async () => {
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'pw-123456' })
    const vault = await db.openVault('books')
    await vault.collection<Invoice>('plain').put('x', { id: 'x', invoiceNo: 'A', total: 1, issueDate: '2026-05-29' })
    await expect(vault.issueAttestation('plain', 'x')).rejects.toThrow(AttestationError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/attestation-vault.test.ts`
Expected: FAIL — `vault.issueAttestation is not a function` (or the `attestation` option is rejected by TS — that's fine, it drives the next steps).

- [ ] **Step 3: Add the `attestation?` collection option + per-vault registry**

In `packages/hub/src/vault.ts`:
1. Import the type + a registry. At the top, add:
   ```ts
   import type { AttestationFieldSchema } from '@noy-db/attestation'
   ```
2. In the inline options type of `collection<T>(name, options?: { ... })` (around 493–540), add a line:
   ```ts
       attestation?: AttestationFieldSchema
   ```
3. Add a per-vault registry field near `blobFieldsRegistry` (~225):
   ```ts
   private readonly attestationRegistry = new Map<string, AttestationFieldSchema>()
   ```
4. In `collection()`, where other registries are populated (near where `blobFieldsRegistry`/`i18nFieldRegistry` are set, ~566–583), add:
   ```ts
   if (options?.attestation !== undefined) this.attestationRegistry.set(collectionName, options.attestation)
   ```
   (You do NOT need to thread it into the Collection constructor — issueAttestation reads it from the registry. Skip the `collection.ts` change UNLESS tsc requires the Collection constructor to accept it; if the inline collOpts spread complains, just don't add it to collOpts.)

- [ ] **Step 4: Add `issueAttestation` + `getDocumentSigningPublicKey` Vault methods**

In `packages/hub/src/vault.ts`, add two methods to the `Vault` class (near other vault-level operations). They adapt the Vault's internals to `issueAttestationCore`'s `IssueContext`:
```ts
  async issueAttestation(collectionName: string, id: string): Promise<{ docId: string; qr: string; keyId: string; publicKeyB64: string }> {
    const { issueAttestationCore } = await import('./attestation/issue.js')
    const fieldSchema = this.attestationRegistry.get(collectionName)
    if (!fieldSchema) {
      const { AttestationError } = await import('./errors.js')
      throw new AttestationError(`issueAttestation: collection '${collectionName}' has no attestation field-schema. Declare it via vault.collection('${collectionName}', { attestation: { fields: [...] } }).`)
    }
    const out = await issueAttestationCore(this.makeIssueContext(), { collection: collectionName, id, fieldSchema })
    return { docId: out.docId, qr: out.qr, keyId: out.keyId, publicKeyB64: out.publicKeyB64 }
  }

  async getDocumentSigningPublicKey(): Promise<{ keyId: string; publicKeyB64: string }> {
    const { loadOrCreateSigner } = await import('./attestation/signer.js')
    const signer = await loadOrCreateSigner(this.adapter, this.name, this.getDEK)
    return { keyId: signer.keyId, publicKeyB64: signer.publicKeyB64 }
  }

  private makeIssueContext(): import('./attestation/issue.js').IssueContext {
    const adapter = this.adapter, vaultName = this.name, getDEK = this.getDEK
    return {
      store: adapter,
      vault: vaultName,
      role: this.keyring.role,
      getDEK: async () => getDEK('_attestations'),
      readRecord: async (collection: string, recId: string) => {
        const env = await adapter.get(vaultName, collection, recId)
        if (!env) return null
        const record = (await this.collection(collection).get(recId)) as Record<string, unknown> | null
        if (record === null) return null
        return { record, version: env._v }
      },
    }
  }
```
This wires the Vault directly into `issueAttestationCore`'s `IssueContext` (store-based). `getDocumentSigningPublicKey` and `issueAttestationCore` both reach the SAME `loadOrCreateSigner(store, vault, getDEK)` in `signer.ts` — one signer implementation, no reconciliation.

- [ ] **Step 5: Run the integration test + the earlier two files**

Run: `cd packages/hub && npx vitest run __tests__/attestation-vault.test.ts __tests__/attestation-issue.test.ts __tests__/attestation-signer.test.ts`
Expected: ALL pass. (signer.ts is the single signer; no test imports need to change.)

- [ ] **Step 6: Typecheck + commit**

```bash
cd /Users/vicio/_github/noy-db && npx tsc -p packages/hub/tsconfig.json --noEmit
git add packages/hub/src/vault.ts packages/hub/src/collection.ts packages/hub/src/attestation/ packages/hub/__tests__/attestation-vault.test.ts packages/hub/__tests__/attestation-issue.test.ts packages/hub/__tests__/attestation-signer.test.ts
git commit -m "feat(hub/attestation): vault.issueAttestation + getDocumentSigningPublicKey + attestation collection option

Per-collection attestation field-schema via a vault registry (blobFields
pattern). issueAttestation adapts the Vault keyring/adapter/getDEK/role
into issueAttestationCore. Single reconciled signer implementation."
```

---

## Task 4: Subpath wiring + barrel

**Files:**
- Create: `packages/hub/src/attestation/index.ts`
- Modify: `packages/hub/package.json` (exports map), `packages/hub/tsup.config.ts`
- Test: `packages/hub/__tests__/attestation-subpath.test.ts`

- [ ] **Step 1: Create the barrel `src/attestation/index.ts`**
```ts
/**
 * @category capability
 * Document attestation — issue side. Mint a signed, per-field commitment
 * for a record and emit a QR credential verifiable offline via
 * `@noy-db/attestation`. See docs/superpowers/specs/2026-05-29-attestation-core-and-issue-design.md.
 */
export { issueAttestationCore } from './issue.js'
export type { IssueContext, IssueArgs, IssueResult } from './issue.js'
export { ATTESTATIONS_COLLECTION } from './signer.js'   // omit this line if signer.ts was consolidated away
// Re-export the pure verifier surface so consumers can verify from one import:
export { verifyAttestation, decodeQr, verifyRevocationList, isRevoked, type QrPayload, type AttestationFieldSchema, type VerifyResult } from '@noy-db/attestation'
```
(If `signer.ts` was consolidated into `issue.ts` in Task 3, drop the `ATTESTATIONS_COLLECTION` re-export line or move that constant into `issue.ts` and export from there. The barrel must only reference symbols that exist.)

- [ ] **Step 2: Add the subpath to `package.json` exports**

In `packages/hub/package.json`, after the `./util` block (the last exports entry, ~229–238), add:
```json
    ,"./attestation": {
      "import": { "types": "./dist/attestation/index.d.ts", "default": "./dist/attestation/index.js" },
      "require": { "types": "./dist/attestation/index.d.cts", "default": "./dist/attestation/index.cjs" }
    }
```
(Match the existing block's formatting exactly; ensure valid JSON — the comma goes BEFORE the new key, after the previous block's closing brace.)

- [ ] **Step 3: Add the tsup entry**

In `packages/hub/tsup.config.ts`, in the `ENTRIES` object, add:
```ts
  'attestation/index': 'src/attestation/index.ts',
```

- [ ] **Step 4: Write the subpath smoke test**

`packages/hub/__tests__/attestation-subpath.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('@noy-db/hub/attestation subpath', () => {
  it('re-exports issue + verify surface', async () => {
    const mod = await import('../src/attestation/index.js')
    expect(typeof mod.issueAttestationCore).toBe('function')
    expect(typeof mod.verifyAttestation).toBe('function')
    expect(typeof mod.decodeQr).toBe('function')
  })
})
```

- [ ] **Step 5: Run the test + typecheck**

Run: `cd packages/hub && npx vitest run __tests__/attestation-subpath.test.ts`
Expected: PASS. Then `cd /Users/vicio/_github/noy-db && npx tsc -p packages/hub/tsconfig.json --noEmit` (clean).

- [ ] **Step 6: Commit**
```bash
git add packages/hub/src/attestation/index.ts packages/hub/package.json packages/hub/tsup.config.ts packages/hub/__tests__/attestation-subpath.test.ts
git commit -m "feat(hub/attestation): @noy-db/hub/attestation subpath barrel + build wiring"
```

---

## Task 5: features.yaml + full verification

**Files:**
- Modify: `features.yaml`

- [ ] **Step 1: Add the `attestation` feature row**

In `features.yaml`, add a new feature entry in the `time-and-audit` cluster (place it near the `history` / `bundle` rows; mirror the `transferable-partition` row's shape):
```yaml
  - id: attestation
    name: Document attestation (signed-QR offline verification)
    cluster: time-and-audit
    spec: docs/superpowers/specs/2026-05-29-attestation-core-and-issue-design.md
    subsystem_doc: docs/superpowers/specs/2026-05-29-document-attestation-umbrella-design.md
    package: '@noy-db/hub/attestation'
    factory: null
    status: preview
    showcases: []
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'verification is offline: the signed per-field commitment travels in the QR; no server holds or returns document content'
      - 'authenticity via Ed25519 signature over the per-field commitment (a plain hash would be forgeable); integrity via per-field salted hashes enabling which-field-differs localization'
      - 'issue is owner-only; the signing keypair is stored encrypted under the _attestations collection DEK (not the KEK, which is AES-KW-only)'
      - '_attestations index records are encrypted and pin the source record version'
    related: [history, bundle]
```
(Read an existing row first and match indentation/field set EXACTLY. If `validate-features.mjs` requires fields this omits, add them per a sibling row.)

- [ ] **Step 2: Validate features**
```bash
cd /Users/vicio/_github/noy-db && node scripts/validate-features.mjs 2>&1 | tail -8
```
Expected: passes (features count +1). Fix per the validator if it complains.

- [ ] **Step 3: Full build + lint + typecheck + tests (hub + attestation)**
```bash
cd /Users/vicio/_github/noy-db
npx turbo run build lint typecheck --filter=@noy-db/hub --filter=@noy-db/attestation 2>&1 | tail -8
npx vitest run --project core --reporter=dot 2>&1 | tail -6   # full hub suite ('core' is hub's vitest project name)
```
Expected: turbo all green; full hub suite passes (previous count + the new attestation tests). If the hub vitest project name isn't `core`, run `npx vitest run packages/hub/__tests__/attestation-*.test.ts` plus a broader `npx vitest run` and confirm no regressions.

- [ ] **Step 4: Commit**
```bash
git add features.yaml
git commit -m "docs(features): register attestation (hub issue side) in time-and-audit cluster"
```

---

## Self-Review (completed)

- **Spec coverage** (sub-spec §4): §4.1 collection option → T3 ✓; §4.2 signer keypair (CORRECTED: encrypted `_attestations/_signer` under collection DEK, not KeyringFile/KEK) → T1 ✓; §4.3 encrypted `_attestations/<docId>` index pinning version → T2 ✓; §4.4 `issueAttestation` orchestration → T2+T3 ✓; §4.5 `AttestationError` → T1 ✓; `getDocumentSigningPublicKey` → T3 ✓; subpath → T4 ✓; features row → T5 ✓.
- **Placeholder scan:** none — every step has complete code. There is exactly ONE signer implementation (`signer.ts`, Task 1); `issue.ts` imports it (Task 2) and the Vault reaches it via `getDocumentSigningPublicKey` + the issue context (Task 3). No "reconcile later" ambiguity.
- **Type consistency:** `IssueContext` (store-based: `store`/`vault`/`role`/`getDEK`/`readRecord`) defined T2, built by `makeIssueContext` in T3, re-exported T4; `loadOrCreateSigner(store, vault, getDEK)` ONE impl in `signer.ts` used by both `issue.ts` and `getDocumentSigningPublicKey`; `AttestationFieldSchema`/`QrPayload`/`computeFieldHashes`/`signPayloadCore`/`encodeQr`/`verifyAttestation` imported from `@noy-db/attestation` consistently; `ATTESTATIONS_COLLECTION='_attestations'`, `SIGNER_RECORD_ID='_signer'` defined once in `signer.ts`.
- **Known risk:** T3 edits `vault.ts` (large core file) and `collection.ts` — anchors given by line; verify before editing (line numbers drift). Keep edits minimal: the `attestation?` option only needs the inline type + the registry set + nothing in the Collection constructor unless tsc forces it.
