# Credential broker

> **Subpath:** `@noy-db/hub/broker`
> **Factory:** `withBroker(config)`
> **Cluster:** G (Collaboration & Auth)
> **LOC cost:** ~500 (off-bundle when not opted in)
> **Issue:** #479

## What it does

The credential broker lets a client **passphrase-bound to a vault** obtain short-lived,
rolling cloud-storage credentials (AWS access keys today; a vendor-neutral token shape is
reserved for a later slice) **without ever putting a long-lived secret in the client**. A
32-byte seed is generated once, encrypted under the vault's own `_broker` collection DEK, and
never leaves the device. A **derived proof key** — never the seed itself — is registered with
a broker host at enrolment; from then on the client re-derives the same key, signs a
challenge the host just issued, and the host mints scoped, minutes-to-an-hour credentials on
a verified proof. Nothing here weakens the zero-knowledge guarantee over document
*contents* — this broker only gates **storage-backend access** (can this client currently
read/write ciphertext at all), not confidentiality of what's inside it.

## When you need it

- An app backed by a cloud store (`to-aws-dynamo`, `to-aws-s3`, `as-aws-s3`) that wants
  per-vault-scoped, auto-rotating credentials instead of one static IAM key baked into every
  client.
- Revocation without a client-side ceremony: stop re-issuing at the broker and every client's
  credential goes dead within its TTL.
- Per-role access tiers (`profile`, e.g. `'read'` vs `'admin'`) mapped to distinct STS
  session policies, enforced by the same proof.

## Threat model — what this defeats, and what it honestly does not

Store-access credentials gate **availability / tamper / deletion** of ciphertext, never its
confidentiality — that rests on the enclave, unchanged. The passphrase and every key/DEK
never leave the client; the broker sees only a challenge proof (and, in a future slice, seals
credentials *to* a specific instance). The stolen-ciphertext story is unchanged by any of this.

| Property | Defeats | Does **NOT** defeat |
|---|---|---|
| **Rolling** (short-lived, rotating) | A credential lifted from a memory dump, crash log, or devtools session is dead within its TTL (minutes–1 h). Revocation = the broker stops re-issuing; no client-side rotation ceremony. | Live abuse **within** the TTL. |
| **Non-extractable** | An attacker who copies the app bundle, `localStorage`, or IndexedDB **at rest** gets nothing replayable: the steady-state proof key is a WebCrypto `extractable:false` `['sign']` HMAC key. | **A resident XSS attacker while the vault is unlocked.** Such an attacker can drive the whole proof flow with the live key, *and* — the honest, sharper bound — re-run the HKDF derivation from the decrypted seed to mint a fresh proof key, because the seed's bytes are re-derivable while unlocked. WebCrypto non-extractability denies **capability-cloning** (reuse of a *handle* offline/later/elsewhere), not **live in-page use or re-derivation**. The non-extractable import is defense-in-depth against a *leaked handle only*. |
| **User-bound** (`access = f(app config, unlocked keyring)`) | App config alone (bundle constants, endpoint URLs) grants zero cloud access — the broker refuses without a proof derivable only from a decrypted `_broker` seed. Per-user STS session tags + a scoped session policy let the cloud side enforce per-vault scoping, so user A's creds cannot read user B's rows. | **A compromised broker host.** It is the credential authority; its compromise mints creds for anyone. This is outside the zero-knowledge boundary **by design** — the broker still never sees passphrase, KEK, DEK, or plaintext. Same trust class as the `at-*` sealing-key family. |
| **Symmetric-verifiable** (the broker holds the same key it verifies) | A forged *client* proof grants nothing the broker cannot already grant itself — it **is** the credential mint. | **A read-only leak of the broker's registered-key store.** Because verification is symmetric HMAC, a registered proof key **is** a forgeable credential — an attacker who reads the key store can mint valid proofs for any registered vault. This is credential-equivalent **unless the store wraps registered keys at rest under a broker-side KMS key** (mandated below): with KMS-wrap, a read-only DB leak yields only ciphertext the attacker cannot unwrap without also compromising the KMS grant. |
| **Transparent** (dev wires the cloud store at setup; the end user never sees it) | Nothing — this is UX, not security. Listed so nobody mistakes it for a security property. | — |

An asymmetric enrolment (register only a public verifier) would remove the at-rest
forgeability structurally, but was rejected: WebCrypto cannot portably derive a deterministic
keypair from HKDF output. KMS-wrap is the accepted mitigation for the symmetric-HMAC
at-rest exposure — see the reference host below.

## Protocol: enrol → challenge → mint → refresh → rotate

