# Document Attestation — ⑤ Revocation Publishing design

**Status:** sub-system spec (⑤ of the document-attestation umbrella) → ready for plan
**Date:** 2026-05-30
**Relates to:** umbrella `docs/superpowers/specs/2026-05-29-document-attestation-umbrella-design.md` §3.8/§4/§8; issue side `docs/superpowers/specs/2026-05-29-attestation-core-and-issue-design.md`; verifier `docs/superpowers/specs/2026-05-29-attestation-verifier-design.md`. Depends on the merged `@noy-db/attestation` (①a, #235) and `@noy-db/hub/attestation` (①b, #236). The offline verifier (④, #237) consumes the published list.

## 1. Goal

Let the firm **revoke an issued document and publish a signed revocation list** — answering "is this docId still valid today?" — without ever handling raw signing-key material. The pure format + sign + verify + membership all shipped in ①a (`RevocationList`, `signRevocationList`, `verifyRevocationList`, `isRevoked`). ④ surfaced the gap this slice closes: **signing a revocation list needs the firm's private key, which the hub deliberately does not expose** (`getDocumentSigningPublicKey` returns only the public key). ⑤ adds the owner-only hub API that tracks revocation state in the vault and signs the list with the firm's existing signer — so the published list verifies under the **same public key** as issued documents.

**Decisions locked in brainstorming:** the vault is the **source of truth** (stateful `revokeAttestation`/`publishRevocationList`, not a thin signing oracle); scope is **hub API + a showcase** (hosting the bytes is documented, not coded — the firm serves the signed JSON at a stable URL); the revoked set is stored as a **single encrypted `_attestations/_revoked` record** (Approach A); **whole-doc revoke only** (no per-field supersede).

## 2. Architecture

Extends the existing `@noy-db/hub/attestation` subsystem (issue side) with the revocation-publishing side. A new store-injected core `packages/hub/src/attestation/revoke.ts` (mirrors `issue.ts`'s testability seam) holds the revoked-set read/modify/write + the publish-signing. `vault.ts` adds four owner-only methods that adapt the vault's internals into the core's context. Publishing reuses the **same** `loadOrCreateSigner` from `signer.ts` (the firm's existing signer) — one signer implementation, and the published list's `keyId` matches issued documents. **No new feature row** in `features.yaml`; ⑤ rounds out the existing `attestation` feature.

| File | Action | Responsibility |
|---|---|---|
| `packages/hub/src/attestation/revoke.ts` | Create | `RevokeContext` + `revokeDocCore`/`unrevokeDocCore`/`getRevokedDocIdsCore`/`publishRevocationListCore` |
| `packages/hub/src/attestation/signer.ts` | Modify | export `REVOKED_RECORD_ID = '_revoked'` (alongside the existing constants) |
| `packages/hub/src/vault.ts` | Modify | `revokeAttestation` / `unrevokeAttestation` / `getRevokedDocIds` / `publishRevocationList` |
| `packages/hub/src/attestation/index.ts` | Modify | export the `revoke.ts` surface + ensure `type RevocationList` is re-exported |
| `packages/hub/__tests__/attestation-revoke.test.ts` | Create | core unit tests |
| `packages/hub/__tests__/attestation-revoke-vault.test.ts` | Create | vault integration test |
| `showcases/src/<NN>-attestation-revocation.showcase.test.ts` | Create | issue → revoke → publish → verify reports authentic-revoked |
| `features.yaml` | Modify | register the showcase on the `attestation` feature row + a revocation invariant |

## 3. Storage

One encrypted record `_attestations/_revoked`, same `EncryptedEnvelope` shape + `_attestations` collection DEK as `_signer` and the per-doc index records. Decrypted payload:
```ts
interface RevokedSet { docIds: string[]; updatedAt: string }   // updatedAt = ISO
```
New exported constant in `signer.ts`: `export const REVOKED_RECORD_ID = '_revoked'`. (`ATTESTATIONS_COLLECTION` / `SIGNER_RECORD_ID` already live there.)

## 4. Core (`packages/hub/src/attestation/revoke.ts`)

```ts
export interface RevokeContext {
  readonly store: NoydbStore
  readonly vault: string
  readonly role: string
  getDEK(): Promise<CryptoKey>   // the _attestations collection DEK
}
```

- **`revokeDocCore(ctx, docId)`** — owner-only (`role !== 'owner'` → `AttestationError` /owner/). Verifies `_attestations/<docId>` exists (`ctx.store.get`) — else `AttestationError` /not found/ (guards typos; can't revoke an un-issued doc). Then **read-modify-write** the `_revoked` set: read the record (or start empty), add `docId` (Set semantics — idempotent), write back. **Optimistic concurrency:** pass the read envelope's `_v` as `expectedVersion`; on `ConflictError`, re-read once and retry. Returns `void`.
- **`unrevokeDocCore(ctx, docId)`** — owner-only. Same read-modify-write, removing `docId` (no-op if absent). Returns `void`.
- **`getRevokedDocIdsCore(ctx)`** — reads the set; returns `string[]` (empty array if no record yet). No role gate (reading own revocation state).
- **`publishRevocationListCore(ctx)`** — owner-only. Reads the set; `loadOrCreateSigner(ctx.store, ctx.vault, () => ctx.getDEK())`; returns `signRevocationList(docIds, new Date().toISOString(), signer.keyId, signer.privateKeyPkcs8B64)`. An empty set yields a valid signed empty list (not an error).

All four resolve the `_attestations` DEK via `ctx.getDEK()` and use `encrypt`/`decrypt` from `crypto.ts` + `NOYDB_FORMAT_VERSION` envelopes (the `issue.ts`/`signer.ts` pattern). `loadOrCreateSigner` is the single signer impl — no second keypair logic.

## 5. Vault methods (`vault.ts`, mirroring `issueAttestation`)

```ts
async revokeAttestation(docId: string): Promise<void>     // owner-only
async unrevokeAttestation(docId: string): Promise<void>   // owner-only
async getRevokedDocIds(): Promise<string[]>               // read — not gated
async publishRevocationList(): Promise<RevocationList>    // owner-only
```
`revokeAttestation`/`unrevokeAttestation`/`publishRevocationList` are owner-only (enforced in the core via `ctx.role`); `getRevokedDocIds` is an ungated read of the firm's own revocation state (the set is about to be published anyway). Each lazily `await import('./attestation/revoke.js')` and builds a `RevokeContext` from `this.adapter` (store), `this.name` (vault), `this.keyring.role` (role), and `getDEK: async () => this.getDEK('_attestations')` — the same adapter pattern as `makeIssueContext`. `RevocationList` is imported as a type from `@noy-db/attestation`.

## 6. Subpath barrel (`packages/hub/src/attestation/index.ts`)

Add: `export { revokeDocCore, unrevokeDocCore, getRevokedDocIdsCore, publishRevocationListCore } from './revoke.js'` and `export type { RevokeContext } from './revoke.js'`. Ensure `type RevocationList` is in the `@noy-db/attestation` re-export line (it currently re-exports `verifyRevocationList`/`isRevoked` but not the `RevocationList` type) so consumers can type `publishRevocationList`'s return.

## 7. Error handling

- `revokeAttestation` / `unrevokeAttestation` / `publishRevocationList` by a non-owner → `AttestationError` (message matching `/owner/`).
- `revokeAttestation(docId)` for a docId with no `_attestations/<docId>` record → `AttestationError` (message matching `/not found/`).
- `publishRevocationList()` with an empty revoked set → a valid signed `RevocationList` with `revokedDocIds: []` (success, not an error).
- Concurrent `revokeAttestation` → optimistic `_v` guard + one re-read-and-retry; a second conflict surfaces the `ConflictError` (documented; owner-single-writer makes this rare).

## 8. Testing

**Core unit — `packages/hub/__tests__/attestation-revoke.test.ts`** (hub `core` vitest project, in-memory `NoydbStore` helper copied from `attestation-issue.test.ts`, a real DEK via `generateDEK`):
- revoke adds the docId; revoking twice is idempotent (set stays size 1).
- `getRevokedDocIdsCore` reflects the current set.
- `unrevokeDocCore` removes it (and is a no-op when absent).
- revoke of a docId with no `_attestations/<docId>` record → throws `/not found/`.
- non-owner `revokeDocCore`/`publishRevocationListCore` → throws `/owner/`.
- `publishRevocationListCore` → the returned list passes `verifyRevocationList(list, signerPublicKey)` and `isRevoked(docId, list) === true`; an empty set → `verifyRevocationList` true and `isRevoked` false.
- concurrent first-revoke race: two interleaved `revokeDocCore` calls (against a store whose `put` enforces `expectedVersion`) both end up in the set (retry path), no lost write.

**Vault integration — `packages/hub/__tests__/attestation-revoke-vault.test.ts`** (real `createNoydb` owner vault, in-memory store, `invoices` collection declared with an `attestation` schema):
- issue `inv-1` → `revokeAttestation(docId)` → `publishRevocationList()` → `verifyRevocationList(list, (await getDocumentSigningPublicKey()).publicKeyB64) === true`, `isRevoked(docId, list) === true`, and `list.keyId === keyId` from the issue result.
- `getRevokedDocIds()` returns `[docId]`; after `unrevokeAttestation(docId)`, returns `[]` and a freshly published list has `isRevoked(docId) === false`.
- (Role-gating is proven in the core unit test via a `role: 'admin'` context — building a non-owner *vault session* needs full team/delegation setup, which is out of proportion for this slice; the vault methods pass `this.keyring.role` straight to the core gate, so the core test is the authority.)

**Showcase — `showcases/src/<NN>-attestation-revocation.showcase.test.ts`** (next free showcase number; reuses ④'s `verifyDocument` from `@noy-db/recipe-attestation-verifier` to close the loop):
- issue an attestation; `verifyDocument(qr, fields, { publicKeys, fieldSchema })` → `authentic-valid`.
- `vault.revokeAttestation(docId)`; `const list = await vault.publishRevocationList()`.
- `verifyDocument(qr, fields, { publicKeys, fieldSchema, revocationList: list })` → `authentic-revoked`.
- (Narrates: the firm publishes `list` as JSON at a stable URL; the verifier bundles/loads that snapshot. Hosting itself is out of scope per §9.)

## 9. Scope (YAGNI)

**In:** the four vault methods + `revoke.ts` core + the `_revoked` record + barrel exports + core/integration tests + one showcase + the `features.yaml` showcase registration.
**Out:** per-field "supersede"/reissue (whole-doc revoke only — matches the shipped `RevocationList`); hosting/upload code (documented only — the firm serves the signed bytes from any static host/CDN; cache/staleness is bounded by how often they republish, communicated via the list's `asOf`); a revocation history/ledger (the set is current-state only); auto-republish scheduling; a fetch-based verifier (④ bundles a snapshot at build time); exposing the raw `signRevocationList` primitive on the hub surface (the firm uses `publishRevocationList`, never raw keys).

## 10. Build order within the slice

1. `signer.ts` `REVOKED_RECORD_ID` + `revoke.ts` core (`revokeDocCore`/`unrevokeDocCore`/`getRevokedDocIdsCore`/`publishRevocationListCore`) via TDD against the core unit test.
2. `vault.ts` four methods + barrel exports, via the vault integration test.
3. The showcase + `features.yaml` registration + full gate (`tsc`, hub suite, `validate-features`, turbo).
