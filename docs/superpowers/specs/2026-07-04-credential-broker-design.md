# #479 — Client cloud-credential broker: passphrase-bound, rolling, non-extractable store auth (design brief)

**Status:** all 7 owner-decisions RESOLVED 2026-07-05 (see Open questions) — decision-complete, ready for a hardened spec + adversarial audit before implementation. Locked: developer-backend enrolment attestation · symmetric HMAC proof · `@noy-db/hub/broker` helpers + doc host · slice-1 AWS-only · `StoreAuth` untouched · persist-nothing default · klum re-export deferred.

> **Status:** design (2026-07-04), decision-ready — DESIGN ONLY, no code. Hardens the
> proposal sketch in issue #479 into decidable forks. Prior art: #306 record-scoped
> sealing (`2026-06-29-306-record-scoped-sealing.md`), the S5 port model
> (`2026-07-02-family-doors-kernel-diet-design.md`), and the enclave contract
> (`2026-07-03-enclave-contract-v1-design.md`). Spans two repos: `noy-db` (hub seam)
> and `noy-db-to` (adapter hook adoption).

## Problem (verified)

A local-first SPA syncing to `@noy-db/to-aws-dynamo` / `@noy-db/as-aws-s3` has no
native way to make its **cloud-access credential** transparent, rolling,
non-extractable, and user-bound. Verified gaps:

- `StoreAuth` / `StoreAuthKind` (`packages/hub/src/kernel/types.ts:1983–1996`) is
  **declared-only metadata**. Stores *declare* it (`to-aws-dynamo/src/index.ts:154`:
  `auth: { kind: 'iam', required: true, flow: 'static' }`) — repo-wide grep confirms
  **nothing reads it** to mint, refresh, or rotate a credential (hub hits: `index.ts`
  re-export + `types.ts` definition only; noy-db-to hits: declarations only).
- `to-aws-dynamo` takes a pre-built `client?: DynamoDocClient`
  (`noy-db-to/to-aws-dynamo/src/index.ts:59–60`) or falls back to the SDK ambient
  chain. Both paths are static for the store's lifetime; the easy browser paths
  (guest Identity-Pool creds, baked keys) are extractable and not user-bound.
- The sealing layer (`RecipientSealer`, `sealRecordToHost`
  `kernel/enclave/record-keys/sealing.ts:53`, magic-link grants) governs *who can
  decrypt vault data*, not *how the client authenticates to the store*.

**One correction to the issue sketch, found during design:** "sign a broker challenge
with a key derived from the unlocked KEK" is not implementable as stated. The KEK is
a WebCrypto `AES-KW` key with usages `['wrapKey','unwrapKey']` only
(`kernel/enclave/crypto.ts:63–87`) — it cannot `deriveBits` or sign — **and**
`UnlockedKeyring.kek` is `EnclaveKey | null` (`with-party/team/keyring.ts:96–122`):
it is `null` after PIN quick-resume, wrap-DEKs tier-2 unlock, and session restore.
A KEK-anchored proof would break on those unlock paths and on every passphrase
rotation. §2's fork P fixes this.

## 1. Threat model — what each requirement actually buys

