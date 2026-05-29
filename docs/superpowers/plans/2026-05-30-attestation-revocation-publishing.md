# Document Attestation ⑤ — Revocation Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL GIT RULE for every subagent:** NEVER run `git stash`, `git stash pop`, `git reset`, `git checkout HEAD -- <files>`, or `git clean`. A pre-existing user stash (`stash@{0}: WIP on main`) must never be touched. Only `git add <scoped paths>` + `git commit` + read-only git. If you think you need anything else, STOP and report.
>
> **ALWAYS run `npx tsc -p packages/hub/tsconfig.json --noEmit` before committing hub changes** — vitest uses esbuild and does NOT typecheck. Repo uses `as BufferSource` casts for WebCrypto where needed.

**Goal:** Add the owner-only hub API to revoke an issued document and publish a signed `RevocationList`, with the vault as source of truth — closing the ④ private-key gap so the firm never handles raw signing keys.

**Architecture:** Extends the `@noy-db/hub/attestation` subsystem. A store-injected core `revoke.ts` (mirrors `issue.ts`) tracks the revoked set in an encrypted `_attestations/_revoked` record and signs the list with the firm's existing `loadOrCreateSigner`. `vault.ts` adds four methods. A showcase reuses ④'s `verifyDocument` to prove issue → revoke → publish → `authentic-revoked`.

**Tech Stack:** TypeScript, WebCrypto, Vitest, pnpm workspace. Depends on the merged `@noy-db/attestation` (①a), `@noy-db/hub/attestation` (①b), and `@noy-db/recipe-attestation-verifier` (④, a showcases devDep).

**Spec:** `docs/superpowers/specs/2026-05-30-attestation-revocation-publishing-design.md`.