**What the broker learns:** `vaultId`, `brokerId`, a one-way 32-byte HKDF output (registered
once, inverts to nothing), the requested `profile`, request timing/IP, and the dev-backend
attestation identity at enrol.
**What it never learns:** the passphrase, any KEK/DEK, collection names, record contents, or
the `_broker` seed itself.

1. **Enrol** (`vault.broker().enroll()`, idempotent). Creates the `_broker` seed if absent
   (a create-if-absent CAS — two concurrent enrols converge on one seed, never two), derives
   the proof bits, and `POST /enroll`s them plus a dev-backend attestation token. Only after a
   2xx does the local record flip `registered: true` — a seed persisted whose `/enroll` POST
   failed stays unregistered so a later mint fails fast instead of degrading into an opaque
   proof error. Requires owner/admin role, and — for first-ever seed creation only — the
   vault's KEK (a keyring holding only a DEK, e.g. PIN quick-resume, can still *use* an
   already-enrolled seed, just not create the first one).
2. **Challenge.** The client `POST /challenge`s; the host mints a random, single-use
   challenge with a short (≤ 60 s) TTL and returns it.
3. **Mint.** The client re-derives the proof key from the seed, signs a canonical string
   binding `vaultId`, the broker endpoint's origin, `brokerId`, `profile`, the challenge, and
   its `expiresAt`, then `POST /credentials`s the proof. The host **burns the challenge before
   doing any HMAC work** (a replay of an already-used challenge is rejected before the MAC is
   even checked), verifies the signature against the KMS-unwrapped registered key, and — only
   then — mints scoped, short-lived cloud credentials.
4. **Refresh / cache.** `credentialSource(profile)` (what a store's credential hook calls)
   holds a single-flight, per-profile cache: concurrent callers near expiry await one
   round-trip; cached credentials are valid until `max(expiresAt − skewMs, now + minCacheMs)`.
   Nothing is ever written to disk — credentials live only in memory and die with the tab.
5. **Rotate** (`vault.broker().rotate()`). Quiesces the cache (awaits any in-flight
   round-trip), mints a fresh seed, registers it **before** overwriting the local record, and
   overwrites last. The reference host must accept **both** the old and new registration for a
   short grace window so an in-flight proof computed under the pre-rotation seed still
   verifies.

## Client surface

```ts
export interface BrokerConfig {
  readonly brokerId: string        // stable id; part of the HKDF info tag AND the proof MAC.
                                    // MUST be globally-unique / endpoint-derived — reusing one
                                    // brokerId across two endpoints enables a cross-endpoint relay.
  readonly endpoint: string        // https broker base URL; its origin is bound into the proof MAC
  readonly attestation?: () => string | Promise<string>  // dev-backend session token for /enroll
  readonly fetch?: typeof fetch    // DI for tests / non-window runtimes
  readonly skewMs?: number         // refresh margin, default 60_000
}

export interface CredentialBrokerHandle {
  enroll(): Promise<void>                                       // generate+persist seed, register
  rotate(): Promise<void>                                       // rotate seed + re-register
  credentialSource(profile?: string): StoreCredentialSource      // single-flight, cached
}
```

`vault.broker()` returns the `CredentialBrokerHandle` (`packages/hub/src/port/with/broker-strategy.ts`).
Every `StoreCredentialSource` produces the vendor-neutral `StoreCredentials` type (`kernel/types.ts`):

```ts
export type StoreCredentials =
  | { readonly kind: 'aws'; readonly accessKeyId: string; readonly secretAccessKey: string
      readonly sessionToken?: string; readonly expiresAt?: string }
  | { readonly kind: 'token'; readonly token: string; readonly expiresAt?: string } // a later slice
```

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withBroker } from '@noy-db/hub/broker'

const db = await createNoydb({
  store: idbStore(),
  user: 'me',
  brokerStrategy: withBroker({
    brokerId: 'broker-1',
    endpoint: 'https://broker.example.com',
    attestation: () => devBackendSessionToken(),
  }),
})
const vault = await db.openVault('acme')
await vault.broker().enroll()
```

Wire the resulting `credentialSource` into a store's rolling-credential hook — e.g.
`@noy-db/as-aws-s3`'s `credentials` option, which feeds the AWS SDK's own
`memoizeIdentityProvider` (the SDK owns refresh on the `kind:'aws'` arm, re-invoking the
provider whenever the returned identity carries an `expiration: Date`):

```ts
import { asAwsS3 } from '@noy-db/as-aws-s3'