| Requirement | Defeats | Does NOT defeat (candor) |
|---|---|---|
| **Transparent** (dev wires cloud at setup; user never sees it) | Nothing — this is UX/product, not security. Listed so we don't pretend otherwise. | — |
| **Rolling** (short-lived, rotating) | A credential lifted from a memory dump, crash log, proxy log, or devtools session is dead within TTL (minutes–1h). Revocation = broker stops re-issuing; no client-side key rotation ceremony. | Live abuse *within* TTL. |
| **Non-extractable** | An attacker who copies the app bundle, `localStorage`, or IndexedDB **at rest** gets nothing replayable: no long-lived secret is persisted in extractable form. With slice 3, the instance private key is a WebCrypto `extractable: false` key — even script running in-page cannot `exportKey` it. | **A resident XSS attacker while the vault is unlocked.** Such an attacker can *use* the non-extractable keys in place — run the whole proof flow, receive valid short-lived creds, and exfiltrate *those*. WebCrypto non-extractability denies *capability cloning* (offline/later/elsewhere reuse), not *live in-page use*. Any design claiming more in a browser is overclaiming; docs must state this bound (repo precedent: #306 D5 erasure-scope candor). |
| **User-bound** (`access = f(app config, unlocked keyring)`) | App config alone (bundle constants, endpoint URLs, table names) grants **zero** cloud access — the broker refuses without a proof only derivable from an unlocked keyring. Per-user STS session tags let the cloud enforce per-vault scoping (e.g. DynamoDB `dynamodb:LeadingKeys`, S3 prefix conditions on the vault id) so user A's creds cannot read user B's ciphertext rows. | A compromised **broker host**: the broker is the credential authority; its compromise mints creds for anyone. That is outside the zero-knowledge boundary by design — the broker still never sees passphrase, KEK, DEKs, or plaintext (§2). Same trust class as the `at-*` family. |

Zero-knowledge law preserved: the passphrase and KEK never leave the client; the
broker sees only a challenge proof and (slice 3) seals *to* the instance. The stolen
ciphertext story is unchanged — store creds gate *availability/tamper/deletion* of
ciphertext, not confidentiality, which rests on the enclave as today.

## 2. Keyring-derived proof — derivation, flow, replay

### Fork P — what the proof key derives from

- **P-A: parallel PBKDF2 branch on the passphrase** (distinct salt). Rejected:
  unavailable in managed-passphrase mode and every KEK-null unlock path; breaks
  silently on passphrase rotation; costs a second 600K-iteration PBKDF2.
- **P-B: HKDF from a collection DEK** (precedent: `derivePresenceKey`,
  `crypto.ts:491`). Rejected: there is no vault-wide DEK — `deks` is keyed per
  collection+tier (`with-party/team/tiers.ts:24`); picking one couples broker auth
  to a specific collection grant and breaks on that DEK's rotation.
- **P-C (RECOMMENDED): dedicated random broker seed, stored encrypted in the
  vault.** A 32-byte random seed, generated at enrolment, persisted as an encrypted
  record in a reserved `_broker` namespace — exactly the `_sync_credentials`
  pattern (`with-party/team/sync-credentials.ts`: reserved collection, dedicated
  API, role-gated, never reachable via `vault.collection()`). Available on every
  unlock path that can decrypt (needs a DEK, not the KEK); survives passphrase
  *and* collection-DEK rotation; independently rotatable/revocable ("re-enroll").

### Exact derivation (P-C)

Repo `noydb-*` HKDF convention (salt string + injective JSON-array `info` domain
tag, per `deriveSealedFieldKeyFromCek` / `noydb-det`):

```
seedBytes (32, random, decrypted from _broker/<brokerId>)
  → importKey('raw', seedBytes, 'HKDF', false, ['deriveBits'])
  → deriveBits({ salt: 'noydb-broker-proof',
                 info: JSON.stringify(['noydb-broker-proof', vaultId, brokerId]) }, 256)
  → importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, /* extractable */ false, ['sign'])
```

The resulting proof key is a **non-extractable HMAC-SHA-256 key**; raw bits are
zeroed after import (same hygiene as `sealRsaOaepTlv`, `managed-passphrase.ts:221`).

### Challenge–response flow

1. Client → broker: `POST /challenge { vaultId, instancePid? }`.
2. Broker → client: `{ challenge: <32B random, base64>, expiresAt }` — stored
   server-side, **single-use**, TTL ≤ 60 s.
3. Client computes
   `proof = HMAC(proofKey, JSON.stringify(['noydb-broker-proof-v1', vaultId, instancePid ?? '', challenge, expiresAt]))`
   (injective JSON-array canonicalization — no delimiter ambiguity).
4. Client → broker: `POST /credentials { vaultId, challenge, proof, profile }`.
5. Broker verifies HMAC against the registered proof key, burns the challenge,
   mints scoped short-lived creds (§6), returns them (§5).

**Replay protection:** server-random single-use challenge + TTL; the proof binds
`vaultId` (and `instancePid` when slice 3 is on) so a proof cannot be replayed for
another vault, another instance, or after the window. No client clock trust — the
broker's `expiresAt` rides inside the MAC input.

**What the broker learns:** vault id, a registered 32-byte HKDF output (one-way;
inverts to nothing), request timing/IP, the requested profile. **What it never
learns:** passphrase, KEK, any DEK/CEK, collection names, record contents, the
broker *seed* (only the derived proof key is registered — re-derivation with a new
`brokerId` yields an unlinkable key).

**Symmetric-HMAC candor:** the broker holds the same key it verifies, so it could
forge client proofs. This is a non-weakening: the broker already *is* the
credential mint — forging a proof to itself grants nothing it can't grant anyway.
An asymmetric variant (client-held signing key) buys third-party verifiability
nobody needs in this topology, and WebCrypto cannot derive a deterministic
ECDSA keypair from HKDF output portably. HMAC is the honest, simpler choice.
(Open question 2 if the owner disagrees.)

## 3. Broker seam shape in hub

### Fork S — where it lives

- **Kernel floor:** rejected. The core is the ~6,500-LOC "what NOYDB is"
  (SERVICES.md); broker auth is opt-in, network-flavored, and worthless to
  `to-memory`/`to-file` users. `kernel-surface` ratchet also punishes it.
- **Cargo (`@noy-db/hub/cargo`):** rejected. Cargo is the frozen *outward
  orchestration* seam for klum-db's fleet lobby and `by-*` transports — additive-only,
  golden-frozen. The broker is app-level single-vault plumbing, not cross-vault
  orchestration. (If klum-db later wants fleet-wide broker awareness, re-export
  then — open question 7.)
- **New service `@noy-db/hub/broker` with `withBroker()` (RECOMMENDED):** fits the
  SERVICES.md governance checklist exactly — subpath export, strategy seam
  (`with-party/broker/{strategy.ts,active.ts,index.ts}`; it is party-dimension:
  identity/auth adjacent to `sync-credentials`), tsup multi-entry, doc page,
  SERVICES.md row (Cluster G, Access & Auth), CI bundle-size gate entry.
  **Bundle impact: 0 bytes when not opted in** (NO-OP stub, tree-shaken); est.
  ~400–600 LOC when opted in (seed lifecycle + HKDF/HMAC + challenge client +
  refresh cache). No new npm deps — `crypto.subtle` + `fetch` only, so the
  `hub-portable` and `no-crypto-deps` guards pass untouched.

### `CredentialBroker` surface (client side)

```ts
// @noy-db/hub/broker
export interface BrokerConfig {
  readonly brokerId: string            // stable id; part of the HKDF info tag
  readonly endpoint: string            // https broker base URL
  readonly fetch?: typeof fetch        // DI for tests / non-window runtimes
}

export interface CredentialBrokerHandle {
  /** Generate + persist the seed (idempotent), register the proof key. */
  enroll(): Promise<void>
  /** Rotate the seed + re-register (revokes the old proof key). */
  rotate(): Promise<void>
  /** A refresh hook wired straight into a to-* store's `credentials` option (§4).
   *  Caches until expiresAt − skew; single-flight; re-proves on refresh. */
  credentialSource(profile?: string): StoreCredentialSource
}

export function withBroker(config: BrokerConfig): BrokerStrategy
// vault-scoped accessor, mirroring other services:
// vault.broker() → CredentialBrokerHandle (throwing stub when not opted in)
```

Host-side verify/issue helpers (`verifyBrokerProof`, `issueChallenge`,
`sealCredentialsToInstance`) are exported from the same subpath — they are
`crypto.subtle`-only and runtime-portable, so a Lambda/worker imports the same
package (§6). No `StoreAuth` change is required for function; an additive
`kind: 'broker'` / `flow: 'rolling'` is optional polish (open question 5).

## 4. Adapter-side hook — through the `/to` port

### Fork A — contract shape

- **A-1 (RECOMMENDED): type-only addition to the `/to` port + a per-store factory
  option.** The hub port gains **types only**; each store adds
  `credentials?: StoreCredentialSource` to its own factory options and owns its
  client-rebuild mechanics.
- **A-2: new optional method on `NoydbStore`** (`setCredentialSource?()`).
  Rejected: widens the 6-method contract for something that is construction-time
  configuration, forces every store to consider it, and churns the golden surface
  for no cross-cutting caller (the hub never calls it — only the app wires it).

### Exact contract addition (`packages/hub/src/port/to/index.ts`)

```ts
/** Vendor-neutral short-lived store credentials. AWS is a profile, not the shape. */
export type StoreCredentials =
  | { readonly kind: 'aws'
      readonly accessKeyId: string
      readonly secretAccessKey: string
      readonly sessionToken?: string
      readonly expiresAt?: string }        // ISO 8601
  | { readonly kind: 'token'                // postgres/turso/supabase/webdav/bearer
      readonly token: string
      readonly expiresAt?: string }

/** Refresh hook a store calls when it has no credentials or they are near expiry. */
export type StoreCredentialSource = () => Promise<StoreCredentials>
```

Store-side discipline (documented in the port JSDoc, enforced by conformance
tests): call the source lazily on first use and when
`expiresAt − now < 60_000 ms`; rebuild the SDK client on change; on an auth error
(`ExpiredTokenException` etc.), force one refresh + retry before surfacing
`NetworkError`. The `kind: 'aws'` arm maps 1:1 onto the SDK's
`AwsCredentialIdentity`, so `to-aws-dynamo` wires it as a credential *provider
function* — the SDK already supports functional providers natively.

### Versioning / seam consequences (this IS an adapter-contract change — flagged)

- `/to` is golden-frozen (`__tests__/to-surface-golden.test.ts`): additive change =
  visible baseline update to `to-surface.golden.json` + typecheck pin. Allowed;
  loud by design.
- `/adapter` (the deprecated alias, `src/legacy/adapter.ts`) is frozen to its
  historical 12 symbols **byte-identical** — the new types go to `/to` ONLY.
- Per the family discipline ("a hub release only forces a noy-db-to rebuild when
  the store contract changes") — **this is exactly such a release.** noy-db-to
  stores adopting `credentials` must raise their `@noy-db/hub` peer floor from the
  current `^0.3.0-pre.1` to the pre-release that ships `StoreCredentials`.
  Non-adopting stores are untouched (types are additive). `check-architecture.mjs`
  rules all pass as-is: `to-only` (import stays `@noy-db/hub/to`),
  `hub-peer-range`, `no-crypto-deps` (credentials are opaque strings, not crypto).
- `as-aws-s3` lives in *this* repo (plaintext-by-design `as-*` family) — it gets
  the same `credentials` option shape by direct import, no port involvement.

## 5. Credential delivery — sealed TLV vs plain HTTPS

### Fork D

| | **D-1: plain HTTPS response, memory-only (RECOMMENDED default)** | **D-2: sealed-to-instance RecipientSealer TLV (slice-3 opt-in)** |
|---|---|---|
| Transit | TLS. | TLS + RSA-OAEP TLV (`sealRsaOaepTlv`, `managed-passphrase.ts:205` — the exact #306 wire format; broker uses the same primitive `awsKmsRecipientSealer` already speaks). |
| At rest | Nothing persisted — creds live in a closure, die with the tab. | Sealed blob may be cached; only the instance's `extractable: false` RSA-OAEP-2048 private key (IndexedDB) opens it. |
| vs resident XSS | Equivalent — both lose (§1 candor). | Equivalent — XSS asks WebCrypto to unseal. |
| Instance binding | Proof-side only (`instancePid` in the MAC input). | Cryptographic: a response exfiltrated by an intermediary (SW cache, logging proxy, extension) is unopenable elsewhere. |
| Cost | Zero. | Instance keypair lifecycle, hint registration at enrolment, TLV plumbing. |

**Recommendation:** D-1 default. Store creds must be used online anyway, so
"persist nothing" is both simpler and honestly equal against the attackers that
matter; sealing transit-again under TLS is mostly theater. D-2 ships in slice 3 as
an opt-in for deployments with hostile-intermediary concerns — it reuses
`RecipientHint` v1 `'rsa-oaep-sha256'` verbatim (instance publishes
`{ v: 1, pid: 'instance:<uuid>', alg, material: { publicKeyPem } }` at enrolment),
zero new wire formats.

## 6. Broker host — reference implementation boundary

**Minimal viable host: one HTTPS endpoint + STS. No KMS required** in the
symmetric design (KMS enters only if the host itself wants HSM-backed storage of
registered proof keys, or for D-2 unsealing symmetry — deployment choice).

- `POST /enroll` — store `(vaultId, proofKey[, instanceHint])`; trust bootstrap is
  open question 1.
- `POST /challenge` — mint single-use nonce.
- `POST /credentials` — `verifyBrokerProof(...)` → `sts:AssumeRole` with session
  tags `{ noydbVault, noydbUser }` + a scoped inline session policy
  (`dynamodb:LeadingKeys` / S3 prefix condition on the vault id) → return
  `{ kind: 'aws', ..., expiresAt }` (≤ 1 h).

### Fork H — what noy-db ships

- **H-1: an `at-*` package** (e.g. `at-broker-aws`). Rejected: the `at-*` charter
  is `SealingKeyProvider` — "sealed **at** a trusted host". The broker host is
  trust-adjacent but is not a sealing-key provider; stretching the prefix grammar
  muddies the catalog's central mental model. (`at-aws-kms` stays involved only as
  the optional D-2 sealer.)
- **H-2: a new package family / prefix.** Rejected: one host for one flow does not
  justify family-level governance (prefix table, SERVICES/SPEC updates, CI lanes).
  Revisit if brokers for GCP/Azure/postgres tokens multiply.
- **H-3 (RECOMMENDED): userland-with-helpers.** Hub ships the portable
  verify/issue/seal helpers from `@noy-db/hub/broker` (crypto.subtle-only — they
  run in Lambda, Workers, Deno, Node ≥22 unchanged); noy-db ships a **documented
  ~100-line Lambda example** in the service doc page (mock-tested like every
  cloud-touching package — CI stays cloud-free). STS minting itself stays userland:
  the hub can never depend on `@aws-sdk/*` (`no-crypto-deps` / portability), and
  the four lines of `AssumeRoleCommand` are not worth a package.

## 7. Phasing — three independently valuable slices

- **Slice 1 — adapter `credentials` hook.** `StoreCredentials` +
  `StoreCredentialSource` on `/to` (golden baseline bump); `credentials` option in
  `to-aws-dynamo` / `to-aws-s3` (noy-db-to, peer-floor bump) + `as-aws-s3` (this
  repo); conformance-test the refresh/retry discipline. **Value without any broker:**
  users wire their existing Cognito/STS/Amplify credential providers today — the
  #479 "Gap" paragraph's bolt-on becomes a supported seam. No new service, no
  bundle-gate change.
- **Slice 2 — proof + broker service.** `withBroker()` / `@noy-db/hub/broker`
  (SERVICES.md governance checklist + bundle gate), `_broker` seed lifecycle,
  `'noydb-broker-proof'` derivation, challenge client, host verify helpers,
  reference Lambda doc. Delivery = D-1.
- **Slice 3 — sealed delivery + instance identity.** Non-extractable instance
  RSA-OAEP keypair, hint registration at enrolment, D-2 TLV path,
  `instancePid` in the proof MAC. Optional; independent of 1–2 being useful.

## Risks

- **R1 (design-correcting):** KEK-anchored proof breaks on KEK-null unlock paths
  and passphrase rotation — fixed by P-C; any implementation MUST NOT touch
  `UnlockedKeyring.kek`.
- **R2 (overclaim):** shipping docs that say "non-extractable" without the §1
  resident-XSS bound. The candor paragraph is part of the deliverable, not polish.
- **R3 (availability coupling):** broker down ⇒ sync down. Offline-first semantics
  are unaffected (local writes queue as today); document that broker outage
  degrades to offline mode, and stores must surface it as `NetworkError`, not data
  loss.
- **R4 (skew):** client clocks are untrusted — all expiry decisions ride broker
  timestamps inside MAC'd material; store-side refresh uses a 60 s skew margin.
- **R5 (seam churn):** `/to` golden bump + noy-db-to peer-floor ratchet must land
  as one coordinated pre-release (the 0.3.0-pre line's sister-adoption playbook).

## Open questions — RESOLVED 2026-07-05 (owner sign-off)

1. **Enrolment trust bootstrap → developer-backend attestation.** The app's
   existing session/auth token authorizes `/enroll`; the broker refuses enrolment
   without it. Closes the TOFU vault-id-squatting hole. The reference host example
   (§6) must show the attestation check on `/enroll`.
2. **Symmetric HMAC proof → accepted.** §2's non-weakening argument stands (the
   broker is the credential mint; forging a proof to itself grants nothing extra).
   No asymmetric enrolment key. HMAC-SHA-256 as specified.
3. **Helper home → `@noy-db/hub/broker` subpath + doc example (H-3).** Portable
   `crypto.subtle`-only verify/issue/seal helpers exported from the new service
   subpath + a documented ~100-line Lambda/STS reference host. No new package, no
   `at-*` charter stretch.
4. **Slice-1 scope → AWS-only first.** Slice 1 wires the `credentials` hook into
   `to-aws-dynamo` / `as-aws-s3` behind an AWS profile. The contract type ships
   vendor-neutral; `to-postgres` / `to-turso` / `to-supabase` adopt the
   `kind: 'token'` arm in a later slice.
5. **`StoreAuth` polish → leave untouched.** It stays declared-only today; a
   `kind: 'broker'` / `flow: 'rolling'` descriptor is additive later if something
   comes to consume it.
6. **Sealed-delivery default → confirmed.** Sealed-to-instance TLV is opt-in;
   **"persist nothing" (memory-only, refresh-on-demand)** is the default posture
   (D-1 recommended in §5).
7. **klum-db fleet angle → deferred.** Cargo does not re-export broker types now;
   revisit if/when the lobby wants fleet-wide enrolment (cargo is additive-only,
   so deferring costs nothing).