**Branch:** `feat/attestation-revocation` (already checked out, off `main` incl. #237).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/hub/src/attestation/signer.ts` | Modify | add `export const REVOKED_RECORD_ID = '_revoked'` |
| `packages/hub/src/attestation/revoke.ts` | Create | `RevokeContext` + revoke/unrevoke/getRevoked/publish core |
| `packages/hub/__tests__/attestation-revoke.test.ts` | Create | core unit tests |
| `packages/hub/src/vault.ts` | Modify | 4 vault methods + `makeRevokeContext` + type imports |
| `packages/hub/src/attestation/index.ts` | Modify | export revoke surface + `type RevocationList` |
| `packages/hub/__tests__/attestation-revoke-vault.test.ts` | Create | vault integration test |
| `showcases/src/89-attestation-revocation.showcase.test.ts` | Create | issue → revoke → publish → authentic-revoked |
| `features.yaml` | Modify | register the showcase on the `attestation` feature row |

---

## Task 1: `revoke.ts` core + `REVOKED_RECORD_ID` (TDD)

**Files:** modify `packages/hub/src/attestation/signer.ts`; create `packages/hub/src/attestation/revoke.ts`; test `packages/hub/__tests__/attestation-revoke.test.ts`.

- [ ] **Step 1: Add the record-id constant**

In `packages/hub/src/attestation/signer.ts`, after the line `export const SIGNER_RECORD_ID = '_signer'`, add:
```ts
export const REVOKED_RECORD_ID = '_revoked'
```

- [ ] **Step 2: Write the failing test `packages/hub/__tests__/attestation-revoke.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import {
  revokeDocCore, unrevokeDocCore, getRevokedDocIdsCore, publishRevocationListCore,
  type RevokeContext,
} from '../src/attestation/revoke.js'
import { loadOrCreateSigner } from '../src/attestation/signer.js'
import { generateDEK } from '../src/crypto.js'
import { verifyRevocationList, isRevoked } from '@noy-db/attestation'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { NOYDB_FORMAT_VERSION } from '../src/types.js'
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

// Put a placeholder envelope so the revoke existence-check (store.get on
// `_attestations/<docId>`) passes — it never decrypts this, only checks presence.
async function seedIssued(store: NoydbStore, vault: string, docId: string) {
  const env: EncryptedEnvelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: 't', _iv: 'iv', _data: 'data' }
  await store.put(vault, '_attestations', docId, env)
}

async function makeCtx(role = 'owner') {
  const store = memory()
  const dek = await generateDEK()
  const ctx: RevokeContext = { store, vault: 'v1', role, getDEK: async () => dek }
  return { store, dek, ctx }
}

describe('revoke core', () => {
  it('revoke adds a docId; idempotent; getRevokedDocIds reflects it', async () => {
    const { store, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd1')
    await revokeDocCore(ctx, 'd1')
    await revokeDocCore(ctx, 'd1') // idempotent
    expect(await getRevokedDocIdsCore(ctx)).toEqual(['d1'])
  })

  it('accumulates multiple docIds (sorted)', async () => {
    const { store, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd2'); await seedIssued(store, 'v1', 'd1')
    await revokeDocCore(ctx, 'd2'); await revokeDocCore(ctx, 'd1')
    expect(await getRevokedDocIdsCore(ctx)).toEqual(['d1', 'd2'])
  })

  it('unrevoke removes a docId (no-op if absent)', async () => {
    const { store, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd1')
    await revokeDocCore(ctx, 'd1')
    await unrevokeDocCore(ctx, 'd1')
    await unrevokeDocCore(ctx, 'nope') // no-op
    expect(await getRevokedDocIdsCore(ctx)).toEqual([])
  })

  it('revoking an un-issued docId throws not-found', async () => {
    const { ctx } = await makeCtx()
    await expect(revokeDocCore(ctx, 'never-issued')).rejects.toThrow(/not found/)
  })

  it('non-owner cannot revoke or publish', async () => {
    const { store, ctx } = await makeCtx('admin')
    await seedIssued(store, 'v1', 'd1')
    await expect(revokeDocCore(ctx, 'd1')).rejects.toThrow(/owner/)
    await expect(publishRevocationListCore(ctx)).rejects.toThrow(/owner/)
  })

  it('publishRevocationList signs a list that verifies + reports the docId revoked', async () => {
    const { store, dek, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd1')
    await revokeDocCore(ctx, 'd1')
    const list = await publishRevocationListCore(ctx)
    const signer = await loadOrCreateSigner(store, 'v1', () => Promise.resolve(dek))
    expect(list.keyId).toBe(signer.keyId)
    expect(await verifyRevocationList(list, signer.publicKeyB64)).toBe(true)
    expect(isRevoked('d1', list)).toBe(true)
    expect(isRevoked('other', list)).toBe(false)
  })

  it('publishing an empty set yields a valid signed empty list', async () => {
    const { store, dek, ctx } = await makeCtx()
    const list = await publishRevocationListCore(ctx)
    const signer = await loadOrCreateSigner(store, 'v1', () => Promise.resolve(dek))
    expect(list.revokedDocIds).toEqual([])
    expect(await verifyRevocationList(list, signer.publicKeyB64)).toBe(true)
  })

  it('retries once on a ConflictError during the read-modify-write', async () => {
    const { store, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd1')
    let firstPut = true
    // Wrap put to throw ConflictError exactly once for the _revoked record.
    const wrapped: NoydbStore = {
      ...store,
      async put(v, c, id, env, ev) {
        if (c === '_attestations' && id === '_revoked' && firstPut) { firstPut = false; throw new ConflictError(99) }
        return store.put(v, c, id, env, ev)
      },
    }
    const ctx2: RevokeContext = { ...ctx, store: wrapped }
    await revokeDocCore(ctx2, 'd1')   // must catch the conflict, re-read, retry, succeed
    expect(await getRevokedDocIdsCore(ctx2)).toEqual(['d1'])
  })
})
```

- [ ] **Step 3: Run the test, verify it FAILS** (module not found)

Run: `cd packages/hub && npx vitest run __tests__/attestation-revoke.test.ts`
Expected: FAIL — cannot resolve `../src/attestation/revoke.js`.

- [ ] **Step 4: Implement `packages/hub/src/attestation/revoke.ts`**

```ts
import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { encrypt, decrypt } from '../crypto.js'
import { AttestationError, ConflictError } from '../errors.js'
import { loadOrCreateSigner, ATTESTATIONS_COLLECTION, REVOKED_RECORD_ID } from './signer.js'
import { signRevocationList, type RevocationList } from '@noy-db/attestation'

/** Everything the revoke core needs from the Vault, injected for testability. */
export interface RevokeContext {
  readonly store: NoydbStore
  readonly vault: string
  readonly role: string
  /** The _attestations collection DEK. */
  getDEK(): Promise<CryptoKey>
}

interface RevokedSet {
  docIds: string[]
  updatedAt: string
}

function requireOwner(ctx: RevokeContext, op: string): void {
  if (ctx.role !== 'owner') {
    throw new AttestationError(`${op} requires the 'owner' role; caller is '${ctx.role}'. Revocation is the firm's identity operation.`)
  }
}

