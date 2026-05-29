# Attestation core + issue side — sub-spec ① (the spine)

**Status:** sub-spec (ready for plan), under [document-attestation umbrella](2026-05-29-document-attestation-umbrella-design.md)
**Authoring date:** 2026-05-29
**Covers:** ①a `@noy-db/attestation` (pure, hub-free package) + ①b `@noy-db/hub/attestation` (vault-coupled issue side)
**Out of this sub-spec:** HTML→PDF Lambda (③), QR *image* rendering (③/app), revocation-list *publishing/hosting* (⑤/app), in-browser vision extraction (④ enhancement). The pure revocation *check* IS in scope (it's pure).

---

## 1. Scope

Two units, tightly coupled by a one-way dependency (`hub → attestation`):

- **①a `@noy-db/attestation`** — pure, zero-runtime-dependency package (the `on-shamir` precedent). Owns the cryptographic + format contracts: commitment formula, normalizers, per-field hashing, Ed25519 sign/verify, QR payload codec, revocation format + check. Runs in any runtime (Node, browser) with no vault. The static verifier (④) imports **only** this.
- **①b `@noy-db/hub/attestation`** — hub subpath subsystem (like `bundle`/`history`). The vault-coupled *issue* side: reads a collection's declared field-schema, extracts + normalizes the record's field values, mints `docId` + `salt`, computes per-field hashes via ①a, lazily mints + KEK-wraps the Ed25519 signing key in the keyring, signs via ①a, persists an encrypted `_attestations/<docId>` index record, returns the QR string.

## 2. Decisions made in this sub-spec (flag on review)

1. **Per-field commitment (not whole-document).** The QR carries one salted hash per committed field + one signature over the set. Enables offline "which field differs" localization. Cost: denser QR (~250 B for 5 fields). *Lighter alternative:* a single whole-document hash (~100 B QR, no localization). **Chosen: per-field**, matching the umbrella's `perField` result and the firm's dispute-resolution need.
2. **Ed25519 via WebCrypto** (zero-dep; Node 20 + modern browsers). *Caveat:* Ed25519 in browser WebCrypto requires recent versions (Chrome 137+, Safari 17+, Firefox 129+). *Fallback if legacy browsers matter:* add `@noble/ed25519` (one tiny audited dep) behind the same internal signer interface. **Chosen: WebCrypto**, documented min-browser; fallback noted.
3. **`_attestations` record is ENCRYPTED, not a plaintext bypass** (corrects umbrella §3.1). It is the firm's private index of issued documents, read only by the firm with their own keyring — there is no pre-auth or third-party-auditor reader (verification is offline via the QR, never touches this record). So it uses a normal collection DEK and needs **no** plaintext-bypass.md catalog entry.
4. **`canonicalJson`/`sha256Hex` replicated** in ①a (hub-free) with a conformance test against fixed vectors. No import from hub; no change to the ledger.

## 3. `@noy-db/attestation` (①a) — pure package

### 3.1 Types
```ts
export type Normalizer = 'trim' | 'lower' | 'upper' | 'alnum-upper' | 'digits' | 'cents' | 'iso-date'

export interface AttestationFieldSpec {
  readonly path: string          // dot-path into the record, e.g. 'total' or 'issuer.taxId'
  readonly normalize: Normalizer
}
export interface AttestationFieldSchema {
  readonly fields: readonly AttestationFieldSpec[]   // ORDER IS PART OF THE CONTRACT
}

export interface QrPayload {
  readonly v: 1
  readonly docId: string                 // ULID
  readonly salt: string                  // base64url, 16 bytes
  readonly alg: 'ed25519'
  readonly keyId: string
  readonly fieldHashes: readonly string[]  // base64url sha256, one per field, in schema order
  readonly sig: string                   // base64url Ed25519 over the signed core (§3.4)
}

export interface RevocationList {
  readonly v: 1
  readonly revokedDocIds: readonly string[]   // sorted ULIDs
  readonly asOf: string                       // ISO-8601
  readonly keyId: string
  readonly sig: string                        // base64url Ed25519 over canonicalJson({v,revokedDocIds,asOf,keyId})
}

export interface VerifyInput {
  readonly qr: string                                   // scanned QR string (decoded via decodeQr)
  readonly claimedFields: Record<string, unknown>       // values read off the verifier's copy
  readonly fieldSchema: AttestationFieldSchema          // must match issue-time (verifier-configured)
  readonly publicKeys: Readonly<Record<string, string>> // keyId → base64url raw Ed25519 public key
  readonly revocation?: { list: RevocationList }        // optional "still valid?" check
}
export interface VerifyResult {
  readonly valid: boolean                               // signatureValid && allFieldsMatch && !revoked
  readonly signatureValid: boolean
  readonly perField: ReadonlyArray<{ path: string; match: boolean }>
  readonly revoked: boolean | null                      // null when no revocation list supplied
  readonly reason?: string                              // populated on the first failing gate
}
```

### 3.2 Commitment & per-field hashing
```
fieldHash[i] = sha256Hex( canonicalJson([ salt_b64, fields[i].path, normalize(value[i], fields[i].normalize) ]) )  → base64url
```
- Domain-separated by `path` so two fields with equal values get distinct hashes.
- Per-document random `salt` defeats brute-force of low-entropy fields (e.g. an amount) and cross-document correlation.
- `normalize` is the **closed set** (§3.3) so issue-time and verify-time produce byte-identical inputs regardless of source format.

### 3.3 Normalizers (closed set)
| name | rule |
|---|---|
| `trim` | `String(v).trim()` |
| `lower` | `trim` then lowercase |
| `upper` | `trim` then uppercase |
| `alnum-upper` | strip non-`[A-Za-z0-9]`, uppercase (tax-ids, doc numbers) |
| `digits` | strip non-`[0-9]` (phone, account no.) |
| `cents` | parse number, `Math.round(n*100)`, integer string — `1234.50` → `"123450"` (money, OCR-robust to thousands separators when paired with client pre-strip) |
| `iso-date` | parse to `YYYY-MM-DD` (UTC), throw on unparseable |

Unknown normalizer → throw at schema-validation time (fail fast, not silent).

### 3.4 Signed core + signature
```
signedCore = canonicalJson({ v, docId, salt, keyId, fieldHashes })   // NOTE: excludes sig
sig        = base64url( Ed25519_sign(privKey, utf8(signedCore)) )
```
`docId` is inside the signed core, so a signature cannot be transplanted to another document. The commitment (set of fieldHashes) is what's signed — the verifier proves authenticity by re-deriving `signedCore` from the QR's own fields and checking the signature; it proves integrity by recomputing each `fieldHash` from the document and comparing.

### 3.5 Public API (pure functions)
```ts
export function validateFieldSchema(s: AttestationFieldSchema): void          // closed-normalizer check
export function normalizeField(value: unknown, n: Normalizer): string
export async function computeFieldHashes(saltB64: string, schema: AttestationFieldSchema, values: Record<string, unknown>): Promise<string[]>
export async function signPayloadCore(core: Omit<QrPayload,'sig'|'alg'>, privKeyPkcs8B64: string): Promise<string>  // → sig
export function encodeQr(p: QrPayload): string                                // compact-JSON → base64url
export function decodeQr(s: string): QrPayload                                // + structural validation
export async function verifyAttestation(input: VerifyInput): Promise<VerifyResult>
export async function generateDocSigningKeyPair(): Promise<{ keyId: string; publicKeyB64: string; privateKeyPkcs8B64: string }>
export function isRevoked(docId: string, list: RevocationList): boolean
export async function verifyRevocationList(list: RevocationList, publicKeyB64: string): Promise<boolean>
```
- `keyId = sha256Hex(publicKeyB64).slice(0,16)` (stable, collision-safe enough for key selection).
- Internal helpers (not exported): `canonicalJson`, `sha256Hex`, `bytesToHex`, `base64url` enc/dec, `ed25519Sign`/`ed25519Verify` (WebCrypto). All zero-dep.
- **Encoding (v1):** compact JSON → base64url (universal, debuggable). *Density follow-up (noted, not built):* CBOR + base45 to exploit QR alphanumeric mode.

### 3.6 `verifyAttestation` algorithm
1. `decodeQr(qr)` → payload (structural + version check; reject `v !== 1`).
2. Re-derive `signedCore` from the payload; `signatureValid = ed25519Verify(publicKeys[payload.keyId], payload.sig, signedCore)`. Missing keyId → `signatureValid=false`, reason `"unknown keyId"`.
3. For each `fields[i]`: `expected = payload.fieldHashes[i]`; `actual = computeFieldHashes(payload.salt, schema, claimedFields)[i]`; `perField[i] = { path, match: expected===actual }`. Length mismatch between schema and `fieldHashes` → reason `"schema/payload field-count mismatch"`, all `match=false`.
4. `revoked = revocation ? isRevoked(payload.docId, revocation.list) : null`. (Caller is responsible for having `verifyRevocationList`'d the list first; `verifyAttestation` does not re-verify it — keeps the gate explicit.)
5. `valid = signatureValid && perField.every(f=>f.match) && revoked !== true`. `reason` = first failing gate.

## 4. `@noy-db/hub/attestation` (①b) — vault-coupled issue side

### 4.1 Collection declaration
```ts
company.collection<Invoice>('invoices', {
  schema: InvoiceSchema,
  attestation: { fields: [
    { path: 'invoiceNo',   normalize: 'alnum-upper' },
    { path: 'total',       normalize: 'cents' },
    { path: 'issueDate',   normalize: 'iso-date' },
    { path: 'vatAmount',   normalize: 'cents' },
    { path: 'issuerTaxId', normalize: 'alnum-upper' },
  ]},
})
```
`attestation?: AttestationFieldSchema` is a new optional field on the collection options (sits beside `schema`/`refs`). `validateFieldSchema` runs at collection-definition time.

### 4.2 Signing keypair in the keyring (lazy)
New optional `KeyringFile` field:
```ts
readonly doc_signing_key?: {
  readonly keyId: string
  readonly alg: 'ed25519'
  readonly publicKey: string        // base64url raw — non-secret, for publishing
  readonly wrappedPrivKey: string   // base64url AES-GCM(iv‖ct‖tag) of the pkcs8 private key, under the owner KEK
}
```
- **Lazy mint:** first `issueAttestation` on a vault with no `doc_signing_key` generates one (`generateDocSigningKeyPair`), AES-GCM-encrypts the pkcs8 private key under the owner KEK (fresh IV, same pattern as recovery blobs — NOT AES-KW, which is for fixed-length material), persists the merged keyring. Idempotent: a present key is reused.
- **Owner-only:** issuing requires the owner role (the signing key is the firm's identity). Non-owners → `AttestationError`.
- Publishing the public key is a separate explicit read: `vault.getDocumentSigningPublicKey() → { keyId, publicKey }`.

### 4.3 `_attestations` index record (encrypted)
```ts
// _attestations/<docId>, encrypted under a dedicated `_attestations` collection DEK
{ docId, sourceRefs: [{ collection, id, version }], issuedAt, keyId, fieldPaths: string[] }
```
The firm's private record of what was issued and against which record version(s). Encrypted (normal DEK) — no plaintext bypass. `version` pins the source record version so a later edit is detectable ("issued against v3; record is now v5").

### 4.4 Issue API
```ts
const { docId, qr, payload } = await vault.issueAttestation('invoices', 'inv-1001')
// docId: ULID
// qr:    string to draw as a QR (encodeQr output)
// payload: the QrPayload (for callers that want the structured form)
```
Steps: load record → resolve collection `attestation.fields` (throw if undeclared) → extract values at each `path` → `computeFieldHashes(salt, schema, values)` → build `{v,docId,salt,keyId,fieldHashes}` → unwrap signing privKey under KEK (lazy-mint if absent) → `signPayloadCore` → assemble `QrPayload` → write encrypted `_attestations/<docId>` → return.

### 4.5 Errors
New `AttestationError extends NoydbError` for: undeclared field-schema on the collection, non-owner issue attempt, missing field at a declared path, signing-key unwrap failure.

## 5. Test plan (TDD, library-side — no AWS/PDF/QR-image)

**①a pure package** (`packages/attestation/__tests__/`):
- `canonicalJson`/`sha256Hex` conformance to fixed vectors (byte-identical, documents the shared contract).
- each normalizer: representative + edge inputs (e.g. `cents` on `1234.5`, `1234.50`, `"1,234.50"` after client strip; `iso-date` on a Date and an ISO string; unparseable → throws).
- `computeFieldHashes` deterministic given salt+schema+values; changes when any field changes; domain-separation (two fields, equal values → distinct hashes).
- Ed25519 sign→verify round-trip; wrong key → invalid; tampered `signedCore` → invalid.
- `encodeQr`→`decodeQr` round-trip; reject `v!==1`, malformed base64url, missing fields.
- `verifyAttestation`: happy path (valid); one field altered → `valid=false`, that `perField.match=false`, others true (localization); forged QR (self-signed by attacker key not in `publicKeys`) → `signatureValid=false`; unknown keyId; schema/payload count mismatch; revoked docId → `valid=false, revoked=true`.
- `verifyRevocationList`: valid signed list passes; tampered list fails; `isRevoked` membership.

**①b hub subsystem** (`packages/hub/__tests__/attestation.test.ts`):
- `issueAttestation` end-to-end against an in-memory vault: returns a QR that `verifyAttestation` accepts when fed the same field values + the published public key.
- lazy keypair mint: first issue creates `doc_signing_key`; second issue reuses it (same keyId).
- owner-only: non-owner issue → `AttestationError`.
- undeclared schema → `AttestationError`.
- altered record after issue: re-extract + verify against the old QR → field mismatch detected.
- `_attestations/<docId>` is encrypted (envelope `_iv !== ''`) and round-trips with the firm's keyring; `sourceRefs[].version` pins the issued version.
- integration: issue → `encodeQr`/`decodeQr` → `verifyAttestation` with `getDocumentSigningPublicKey()` → `{valid:true}`.

## 6. Packaging

- New package `packages/attestation/` — name `@noy-db/attestation`, zero runtime deps, dual ESM/CJS via tsup (mirror `on-shamir`'s package.json shape). `engines.node >=18`; browser-safe (only WebCrypto globals).
- `@noy-db/hub` gains `dependencies: { "@noy-db/attestation": "workspace:*" }` and a new subpath export `./attestation` (mirror the `./bundle` subpath wiring in hub's package.json + tsup config).
- `features.yaml`: new `attestation` feature row in cluster `time-and-audit`, `package: '@noy-db/hub/attestation'`, referencing this sub-spec + the umbrella. Invariants: per-field salted commitment; Ed25519-signed; docId in signed core; `_attestations` encrypted; offline verify.

## 7. Build order within this sub-spec

①a first (pure, no deps) → ①b (imports ①a, needs keyring). The plan slices: (1) package scaffold + canonical/hash + conformance, (2) normalizers, (3) per-field hashing, (4) Ed25519 sign/verify + keygen, (5) QR codec, (6) verifyAttestation + revocation check, (7) hub: collection `attestation` option + keyring `doc_signing_key` + lazy mint, (8) hub: `issueAttestation` + encrypted `_attestations` + errors, (9) features.yaml + subpath wiring.

## 8. Deferred to other sub-specs / follow-ups
- QR *image* drawing + HTML→PDF Lambda → ③.
- Revocation list *production/hosting/fetch* → ⑤ (this sub-spec ships only the pure format + check).
- In-browser vision field extraction → ④ enhancement (produces the same `claimedFields`).
- CBOR + base45 QR density optimization.
- KMS-backed `DocumentSigner` (sign via `at-aws-kms` asymmetric) — the `signPayloadCore` boundary is the injection point.
- Whole-document (single-hash) mode as a lighter alternative to per-field, if QR density becomes a problem.
