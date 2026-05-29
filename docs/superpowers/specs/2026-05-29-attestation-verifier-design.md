# Document Attestation — ④ Offline Verifier design

**Status:** sub-system spec (④ of the document-attestation umbrella) → ready for plan
**Date:** 2026-05-29
**Relates to:** umbrella `docs/superpowers/specs/2026-05-29-document-attestation-umbrella-design.md` §3.6/§3.8/§4/§5; core+issue `docs/superpowers/specs/2026-05-29-attestation-core-and-issue-design.md`. Depends on the already-merged `@noy-db/attestation` (①a, PR #235) and `@noy-db/hub/attestation` (①b, PR #236).

## 1. Goal

Demonstrate and package the **offline, client-side, no-server verification** of an issued document, for a third party who has *no* access to the firm's hub. Deliver:

1. A **self-contained static `verifier.html`** (open from disk, works fully offline) under a new `recipes/attestation-verifier/` workspace package.
2. The standard **recipe pairing**: `docs/recipes/attestation-verifier.md` + `showcases/src/recipe-attestation-verifier.recipe.test.ts`, registered in `features.yaml`.

The verification crypto already exists in `@noy-db/attestation` (`decodeQr`, `verifyAttestation`, `verifyRevocationList`, `isRevoked`). This slice builds **no new crypto** — it composes those primitives into a shared verdict function, a UI, and a build, and proves the end-to-end path.

**Dependency rule (hard):** everything on the *verify path* imports **only** `@noy-db/attestation` — no hub, no AWS, no network. The showcase additionally imports `@noy-db/hub` to *mint* a sample attestation (issue side), modelling the real boundary: **firm issues (hub) → third party verifies (pure, offline)**.

## 2. Architecture

Two artifacts sharing **one verify core**:

```
recipes/attestation-verifier/           # NEW private (unpublished) workspace package — ④ pioneers recipes/
  package.json        # "private": true; build script; devDep esbuild
  index.html          # layout A markup (single column, top-down)
  src/verify-core.ts  # THE shared verdict fn — imported by BOTH the page and the showcase/unit test
  src/app.ts          # DOM glue: read QR + field inputs → verify-core → render verdict + per-field rows
  src/config.ts       # bundled { publicKeys, fieldSchema, revocationList } (sample/demo values; firm swaps in real ones)
  build.mjs           # esbuild: bundle app.ts (IIFE) + inline into index.html → dist/verifier.html (self-contained)
  README.md           # configure (drop in real keys/schema/revocation) → build → open
docs/recipes/attestation-verifier.md             # narrative recipe doc
showcases/src/recipe-attestation-verifier.recipe.test.ts   # the showcase (end-to-end)
features.yaml                                     # new recipes: entry + cross-ref from the attestation feature row
pnpm-workspace.yaml                               # add "recipes/*" to the packages globs
```

`recipes/attestation-verifier` is `private: true` — never published (umbrella's "deployable reference app, not published"). `recipes/*` is added to the pnpm workspace globs so pnpm/turbo see it; ③ later adds `recipes/aws-kms-pdf-attestation/` as a sibling.

## 3. The verify core (`src/verify-core.ts`)

The single source of verification truth. Pure, framework-free, importable by the page and the tests.

```ts
import { decodeQr, verifyAttestation, verifyRevocationList, isRevoked,
         type AttestationFieldSchema, type RevocationList } from '@noy-db/attestation'

export interface VerifierConfig {
  publicKeys: Record<string, string>        // keyId → publicKeyB64 (rotation-safe; QR's keyId selects)
  fieldSchema: AttestationFieldSchema        // which fields + normalizers + order (NOT carried by the QR)
  revocationList?: RevocationList            // optional bundled signed snapshot
}

export type VerifierOutcome =
  | 'authentic-valid'      // sig ok + all fields match + not revoked
  | 'authentic-revoked'    // sig ok + all fields match, but docId revoked
  | 'altered'              // sig ok but ≥1 field differs (perField localizes which)
  | 'signature-invalid'    // sig check failed
  | 'unknown-key'          // payload.keyId not in publicKeys → cannot verify
  | 'unreadable-qr'        // decodeQr threw / malformed

export interface Verdict {
  outcome: VerifierOutcome
  perField: Array<{ path: string; match: boolean }>   // [] when not applicable
  revocationTrusted: boolean | null    // null = no list bundled; false = list sig failed (status untrusted)
  keyId?: string
  docId?: string
}

export async function verifyDocument(
  qr: string,
  claimedFields: Record<string, unknown>,
  config: VerifierConfig,
): Promise<Verdict>
```

`verifyAttestation` accepts an optional `revocation?: { list }` and returns `revoked: boolean | null` (it runs `isRevoked` internally but, per the locked ①a contract, does **not** verify the list's signature — the caller must). It also returns `signatureValid: false` when `keyId` is absent from `publicKeys`, so verify-core does its own keyId-membership check to tell `unknown-key` apart from a genuine bad signature.

Algorithm:
1. `decodeQr(qr)` → payload. On throw → `unreadable-qr`.
2. If `payload.keyId` not in `config.publicKeys` → `unknown-key` (cannot recompute/verify).
3. Revocation, **list signature first**: if `config.revocationList` present, `revocationTrusted = await verifyRevocationList(list, publicKeys[keyId])`; else `revocationTrusted = null`.
4. Call `verifyAttestation({ qr, claimedFields, fieldSchema: config.fieldSchema, publicKeys: config.publicKeys, ...(revocationTrusted === true ? { revocation: { list } } : {}) })`. Passing the list **only when trusted** means an untrusted list never influences `revoked`/`valid` — `verifyAttestation` then reports `revoked: null`. Read `{ signatureValid, perField, revoked }`.
5. `allMatch = perField.every(f => f.match)`.
6. Map to outcome (authenticity+integrity decide the `outcome`; revocation is carried separately in `revocationTrusted` + the `revoked`-driven `authentic-revoked`):
   - `!signatureValid` → `signature-invalid`.
   - `signatureValid && !allFieldsMatch` → `altered`.
   - `signatureValid && allMatch`:
     - no list bundled → `authentic-valid`, `revocationTrusted = null`.
     - `revocationTrusted === true`, `revoked === true` → `authentic-revoked`.
     - `revocationTrusted === true`, `revoked === false` → `authentic-valid`.
     - `revocationTrusted === false` → `authentic-valid` with `revocationTrusted = false` (and `revoked` stays `null`, since the untrusted list was never passed to `verifyAttestation`). The doc *is* authentic + unaltered (that gate genuinely passed), but the bundled list's signature did not verify, so its revocation claim is discarded. The outcome stays `authentic-valid`; the `revocationTrusted=false` flag is what the UI keys off to refuse the "still valid today" wording (§4). We never let an untrusted list flip a real authenticity pass to a fail, nor silently accept its "not revoked".

## 4. The page (layout A — single column, top-down)

Approved wireframe: paste QR → type the printed field values (one input per `fieldSchema` field) → **Verify** → verdict banner + per-field table, top-down. `src/app.ts` reads inputs, calls `verifyDocument`, and renders:

- Banner per `outcome`: `AUTHENTIC & VALID` (green) · `REVOKED` (amber — "issued by the firm, since withdrawn") · `ALTERED` (red) · `SIGNATURE INVALID` (red) · `UNRECOGNIZED KEY` (grey — "update this verifier") · `UNREADABLE QR` (grey). Special case: `authentic-valid` with `revocationTrusted === false` shows the green authenticity banner but **downgraded copy** — "AUTHENTIC & UNALTERED · revocation status could not be confirmed" — never the bare "VALID" claim.
- Per-field rows with ✓/✗ so a tampered field is localized.
- A small footer line: `keyId`, `docId`, and a revocation badge (`not revoked` / `revoked` / `revocation status untrusted`).

The field inputs are generated from the bundled `fieldSchema.fields` (paths shown as labels). No camera/QR-image scan in v1 — paste the decoded string.

## 5. Build (`build.mjs`, esbuild)

`esbuild` bundles `src/app.ts` (+ its `@noy-db/attestation` import and `config.ts`) into one IIFE, then inlines that JS into `index.html`, emitting `dist/verifier.html` with **zero external references** — double-click to run, fully offline. `@noy-db/attestation` uses only WebCrypto (present in browsers), so no polyfills. `package.json` `build` script runs `node build.mjs`; `esbuild` is a devDep of the recipe package.

## 6. Testing

`showcases/src/recipe-attestation-verifier.recipe.test.ts` exercises the **same `verify-core`** the page uses. It uses **two key sources**, on purpose:

- **Hub-issued (the real boundary):** `vault.issueAttestation` on a sample `invoices` collection declared with an `attestation` field-schema → `{ qr, keyId, publicKeyB64 }`; verify with `publicKeys: { [keyId]: publicKeyB64 }`, the same `fieldSchema`, and **no** revocation list (`verify-core` requires none). Cases: correct fields → `authentic-valid`; tampered `total` → `altered` (its row mismatched, others matched).
- **Pure in-process keypair (for the revocation + key-control cases):** signing a revocation list needs the firm's *private* key (`signRevocationList(revokedDocIds, asOf, keyId, privateKeyPkcs8B64)`), which the hub deliberately does **not** expose (`getDocumentSigningPublicKey` returns only the public key). So these cases mint a keypair with `generateDocSigningKeyPair()` and sign both the QR payload (`signPayloadCore`) and the revocation list (`signRevocationList`) in-process — fully pure, no hub. *(This also foreshadows ⑤: revocation-list publishing is a firm-private-key operation that will need explicit hub support or a held private key.)* Cases:
  - revocation list signed over `[docId]` → `authentic-revoked`;
  - two keys in the `publicKeys` map, QR signed by key #1 → still `authentic-valid` (**rotation-safe**);
  - QR carrying an unbundled `keyId` → `unknown-key`;
  - tampered/garbage QR → `unreadable-qr`;
  - a revocation list re-signed with the wrong key (bad sig) → outcome still `authentic-valid` on authenticity, but `revocationTrusted === false` (no clean "valid" claim off it).

Plus: a focused unit test on `verifyDocument` mapping logic, and a **build smoke test** asserting `dist/verifier.html` contains no external `src=`/`href=` (http/https) network references (proves self-contained/offline).

## 7. Registry (`features.yaml`)

- New `recipes:` entry:
  ```yaml
  - id: attestation-verifier
    name: Offline document-attestation verifier
    doc: docs/recipes/attestation-verifier.md
    showcase_path: showcases/src/recipe-attestation-verifier.recipe.test.ts
    status: preview
    exercises:
      features: [attestation]
  ```
  (Validator "recipe-pair" check: doc slug / showcase slug / id all agree on `attestation-verifier`.)
- Update the existing `attestation` feature row: `recipes: []` → `recipes: [attestation-verifier]`, and add the showcase to its `showcases` list (the validator resolves `related`/`recipes` cross-refs).

## 8. Scope (YAGNI)

**In:** verify-core, layout-A page, esbuild single-file build, the recipe doc + showcase, features.yaml wiring, `recipes/*` workspace glob.
**Out:** QR camera/image scanning (paste the decoded string); fetching a remote key-list or revocation list (bundle only — offline + no fetch-time trust anchor per §3.6); revocation *publishing/hosting* (that is slice ⑤); non-Ed25519 algorithms (v1 matches the QR `alg: 'ed25519'`); any hub or AWS dependency on the verify path.

## 9. Build order within the slice

1. `recipes/attestation-verifier/` package skeleton + `recipes/*` workspace glob + `verify-core.ts` (TDD against a unit test).
2. The page (`index.html` + `app.ts`) + `build.mjs` + build smoke test.
3. The showcase (`recipe-attestation-verifier.recipe.test.ts`) — full issue→verify path.
4. The recipe doc + `features.yaml` wiring + full validation.