async function readSet(store: NoydbStore, vault: string, dek: CryptoKey): Promise<{ docIds: Set<string>; version: number | undefined }> {
  const env = await store.get(vault, ATTESTATIONS_COLLECTION, REVOKED_RECORD_ID)
  if (!env) return { docIds: new Set<string>(), version: undefined }
  const set = JSON.parse(await decrypt(env._iv, env._data, dek)) as RevokedSet
  return { docIds: new Set(set.docIds), version: env._v }
}

/** Read-modify-write the _revoked set with optimistic concurrency + one retry. */
async function mutateSet(ctx: RevokeContext, mutate: (ids: Set<string>) => void): Promise<void> {
  const dek = await ctx.getDEK()
  for (let attempt = 0; attempt < 2; attempt++) {
    const { docIds, version } = await readSet(ctx.store, ctx.vault, dek)
    mutate(docIds)
    const payload: RevokedSet = { docIds: [...docIds].sort(), updatedAt: new Date().toISOString() }
    const { iv, data } = await encrypt(JSON.stringify(payload), dek)
    // version undefined → first write, expectedVersion 0 ("must not already exist").
    const expectedVersion = version ?? 0
    const env: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION, _v: expectedVersion + 1, _ts: payload.updatedAt, _iv: iv, _data: data,
    }
    try {
      await ctx.store.put(ctx.vault, ATTESTATIONS_COLLECTION, REVOKED_RECORD_ID, env, expectedVersion)
      return
    } catch (e) {
      if (e instanceof ConflictError && attempt === 0) continue // lost the race — re-read + retry once
      throw e
    }
  }
}

export async function revokeDocCore(ctx: RevokeContext, docId: string): Promise<void> {
  requireOwner(ctx, 'revokeAttestation')
  const issued = await ctx.store.get(ctx.vault, ATTESTATIONS_COLLECTION, docId)
  if (!issued) throw new AttestationError(`revokeAttestation: attestation '${docId}' not found (was it issued by this vault?).`)
  await mutateSet(ctx, (ids) => ids.add(docId))
}

export async function unrevokeDocCore(ctx: RevokeContext, docId: string): Promise<void> {
  requireOwner(ctx, 'unrevokeAttestation')
  await mutateSet(ctx, (ids) => ids.delete(docId))
}

export async function getRevokedDocIdsCore(ctx: RevokeContext): Promise<string[]> {
  const dek = await ctx.getDEK()
  const { docIds } = await readSet(ctx.store, ctx.vault, dek)
  return [...docIds].sort()
}

