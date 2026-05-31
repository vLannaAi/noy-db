# Document Attestation — umbrella design

**Status:** SHIPPED (preview) — all five sub-systems merged. ① pure core `@noy-db/attestation` (#235) · ①b hub issue side `@noy-db/hub/attestation` (#236) · ④ offline verifier recipe (#237) · ⑤ revocation publishing (#238) · ③ AWS-KMS HTML→PDF render recipe (#239, real-AWS verified). Post-epic hardening: magic-link share gate for ③ (#240) + Secrets-Manager deploy fix (#241), and signer hardening — owner-gated mint-on-read + concurrent-first-mint convergence (#242). This remains the cross-cutting design of record; per-sub-system specs/plans live alongside it.
**Authoring date:** 2026-05-29
**Cluster:** `time-and-audit` (beside `history` / `consent` — provenance + tamper-evidence)
**Relates to:** #197 (recipient-target sealed delivery — the `at-aws-kms` KMS path lands in sub-system ③), the ledger hash primitives (`canonicalJson`, `sha256Hex` in `history/ledger/entry.ts`)

---

## 1. Problem

An accounting firm issues documents (invoices, statements) to clients. Three needs:

1. **Render** an HTML document to a downloadable PDF. A static webapp cannot do HTML→PDF reliably client-side; server-side rendering is required.
2. **Prove authenticity + integrity** of a printed/forwarded document — that the firm issued it and it has not been altered — *without publishing any document content anywhere*.
3. **Verify** that proof from a third party's copy (the original PDF, a re-print, a phone photo, a scan) returning only a yes/no (+ per-field detail), and optionally check the document has not since been revoked.

The hard constraint: the firm must expose **no document content** on any public endpoint. A permanent "verification URL" that returns document data would violate this.

## 2. Key architectural decision — verification is offline, the commitment travels in the QR

Rather than a server-side commitment store with a verification endpoint, the **signed commitment travels inside the QR code printed on the document**. Verification is then **fully client-side and offline**:

- There is no public endpoint that holds or returns document data — so there is nothing to disclose. The "zero-knowledge" property the firm wants comes from the verifier *possessing the document* and only **hashes/signatures** ever being public.
- The HTML→PDF render service (a Lambda) is **generation-time only**. It is NOT in the verification path.

**Integrity is not authenticity.** A plain (or symmetric-"encrypted") hash in the QR proves only that the visible fields are self-consistent with the QR — a forger can fabricate a fake document, hash *its* fields, and print *their own* matching QR. The fix is a **digital signature**: the QR carries `sign(firm_private_key, commitment)`, checked against the firm's **public** key. A forger cannot produce a valid signature without the private key. Symmetric encryption cannot deliver public verifiability (the verifier would need the secret, which would leak), so the primitive is an **asymmetric signature**, not encryption.

**Threat model (chosen):** forgery-resistant signed QR, verified offline, **plus** a signed revoked-`docId` list for "still valid today?" checks. Revocation is the one capability an offline QR cannot provide on its own; the published list reveals only opaque ULIDs (zero document disclosure).

## 3. Cross-cutting contracts

These are the contracts every sub-system must agree on. Locking them is the purpose of this umbrella.

### 3.1 docId
A ULID minted per **issued document** (a document may render from several records). The vault stores `docId → { sourceRefs: [{collection, id, version}], issuedAt, keyId }` in a plaintext-bypass `_attestations` collection (auditor-readable, like `_ledger`; see plaintext-bypass.md — adding it is a SPEC change and this umbrella is that spec). The docId is the anchor every other contract references.

### 3.2 Commitment
```
C = sha256Hex( salt ‖ canonicalJson(orderedFields) )
```
- `salt` — 16 random bytes minted per document, printed in the QR.
- `orderedFields` — the field values extracted per the collection's **verification field-schema** (§3.4), in declared order, each run through its per-field normalizer.
- `canonicalJson` and `sha256Hex` — **reused verbatim** from `packages/hub/src/history/ledger/entry.ts`. Consistency with the ledger; already battle-tested.

The commitment is **never** placed in the QR and **never** published. The verifier *recomputes* it from the visible document + the salt. This binds verification to possessing the document.

### 3.3 Signature
```
sig = Ed25519_sign( firmDocSigningPrivKey, C )
```
- **Ed25519** — 64-byte signature, compact enough for a low-density QR. (RSA-PSS would be 256 bytes → denser QR; Ed25519 chosen for size. Pluggable — see §3.7.)
- The firm's **document-signing keypair** is a new vault primitive: the private key is wrapped under the owner KEK and stored in the keyring beside the DEKs; the public key is published with a `keyId`.

### 3.4 Verification field-schema (per collection)
Declared per collection, alongside the existing `schema`/`refs`:
```ts
collection('invoices', {
  schema: InvoiceSchema,
  attestation: {
    fields: [
      { path: 'invoiceNo',    normalize: 'trim' },
      { path: 'total',        normalize: 'cents' },     // 1234.50 → "123450"
      { path: 'issueDate',    normalize: 'iso-date' },  // → "2026-05-29"
      { path: 'vatAmount',    normalize: 'cents' },
      { path: 'issuerTaxId',  normalize: 'alnum-upper' },
    ],
  },
})
```
Field choice favours **OCR-stable, high-signal** values (numbers, ids, dates) over free text. Normalizers are a closed, declared set so issue-time and verify-time canonicalization are identical regardless of source format.

### 3.5 QR payload
```
{ v: 1, docId, salt, alg: 'ed25519', keyId, sig }
```
base45-encoded for QR. ~100 bytes → comfortably scannable (~QR version 6–8). Contains **no commitment and no field values** — only what the verifier needs to recompute-and-check given the document in hand.

### 3.6 Public-key distribution + rotation
The firm publishes `{ keyId → publicKey }`. A static verifier **bundles the current public key(s) at build time** (most trustworthy — no fetch-time trust anchor) or fetches a **signed** key-list. The `keyId` in the QR selects the key, so rotating the signing key does not break previously issued documents (retain old public keys). Key rotation = a verifier app update or a re-published signed key-list.

### 3.7 Pluggable signer (extension point, not built in v1)
The signing operation is modeled behind a `DocumentSigner` interface (default: in-process Ed25519). A future KMS-backed signer (`at-aws-kms` asymmetric Sign/Verify) plugs in here — the same way `SealingKeyProvider` is pluggable. v1 ships only the in-process Ed25519 signer; the interface is defined so the KMS variant is an additive follow-up.

### 3.8 Revocation list
The firm signs and publishes `{ revokedDocIds: ULID[], asOf: ISO, sig }`. The verifier fetches it (cacheable; offline-capable with a cached copy, staleness bounded by cache TTL), checks the **firm's signature** on the list, then checks membership. Reveals only opaque ULIDs + that they are revoked — zero document disclosure.

## 4. Sub-systems

| # | Sub-system | Home | Depends on |
|---|---|---|---|
| **①a** | **Pure attestation core** — commitment formula, canonicalization, normalizers, Ed25519 sign+verify, QR payload codec, revocation format + `isRevoked()` | `@noy-db/attestation` (NEW unprefixed package, zero-dep, hub-free — `on-shamir`-style) | nothing |
| **①b** | **Issue side (vault-coupled)** — docId mint + `_attestations` record, per-collection field-schema reading, KEK-wrapped signing key in the keyring, `issueAttestation(record) → {docId, salt, sig, keyId}` | `@noy-db/hub/attestation` (NEW hub subpath subsystem, like `bundle`/`history`) | `@noy-db/attestation`, hub keyring |
| **②** | **QR codec** | folds **into** `@noy-db/attestation` (owns the payload byte-contract); QR *image drawing* is app-side | — |
| **③** | **HTML→PDF render Lambda** — KMS-decrypt S3 doc, render HTML→PDF, embed ②'s QR, return download | `recipes/aws-kms-pdf-attestation/` (NEW recipes dir; deployable reference app, not published) + a showcase | `@noy-db/hub`, `@noy-db/to-aws-s3`, `@noy-db/at-aws-kms`, `@noy-db/attestation` |
| **④** | **Offline verifier** — read QR + extract fields → recompute commitment → check sig vs. bundled public key → check ⑤ | a showcase + a `recipes/` snippet; consumes **only** `@noy-db/attestation` | `@noy-db/attestation` |
| **⑤** | **Revocation** — format + `isRevoked()` are pure (in `@noy-db/attestation`); publish glue in the recipe/app | `@noy-db/attestation` + app | `@noy-db/attestation` |

### Packaging footprint (the whole feature)
- **1 new package:** `@noy-db/attestation` (pure primitive).
- **1 new hub subpath:** `@noy-db/hub/attestation` (subsystem).
- **1 new `recipes/` directory:** `recipes/aws-kms-pdf-attestation/` (first recipe).
- **N showcases** in the existing `showcases/`.
- **0 new prefix-family members.** Nothing in `to-/in-/on-/as-/by-/at-`. The KMS work *extends* the existing `at-aws-kms` package.

Rationale: attestation is a **core verb of the engine** (issue/verify), like `history`/`consent`/`bundle` — those are hub subsystems, not prefixed packages. The six prefix families are **peripheral slots** (storage / runtime / identity / export-format / key-custodian / session-transport); none describe a core primitive. The pure core is split out as one package only because **verification must run hub-free** in a static page — the exact precedent set by `on-shamir` (pure Shamir math in the package, recovery orchestration in hub).

## 5. End-to-end data flow

**Issue (server / firm side):**
1. `issueAttestation(record)` mints `docId`, reads the collection's `attestation.fields`, extracts + normalizes the field values, mints a 16-byte `salt`.
2. Computes `C = sha256Hex(salt ‖ canonicalJson(orderedFields))`.
3. Unwraps the firm signing private key under the owner KEK; `sig = Ed25519_sign(privKey, C)`.
4. Writes the `_attestations/<docId>` record `{ sourceRefs, issuedAt, keyId }`.
5. Returns `{ docId, salt, sig, keyId }`.

**Render (③, Lambda, generation-time):**
6. Lambda KMS-decrypts the S3-stored document, renders HTML→PDF, draws the QR from `{v,docId,salt,alg,keyId,sig}`, returns the PDF download.

**Verify (④, client, offline):**
7. Verifier extracts the same fields off their copy (typed, or vision-assisted client-side), normalizes identically, recomputes `C'`.
8. Decodes the QR → `{docId, salt, alg, keyId, sig}`; checks `Ed25519_verify(pubKey[keyId], sig, C')`.
9. (optional) Fetches the signed revocation list, checks `!isRevoked(docId)`.
10. Result: `{ valid, perField, revoked }`.

## 6. Build order

`①a (pure core)` → `①b (issue side)` → `②` folds into ①a → (`④ verifier` + `⑤ revocation` in parallel) → `③ render recipe` (needs ①a, ①b, at-aws-kms).

**First sub-spec:** ①a + ①b together (the `attestation` package + hub subsystem). It is the spine, fully library-side, no AWS/PDF/QR dependency, unit-testable end to end (issue → QR payload → verify → revoke) with in-process keys.

## 7. Explicitly out of scope (this umbrella)

- Server-side commitment store / verification endpoint (superseded by the offline-QR design).
- Storing documents anywhere public (only signatures-in-QR and opaque revoked-ids are ever public).
- Cryptographic ZKP (zk-SNARK et al.) — this is a commitment + signature scheme.
- KMS-backed `DocumentSigner` — extension point defined (§3.7), implementation deferred to an `at-aws-kms` follow-up.
- In-browser vision extraction — v1 verifier assumes manual field entry; vision is an additive client enhancement producing the same hash.
- The actual QR *image* rendering library choice and the headless-Chromium Lambda layer — recipe-level decisions, made in ③'s spec.

## 8. Open questions for the sub-specs (not blocking the umbrella)

- ①: exact `_attestations` record shape + its plaintext-bypass catalog entry; the closed normalizer set; how `sourceRefs` pin record versions.
- ①: whether the signing keypair is minted at owner-creation or lazily on first `issueAttestation`.
- ②: base45 vs. base64url for the QR payload; CBOR vs. compact-JSON before encoding.
- ③: headless-Chromium layer vs. a JS PDF lib; QR-drawing library; IAM least-privilege for the Lambda.
- ⑤: revocation-list hosting + cache strategy; whether to support per-field "supersede" vs. whole-doc revoke.