const objects = asAwsS3({
  bucket: 'acme-assets',
  credentials: vault.broker().credentialSource('read'),
})
```

## Behavior when NOT opted in

Every `BrokerStrategy` method on the `NO_BROKER` floor default throws `BrokerNotEnabledError`
(message points at `withBroker()` from `@noy-db/hub/broker`). `vault.broker().enroll()`,
`.rotate()`, and `.credentialSource()` all throw/reject the same way. Zero bytes enter a
bundle that never imports `@noy-db/hub/broker`.

## The reference broker host — four mandated obligations

A conforming broker host embeds two host-side helpers re-exported from
`@noy-db/hub/broker` — `issueChallenge()` (nonce mint, TTL-clamped to `[10 s, 60 s]`) and
`verifyBrokerProof(args)` (burn-then-verify) — the exact same primitives the shipped tests
exercise (`packages/hub/__tests__/broker/support.ts`, `proof.test.ts`). Around them, **every**
conforming host MUST/SHOULD implement four obligations. Skipping (a) or (b) breaks the
candor table above; skipping (c) or (d) degrades availability, not confidentiality.

- **(a) KMS-wrap registered proof keys at rest — MANDATED, not optional (F3).** The host
  MUST store each registered proof key wrapped under a broker-side KMS key and unwrap only
  in-memory at verify time. Symmetric HMAC verification means a read-only leak of an
  *unwrapped* key store is credential-equivalent — this is the one control that prevents that.
- **(b) Atomic single-use challenge burn, before any MAC work (F2).** The `consumeChallenge`
  callback passed to `verifyBrokerProof` MUST atomically test-and-delete the challenge; a
  second presentation of the same challenge must fail even with a byte-identical, unexpired,
  otherwise-valid proof.
- **(c) SHOULD rate-limit `/credentials` per `(vaultId, brokerId)` (I10).** Bounds the
  multi-tab credential-amplification surface. App-side hooks + consent audit remain the
  primary controls; this is a defense-in-depth backstop, not a substitute.
- **(d) Accept old **and** new registrations for a short grace window on rotate (I5).** An
  in-flight proof computed under the pre-rotation seed (e.g. mid-sync-flush) must still
  verify; never drop the old registration the instant a new one lands.

The illustrative host below (Lambda/STS-shaped; swap the KMS/DynamoDB/STS clients for
whatever your infra uses) follows the exact control flow the shipped in-process test host
(`support.ts`) uses — issue a challenge, burn it **once** before any candidate-key loop, verify
against a KMS-unwrapped key, mint via STS — hardened with (a) and (c), which the test double
(correctly, since it isn't testing a real host) leaves out:

```ts
import { issueChallenge, verifyBrokerProof } from '@noy-db/hub/broker'
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms'
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts'
// registeredKeys / challenges / rateLimiter: any durable KV with an atomic
// delete-if-present (DynamoDB conditional delete, Redis DEL, etc.) works.

const kms = new KMSClient({})
const sts = new STSClient({})
const KMS_KEY_ID = process.env.BROKER_KMS_KEY_ID! // (a)
const keyOf = (vaultId: string, brokerId: string) => `${vaultId}:${brokerId}`

// ─── POST /enroll ──────────────────────────────────────────────
export async function handleEnroll(req: { vaultId: string; brokerId: string; proofKey: string }, attestation?: string) {
  if (!attestation || !(await verifyDevBackendSession(attestation))) return { statusCode: 401 }
  // (a) F3 — wrap BEFORE it ever touches durable storage. A read-only table
  // leak is otherwise credential-equivalent under symmetric HMAC (see the
  // candor table above).
  const { CiphertextBlob } = await kms.send(new EncryptCommand({
    KeyId: KMS_KEY_ID, Plaintext: Buffer.from(req.proofKey, 'base64'),
  }))
  // (d) I5 — APPEND, never overwrite: rotate() registers new before local
  // overwrite, so this key must coexist with any prior one for a grace window.
  await registeredKeys.append(keyOf(req.vaultId, req.brokerId), Buffer.from(CiphertextBlob!).toString('base64'))
  return { statusCode: 200 }
}

// ─── POST /challenge ───────────────────────────────────────────
export async function handleChallenge() {
  const { challenge, expiresAt } = issueChallenge()
  await challenges.put(challenge, { expiresAt }) // immutable once written
  return { statusCode: 200, body: { challenge, expiresAt } }
}