export async function publishRevocationListCore(ctx: RevokeContext): Promise<RevocationList> {
  requireOwner(ctx, 'publishRevocationList')
  const docIds = await getRevokedDocIdsCore(ctx)
  const signer = await loadOrCreateSigner(ctx.store, ctx.vault, () => ctx.getDEK())
  return signRevocationList(docIds, new Date().toISOString(), signer.keyId, signer.privateKeyPkcs8B64)
}
```
Notes: confirm `ConflictError` is exported from `packages/hub/src/errors.ts` (it is — the test imports it from there). `loadOrCreateSigner(store, vault, getDEK)` is the SINGLE signer impl; `() => ctx.getDEK()` ignores the collection arg and returns the already-resolved `_attestations` DEK (same pattern as `issue.ts`).

- [ ] **Step 5: Run the test, verify it PASSES (8 tests)**

Run: `cd packages/hub && npx vitest run __tests__/attestation-revoke.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && npx tsc -p packages/hub/tsconfig.json --noEmit
git add packages/hub/src/attestation/signer.ts packages/hub/src/attestation/revoke.ts packages/hub/__tests__/attestation-revoke.test.ts
git commit -m "feat(hub/attestation): revocation core — revoke/unrevoke/getRevoked/publish

Owner-only revoke core tracking the revoked set in an encrypted
_attestations/_revoked record (read-modify-write, optimistic _v + one retry),
and publishRevocationListCore signing it with the firm's existing signer
(same keyId as issued docs). Whole-doc revoke only."
```

---

## Task 2: Vault methods + barrel exports

**Files:** modify `packages/hub/src/vault.ts`, `packages/hub/src/attestation/index.ts`; test `packages/hub/__tests__/attestation-revoke-vault.test.ts`.

Anchors (verify by grep — line numbers drift): `issueAttestation` at `vault.ts:~1151`, `makeIssueContext` immediately after it; the top-of-file type import `import type { AttestationFieldSchema } from '@noy-db/attestation'` and `import type { IssueContext } from './attestation/issue.js'`; `this.keyring.role`, `this.adapter`, `this.name`, `private getDEK` (arrow-bound).

- [ ] **Step 1: Write the failing integration test `packages/hub/__tests__/attestation-revoke-vault.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { verifyRevocationList, isRevoked, type AttestationFieldSchema } from '@noy-db/attestation'
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

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}

async function ownerVault() {
  const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-passphrase-2026' })
  const vault = await db.openVault('books')
  await vault.collection<Invoice>('invoices', { attestation }).put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1', total: 1234.5, issueDate: '2026-05-29' })
  return vault
}

describe('vault revocation (integration)', () => {
  it('revoke → publish → the signed list verifies + reports the docId revoked', async () => {
    const vault = await ownerVault()
    const { docId, keyId } = await vault.issueAttestation('invoices', 'inv-1')

    await vault.revokeAttestation(docId)
    expect(await vault.getRevokedDocIds()).toEqual([docId])

    const list = await vault.publishRevocationList()
    const { publicKeyB64 } = await vault.getDocumentSigningPublicKey()
    expect(list.keyId).toBe(keyId)
    expect(await verifyRevocationList(list, publicKeyB64)).toBe(true)
    expect(isRevoked(docId, list)).toBe(true)
  })

  it('unrevoke clears it; a fresh list no longer reports it revoked', async () => {
    const vault = await ownerVault()
    const { docId } = await vault.issueAttestation('invoices', 'inv-1')
    await vault.revokeAttestation(docId)
    await vault.unrevokeAttestation(docId)
    expect(await vault.getRevokedDocIds()).toEqual([])
    const list = await vault.publishRevocationList()
    expect(isRevoked(docId, list)).toBe(false)
  })

  it('revoking an un-issued docId throws', async () => {
    const vault = await ownerVault()
    await expect(vault.revokeAttestation('01JNEVERISSUED0000000000XX')).rejects.toThrow(/not found/)
  })
})
```

- [ ] **Step 2: Run the test, verify it FAILS** (`vault.revokeAttestation is not a function`)

Run: `cd packages/hub && npx vitest run __tests__/attestation-revoke-vault.test.ts`

- [ ] **Step 3: Add the type imports to `vault.ts`**

At the top of `packages/hub/src/vault.ts`, find `import type { AttestationFieldSchema } from '@noy-db/attestation'` and change it to also import `RevocationList`:
```ts
import type { AttestationFieldSchema, RevocationList } from '@noy-db/attestation'
```
Find `import type { IssueContext } from './attestation/issue.js'` and add a sibling line after it:
```ts
import type { RevokeContext } from './attestation/revoke.js'
```

- [ ] **Step 4: Add the four methods + `makeRevokeContext` to the `Vault` class**

In `packages/hub/src/vault.ts`, immediately after the `makeIssueContext()` method (which ends just before `writeExportAudit` or the next method), add:
```ts
  async revokeAttestation(docId: string): Promise<void> {
    const { revokeDocCore } = await import('./attestation/revoke.js')
    await revokeDocCore(this.makeRevokeContext(), docId)
  }

  async unrevokeAttestation(docId: string): Promise<void> {
    const { unrevokeDocCore } = await import('./attestation/revoke.js')
    await unrevokeDocCore(this.makeRevokeContext(), docId)
  }

  async getRevokedDocIds(): Promise<string[]> {
    const { getRevokedDocIdsCore } = await import('./attestation/revoke.js')
    return getRevokedDocIdsCore(this.makeRevokeContext())
  }

  async publishRevocationList(): Promise<RevocationList> {
    const { publishRevocationListCore } = await import('./attestation/revoke.js')
    return publishRevocationListCore(this.makeRevokeContext())
  }

  private makeRevokeContext(): RevokeContext {
    const adapter = this.adapter, vaultName = this.name, getDEK = this.getDEK
    return {
      store: adapter,
      vault: vaultName,
      role: this.keyring.role,
      getDEK: async () => getDEK('_attestations'),
    }
  }
```
(`this.getDEK` is an arrow-bound property — detaching it is safe, same as `makeIssueContext`. If tsc objects to the `RevocationList`/`RevokeContext` type usage, confirm the two import lines in Step 3 landed.)

- [ ] **Step 5: Add the barrel exports in `packages/hub/src/attestation/index.ts`**

After the `export { ATTESTATIONS_COLLECTION } from './signer.js'` line, add:
```ts
export { revokeDocCore, unrevokeDocCore, getRevokedDocIdsCore, publishRevocationListCore } from './revoke.js'
export type { RevokeContext } from './revoke.js'
```
And in the `@noy-db/attestation` re-export line, add `type RevocationList`:
```ts
export { verifyAttestation, decodeQr, verifyRevocationList, isRevoked, signRevocationList, type QrPayload, type AttestationFieldSchema, type VerifyResult, type VerifyInput, type RevocationList } from '@noy-db/attestation'
```
(Adding `signRevocationList` to the re-export is harmless and lets the verifier-side consume the primitive; if you prefer minimal surface, you may omit it — but DO add `type RevocationList`.)

- [ ] **Step 6: Run the integration test + the core test — both pass**

Run: `cd packages/hub && npx vitest run __tests__/attestation-revoke-vault.test.ts __tests__/attestation-revoke.test.ts`
Expected: ALL pass (3 integration + 8 core).

- [ ] **Step 7: Typecheck + commit**
```bash
cd /Users/vicio/_github/noy-db && npx tsc -p packages/hub/tsconfig.json --noEmit
git add packages/hub/src/vault.ts packages/hub/src/attestation/index.ts packages/hub/__tests__/attestation-revoke-vault.test.ts
git commit -m "feat(hub/attestation): vault.revokeAttestation/unrevoke/getRevoked/publishRevocationList