// ─── POST /credentials ─────────────────────────────────────────
export async function handleCredentials(req: { vaultId: string; brokerId: string; challenge: string; proof: string; profile?: string }) {
  if (!(await rateLimiter.allow(keyOf(req.vaultId, req.brokerId)))) return { statusCode: 429 } // (c) I10

  // expiresAt is immutable per challenge once written, so reading it is safe
  // without coordination; only the delete below needs to be atomic (F8/F2).
  const expiresAt = await challenges.peekExpiresAt(req.challenge)
  const burnedFresh = await challenges.deleteIfPresent(req.challenge) // (b) F2 — burn ONCE, before any candidate loop
  if (!burnedFresh || expiresAt === undefined) return { statusCode: 401 }

  const wrappedCandidates = await registeredKeys.allFor(keyOf(req.vaultId, req.brokerId)) // may hold old+new (d)
  let ok = false
  for (const wrapped of wrappedCandidates) {
    const { Plaintext } = await kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(wrapped, 'base64') }))
    ok = await verifyBrokerProof({
      consumeChallenge: async () => true, // already burned above — this call is trivially fresh
      registeredProofKey: new Uint8Array(Plaintext!),
      vaultId: req.vaultId, endpointOrigin: 'https://broker.example.com', brokerId: req.brokerId,
      profile: req.profile, challenge: req.challenge, expiresAt, proof: req.proof,
    })
    if (ok) break
  }
  if (!ok) return { statusCode: 401 }

  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: roleForProfile(req.profile),
    RoleSessionName: `broker-${req.vaultId}`.slice(0, 64),
    Tags: [{ Key: 'noydbVault', Value: req.vaultId }],
    Policy: scopedSessionPolicy(req.vaultId), // dynamodb:LeadingKeys / S3 prefix on the vault id
    DurationSeconds: 3600,
  }))
  return {
    statusCode: 200,
    body: {
      kind: 'aws', accessKeyId: Credentials!.AccessKeyId, secretAccessKey: Credentials!.SecretAccessKey,
      sessionToken: Credentials!.SessionToken, expiresAt: Credentials!.Expiration!.toISOString(),
    },
  }
}
```

## Pairs well with

- **`team`** — role gating (`owner`/`admin` only for `enroll`/`rotate`) reuses the same
  keyring roles `withTeam()` grants.
- **`session`** — a broker-fronted app typically also gates *app* sessions with
  `withSession()`; the two are independent (broker gates cloud-store access, session gates
  app-level tokens).

## Edge cases & limits

- **`_broker` is not a normal collection.** `vault.collection('_broker')` throws a reserved-
  collection error — the seed is reachable only through `vault.broker()`. A granted sub-admin
  keyring (operator, viewer, client) never receives the `_broker` DEK, so it cannot decrypt the
  seed even with API access to everything else; only owner/admin grantees do.
- **Enrol vs. use.** First-ever seed creation needs the vault's KEK (throws
  `BrokerEnrolmentError` — "re-authenticate" — on a DEK-only keyring, e.g. mid PIN
  quick-resume). Using an already-enrolled seed to mint credentials needs only the DEK.
- **Offline / broker-down.** A network failure or an unreachable host surfaces `NetworkError`
  from `credentialSource()`; a rejected proof surfaces `BrokerProofError`. Both are treated as
  offline-degradable by a syncing store — local writes queue, nothing is lost.
- **`profile` and `endpointOrigin` are bound into the MAC.** A proof captured at one `profile`
  (e.g. `'read'`) cannot be replayed at another (`'admin'`); a proof cannot be relayed to a
  different broker endpoint reusing the same `brokerId`.
- **`kind:'token'` stores** (postgres/turso/supabase/webdav) are not wired yet — the
  `StoreCredentials` type reserves the shape, but no store owns its refresh loop for it today.
- **Sealed-to-instance delivery** (encrypting the credential response to a specific device's
  keypair) is deferred to a future slice — see Non-goals.

## Non-goals

- Pushing the `credentials` refresh hook into the `NoydbStore` contract as a 7th method — it
  stays a construction-time factory option per store.
- A new `at-broker-*` package family — the broker is a `with-party` service, not a sealing-key
  provider.
- Hub-side rate limiting — the reference *host* SHOULD rate-limit (obligation c above); the
  hub library itself does not.
- Asymmetric client-signing enrolment — rejected; KMS-wrap (obligation a) is the accepted
  at-rest control for the symmetric-HMAC exposure.
- Sealed-to-instance credential delivery + instance identity (a non-extractable per-device
  keypair) — a distinct, independently-useful slice, not yet built.

## See also

- `docs/superpowers/specs/2026-07-05-credential-broker-spec.md` — the full implementation
  spec (threat model, protocol, key derivations, refusal matrix, phasing, conformance vectors).
- `packages/hub/src/kernel/enclave/broker/proof.ts` — the proof crypto (HKDF derivation, HMAC
  sign/verify, canonical-string construction).
- `packages/hub/src/with-party/broker/{strategy,active,seed,index}.ts` — the service (seed
  lifecycle, single-flight refresh cache, `withBroker()`).
- `packages/hub/__tests__/broker/*.test.ts` — the conformance suite this page's examples are
  lifted from.