Owner-only vault methods adapting the revoke core; getRevokedDocIds is an
ungated read. Barrel re-exports the revoke surface + the RevocationList type.
Published list verifies under getDocumentSigningPublicKey's key."
```

---

## Task 3: Showcase + features.yaml + full gate

**Files:** create `showcases/src/89-attestation-revocation.showcase.test.ts`; modify `features.yaml`.

- [ ] **Step 1: Confirm the next free showcase number**

Run: `ls showcases/src/*.showcase.test.ts | grep -oE '/[0-9]+-' | tr -d '/-' | sort -n | tail -1`
Expected: `88`. So use `89`. If it prints something ≥89, use the next free integer and adjust the filename + features.yaml id/path accordingly.

- [ ] **Step 2: Write `showcases/src/89-attestation-revocation.showcase.test.ts`**
```ts
/**
 * Showcase 89 — Document attestation: revocation publishing
 *
 * The firm issues a signed attestation, then withdraws it. It publishes a
 * signed revocation list (vault is source of truth; the firm never touches raw
 * keys). A third party verifying OFFLINE — bundling that list — now sees the
 * document as authentic-but-revoked, not valid.
 *
 * Prerequisites: 00 (hello vault). Builds on the @noy-db/hub/attestation issue
 * side and the @noy-db/recipe-attestation-verifier offline verifier (recipe).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { verifyDocument } from '@noy-db/recipe-attestation-verifier'
import type { AttestationFieldSchema } from '@noy-db/attestation'

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}

describe('showcase 89: attestation revocation', () => {
  it('issue → authentic-valid; revoke + publish → authentic-revoked offline', async () => {
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-pass-2026' })
    const vault = await db.openVault('books')
    await vault.collection<Invoice>('invoices', { attestation }).put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' })

    const { docId, qr, keyId } = await vault.issueAttestation('invoices', 'inv-1')
    const { publicKeyB64 } = await vault.getDocumentSigningPublicKey()
    const printed = { invoiceNo: 'INV-1042', total: '1234.50', issueDate: '2026-05-29' }

    // Before revocation: a third party verifies offline → authentic & valid.
    const before = await verifyDocument(qr, printed, { publicKeys: { [keyId]: publicKeyB64 }, fieldSchema: attestation })
    expect(before.outcome).toBe('authentic-valid')

    // The firm withdraws the document and publishes the signed revocation list.
    await vault.revokeAttestation(docId)
    const revocationList = await vault.publishRevocationList()

    // The verifier bundles that list (served at a stable URL) → authentic-revoked.
    const after = await verifyDocument(qr, printed, { publicKeys: { [keyId]: publicKeyB64 }, fieldSchema: attestation, revocationList })
    expect(after.outcome).toBe('authentic-revoked')
  })
})
```
NOTE: this reuses the store-bootstrap idiom (`memory()` from `@noy-db/to-memory`) and the `verifyDocument` import already wired as a `showcases` devDependency by ④. If `verifyDocument`/`memory` don't resolve, confirm `showcases/package.json` lists `@noy-db/recipe-attestation-verifier` and `@noy-db/to-memory` as deps (④ added the former; the latter is already used by sibling recipes).

- [ ] **Step 3: Run the showcase**

Run: `cd showcases && npx vitest run src/89-attestation-revocation.showcase.test.ts`
Expected: PASS (1 test). If it flakes on happy-dom WebCrypto (rare; the ④ recipe test runs fine under happy-dom), add `['src/89-attestation-revocation.showcase.test.ts', 'node']` to the `environmentMatchGlobs` array in `showcases/vitest.config.ts` and re-run — and if you make that change, `git add showcases/vitest.config.ts` in Step 5.

- [ ] **Step 4: Register the showcase in `features.yaml`**

Read the `attestation` feature row (grep `id: attestation` in the `features:` section). Its `showcases:` is currently `[]`. Change it to (match the exact list-item indentation of the `transferable-partition` row's `showcases`):
```yaml
    showcases:
      - id: 89-attestation-revocation
        path: showcases/src/89-attestation-revocation.showcase.test.ts
```
Also add one line to that row's `invariants:` list:
```yaml
      - 'revocation is whole-doc: vault.revokeAttestation tracks an encrypted _attestations/_revoked set; publishRevocationList signs it with the firm key (same keyId as issued docs) — the offline verifier bundles the signed list to gate "still valid today?"'
```

- [ ] **Step 5: Validate + full gate**
```bash
cd /Users/vicio/_github/noy-db
node scripts/validate-features.mjs 2>&1 | tail -8
npx tsc -p packages/hub/tsconfig.json --noEmit
npx vitest run --project core __tests__/attestation-revoke.test.ts __tests__/attestation-revoke-vault.test.ts --reporter=dot 2>&1 | tail -6
cd showcases && npx vitest run src/89-attestation-revocation.showcase.test.ts --reporter=dot 2>&1 | tail -6
```
Expected: validator passes (showcase path resolves; the `attestation` row now has a showcase); tsc clean; the two hub attestation-revoke test files pass; the showcase passes. If the `--project core` filtered-path form errors, run `cd packages/hub && npx vitest run __tests__/attestation-revoke.test.ts __tests__/attestation-revoke-vault.test.ts` instead.

- [ ] **Step 6: Commit**
```bash
cd /Users/vicio/_github/noy-db
git add showcases/src/89-attestation-revocation.showcase.test.ts features.yaml
git commit -m "test(showcase) + docs(features): attestation revocation showcase (89)

Showcase 89 — issue → authentic-valid → revoke + publishRevocationList →
authentic-revoked, verified offline via the recipe verifier. Registers the
showcase on the attestation feature row + a revocation invariant."
```
(If you modified `showcases/vitest.config.ts` in Step 3, add it to this `git add`.)

---

## Self-Review (completed)

- **Spec coverage** (spec §1–§10): §2 file structure → File Structure table + all tasks; §3 `_attestations/_revoked` `{docIds,updatedAt}` + `REVOKED_RECORD_ID` → T1; §4 four core fns w/ owner gate, existence check, optimistic retry, empty-set-ok → T1 (impl + 8 tests); §5 four vault methods + `makeRevokeContext` (getRevokedDocIds ungated) → T2; §6 barrel exports + `type RevocationList` → T2 Step 5; §7 error handling (/owner/, /not found/, empty-ok, retry) → T1 tests + impl; §8 core unit + vault integration + showcase (non-owner in the core test per the spec's reconciled note) → T1/T2/T3; §9 YAGNI (no supersede/hosting/ledger) → respected; §10 build order → task order.
- **Placeholder scan:** none. Showcase number `89` is concrete with a Step-1 confirm-and-adjust guard (highest existing is 88).
- **Type consistency:** `RevokeContext` (`store`/`vault`/`role`/`getDEK`) defined T1, imported by `vault.ts` (T2) + re-exported (T2 Step 5); `revokeDocCore`/`unrevokeDocCore`/`getRevokedDocIdsCore`/`publishRevocationListCore` names identical across T1 impl, T1 test, T2 vault methods, T2 barrel, T3 showcase (via `vault.*`); `RevocationList` from `@noy-db/attestation` typed consistently in `revoke.ts`, `vault.ts`, the barrel, and both tests; `loadOrCreateSigner(store, vault, getDEK)` is the one signer impl, reused (not reimplemented); `signRevocationList(ids, asOf, keyId, priv)` arg order matches the shipped ①a signature.
- **Known risks:** (1) `ConflictError` must be exported from `packages/hub/src/errors.ts` (it is — used across hub) — the retry test + impl both import it from there. (2) The showcase depends on `@noy-db/recipe-attestation-verifier` + `@noy-db/to-memory` being `showcases` deps (④ added the former; the latter is used by sibling recipes) — Step 2 notes the check. (3) `vault.ts` is large — T2 anchors are by grep, edits are additive near `makeIssueContext`.
