# Credential broker — passphrase-bound, rolling, non-extractable store auth (implementation spec)

**Date:** 2026-07-05 · **Status:** REVISED — hardened post-3-lens-audit 2026-07-05. Turns the decision-complete design brief (`2026-07-04-credential-broker-design.md`, all 7 owner-decisions RESOLVED 2026-07-05) into exact type names, file paths, derivations/salts, refusal cases, phasing, conformance vectors, and governance — then folds a **3-lens adversarial security audit** (crypto/protocol · lifecycle/state · adapter/cross-repo; all three verdicts **HARDEN-BEFORE-PLAN, no redesign**). The design core survives; the audit proved the spec relied on protections/refresh-semantics that don't hold, and this revision replaces them. See the **Audit-resolution map** below. It does **not** re-litigate any resolved decision.
**Cross-repo + cross-PR dependency (audit C1/C2):** the broker plan now **depends on a separate shipped-code security PR — `fix/reserved-secret-collection-leak`** — landing first. That PR ships the generalized reserved-secret-collection `vault.collection()` reject **and** the grant-propagation fix that excludes secret-bearing reserved DEKs from sub-admin keyrings. The broker **rides** it (adds `_broker` to both sets); the broker spec must not claim an existing guard.
**Issue:** #479 · **Builds on:** the `/to` port model (`2026-07-02-family-doors-kernel-diet-design.md`), record-scoped sealing (`2026-06-29-306-record-scoped-sealing.md`, the `sealRsaOaepTlv` wire format + `RecipientHint` v1), the enclave Contract v1 barrel (`2026-07-03-enclave-contract-v1-design.md`), and the `/cargo` cross-repo publish precedent (#552). Spans **two repos**: `noy-db` (hub seam + broker service) and the sibling `noy-db-to` (adapter-hook adoption for the AWS stores).
**Precedents bound (verified, with sites):**
- `_sync_credentials` reserved collection (`with-party/team/sync-credentials.ts`: reserved `_`-prefixed collection, dedicated role-gated API, encrypted under the collection DEK, never reachable via `vault.collection()`) — the model for the `_broker` seed namespace.
- `deriveClassifyIndexKey` / `mintBidxTag` (`kernel/enclave/classify/bidx.ts`) and `derivePresenceKey` (`kernel/enclave/crypto.ts:491`) — the HKDF→non-extractable-`['sign']`-HMAC key derivation shape, salt-string + injective JSON-array `info` convention, and raw-bits-`fill(0)` hygiene (`managed-passphrase.ts:221`).
- `withClassified()` service wiring (`with-shape/classified/{strategy.ts,active.ts,index.ts}`: `NO_*` throwing stub, dynamic-import `active.ts` seam delegating to `kernel/enclave/classify/**`) — the template for `withBroker()`.
- `sealRsaOaepTlv` / `parseRsaOaepTlv` / `RecipientHint` v1 `'rsa-oaep-sha256'` (`managed-passphrase.ts:205-256`, `MemoryRecipientSealer`) — the slice-3 sealed-delivery wire format, reused verbatim.
- `/to` port (`packages/hub/src/port/to/index.ts`) + its golden (`__tests__/to-surface-golden.test.ts` / `to-surface.golden.json`); `StoreAuth`/`StoreAuthKind` (`kernel/types.ts:2009-2022`, declared-only — decision 6 leaves it untouched).

---

## Audit-resolution map

Two audit passes fold into this spec. **(1) Self-findings (H-1..H-6)** surfaced while pinning the brief's decision-complete core into an implementation — a hardening + exactness pass, not a redesign. **(2) The external 3-lens adversarial audit (2026-07-05)** landed **2 Critical + a batch of Important/Minor/Info** across crypto/protocol, lifecycle/state, and adapter/cross-repo; all three lenses verdict **HARDEN-BEFORE-PLAN, no redesign**. Every finding below is folded into this revision; every Critical/Important also lands as a §8 conformance vector.

**Self-findings (from the brief-to-spec pinning pass):**

| Finding | One-line | Resolved in |
|---|---|---|
| H-1 (candor) | "Non-extractable" scopes to *capability-cloning at rest*; a resident XSS while unlocked can re-run `deriveBits` from the seed and use/export a fresh proof key | §1 threat model + §2 candor + §8 vector V12 (WebCrypto-bound, repo #306 D5 precedent) |
| H-2 (protocol) | Symmetric HMAC verification requires the broker to hold the **same** key bytes → enrolment MUST transmit the derived proof bits once (they are extractable at derive-time); "non-extractable" applies only to the *steady-state signing key*, never the enrolment transmission | §2 enrolment + §3 derivation (deriveBits output is registered; the imported `['sign']` key is the non-extractable steady-state form) + OQ1 (resolved — §1 candor + F3 KMS-wrap) |
| H-3 (types) | The two new adapter types must be **defined in `kernel/types.ts` and re-exported** through the `/to` re-export block, not declared inline in `port/to/index.ts`, or the golden's `export type { … } from` source-parse won't freeze them | §5 (exact edit sites) + §8 vector V14 |
| H-4 (naming) | `StoreCredentials.kind` (`'aws'|'token'`) is the credential-*payload* discriminator; it is **orthogonal** to `StoreAuthKind` (`'iam'|'api-key'|…`, which the `to-postgres`/`turso`/`supabase` stores declare). A `'token'` credential legitimately feeds an `'api-key'`-declared store | §4 + §5 (no coupling; StoreAuth untouched) + §9 Non-goals (`kind:'token'` adoption is a later slice) |
| H-5 (availability) | Broker outage must degrade to offline-queue, surfaced as `NetworkError` at the store — never data loss | §6 error matrix R-B4 + §8 vector V13 |
| H-6 (single-flight) | The refresh cache must be single-flight keyed by `profile` so concurrent near-expiry reads mint exactly one credential | §3 cache + §8 vectors V8/V9 |

**External 3-lens adversarial audit (2026-07-05):**

| Finding | Sev | One-line | Resolved in |
|---|---|---|---|
| C1 | Critical | `_broker` is **NOT** blocked from `vault.collection()` — R-B6's "existing `_`-prefix guard" is fiction (`vault.ts:856-867` rejects only `_dict_*`/`_sequences`/`_links_*`). | §3 `_broker` namespace (SHIP a new reject, mirror `isLinkCollectionName`) + R-B6 rewrite + §8 V11 · root fix in the `fix/reserved-secret-collection-leak` PR the broker rides |
| C2 | Critical | `grant()` wraps **every** `_`-prefixed DEK into every new keyring (`keyring.ts:483-487`); "metadata leak" comment is FALSE for secret-bearing `_broker` → a granted operator reads the plaintext seed → mints proofs → "user-bound" void. | §2/§3 (exclude the `_broker` DEK from sub-admin grant propagation — the secret-bearing-reserved excluded set) + R-B7 + §8 V17 · root fix in `fix/reserved-secret-collection-leak` |
| F1 | Critical (multi-profile) | Proof MAC omits `profile`; a captured `{challenge,proof}` re-submitted with a higher-priv `profile` still verifies → escalation via a semi-trusted routing layer. | §2 step 3/5 + §3 canonical (`profile ?? ''` in BOTH compute/verify) + §8 V18 · **resolves OQ2** |
| F2 | Important | Single-use burn delegated out of the audited primitive; a host that forgets/races leaves the proof replayable for the TTL. | §2 step 5 + §3 `verifyBrokerProof` (atomic **burn-and-check-fresh BEFORE the MAC compare**; paired `consumeChallenge`) + §8 V5 |
| F3 | Important (candor) | A read-only leak of the broker's registered-key store is **credential-equivalent** (symmetric HMAC) unless wrapped at rest. | §1 DOES-NOT-defeat row + §7 (MANDATE broker-side KMS-wrap of registered proof keys) + §2 candor · **resolves OQ1**; NOT asymmetric |
| F4 | Important | Key binds `brokerId` not endpoint; `brokerId` reuse across endpoints → cross-endpoint relay confused-deputy. | §2/§3 canonical binds the broker endpoint origin + `BrokerConfig` JSDoc mandates globally-unique `brokerId` + §8 V19 · **resolves OQ3** |
| F5 | Minor | Zeroing not mandated on throw paths; the `_broker` seed is **durable** secret material (recovery.ts pattern, not the ephemeral-CEK happy-path). | §3 (`try{}finally{}` zero `seedBytes` AND `proofBits` on every path incl. throw, cites `recovery.ts:276-307`) |
| F6 | Minor | "constant-time compare" underspecified; `timingSafeEqual` is Node-only (banned by `hub-portable`). | §3 (`verifyBrokerProof` uses `crypto.subtle.verify('HMAC', …)` — portable, internal constant-time; drop manual-compare) |
| F7 | Minor | `instancePid ?? ''` collides absent-vs-empty; V2 asserts instance-binding with no mechanism. | §2/§3 (forbid empty `instancePid`; `verifyBrokerProof` MUST match `instancePid` against the registered `instanceHint`, slice 3) + §8 V2 |
| F8 | Minor | `expiresAt`/`challenge` must be MAC'd **byte-for-byte as issued** (reparse/reformat → self-inflicted 401). | §3 (broker persists + MACs the EXACT emitted strings, never a re-serialized copy) |
| F9/F10 | Info | HKDF salt unversioned while MAC tag is `-v1` (consider versioning the salt); RSA-OAEP-2048 adequate for ≤1h creds. | §3 note (salt-version deferred; no dual-query today) |
| I3 | Important | First enrol needs the **KEK** (creates the `_broker` DEK via `ensureCollectionDEK`→`persistKeyring`, which throws when `kek===null`) — contradicts §1/R1 "needs a DEK not the KEK". | §1/§3/R1 reframe (**use** needs a DEK; **enrol/DEK-provisioning** is a tier-1 KEK-present op) + R-B8 |
| I4 | Important | Enrol not concurrency-safe: two tabs both see seed absent → two different DEKs, last-write-wins → orphaned-DEK `TamperedError`; divergent seeds POSTed. | §2/§3 (serialize enrol behind a create-if-absent CAS on the seed record; version conflict → re-read) + §8 V20 |
| I5 | Important | `rotate()` is non-atomic two-phase (local overwrite + remote re-register) with a torn-proof window → `BrokerProofError` mid-sync. | §2 rotate (quiesce the single-flight cache via epoch bump/abort **before** overwrite; register-new-then-overwrite; broker accepts old+new for a grace window) + §8 V21 |
| I6 | Important | (a) A rejected in-flight promise retained in the cache wedges all future calls; (b) a minted TTL < skew is born-stale → re-prove thrash. | §3 cache (clear-on-reject via `try/finally`; clamp effective lifetime to a floor `max(expiresAt−skew, now+minCacheMs)`; reject minted TTLs < 2×skew) + §8 V22 |
| I7 | Important | `rotateKeys` torn-write can strand the `_broker` seed under an unsaved DEK (the #578 D-5 hazard) when `_broker` is batched with a mixed perRecordKeys collection. | §3 rotation (rotate `_broker` in **isolation**, never batched; or two-phase `rotateKeys`) — the C2 propagation-exclusion also shrinks this exposure |
| I8 | Important | "never data loss" (H-5/R-B4/V13) covers only the `NetworkError` arm; a transient `BrokerProofError` mid-flush (from I5/I7) isn't specified as offline-degradable → possible dropped op. | §6 R-B4 (ALL `credentialSource` throws — network **and** proof — degrade a sync flush to requeue-not-drop) + §8 V13b |
| I9 | Minor | Partial enrol: seed persisted before `/enroll` POST; a 401 leaves seed-without-registration → `BrokerProofError` until retry. | §2 enrol (two-phase commit; gate `credentialSource` behind a `registered` flag so it fails fast/clear) + §8 V23 |
| I10 | Info | Multi-tab credential amplification. | §7 (reference host SHOULD rate-limit `/credentials` per `(vaultId,brokerId)`) |
| I11 | Info (slice-3) | Instance keypair outlives its unlock unless cleared. | OQ4 (bind keypair deletion to logout/lock; shared-vs-per-tab `instancePid`) |
| A1 | Important | On `kind:'aws'`, silently rolling creds requires `mapAws` to emit `expiration: Date` so the SDK memoizer re-invokes; otherwise rolling is defeated. **SDK owns AWS refresh.** | §4 (`mapAws` sets `expiration: new Date(expiresAt)`; V-A1/A2/A3 store-managed language is **`kind:'token'`-path only**) + §8 V-A1..A3 scoped |
| A2 | Important | `V-A1..A4 "enforced by adapter-conformance"` is false — the harness has **no credential hook** (`runStoreConformanceTests` drives only CRUD). | §4/§8 (downgrade to hand-written per-store tests, OR scope a NEW conformance module — spy-source + rebuild observer + forced-refresh — as explicit slice-1 work; don't claim existing capability) |
| A3 | Minor | The peer-floor bump keeping adopting stores' `.d.ts` sound is UNGUARDED (`hub-peer-range` checks shape, not floor value). | §7 (state the floor bump is a **manual correctness gate**) |
| A4 | Minor | `strategy-opt-in`'s `vault.broker()` catch fires only at files that inline-call `createNoydb(` (`check-architecture.mjs:388`; "5 of 12 seams"). | §7 (soften "trips the static scan" → "at inline-construction sites") |
| A5 | Minor | `mapAws` exact field mapping unspecified (root of A1). | §4 (`accessKeyId`/`secretAccessKey`/`sessionToken`/`expiresAt`→`expiration: Date`) |
| A6 | Info | Stale `to-surface.golden.json:3` `"source"` points at `src/kernel/to/index.ts`; real path is `src/port/to/index.ts`. | §7 (correct the golden `source` metadata) |

**Verified-accurate (kept — the seam mechanics are sound):** H-3 re-export freezing works (`to-surface-golden` parses `export type {…} from`; an inline-declaration version would have shipped UNFROZEN — this spec correctly overrode) · `/adapter` alias byte-identical (named re-exports, not `export *`) · AWS `getClient` path accurate (region/endpoint only → ambient chain; `client?` path early-returns) · H-4 `StoreAuthKind` orthogonality (`none|filesystem|api-key|iam|oauth|kerberos|browser-origin`, disjoint from `aws|token`) · `STRATEGY_GATED_APIS` `{api,option,factory}` shape correct · `hub-portable` permits `fetch` · `no-crypto-deps` fine · cross-repo hub-first ordering genuinely forced · domain separation clean (no `noydb-broker*` salt collision; dedicated seed, no cross-subsystem key overlap) · V1/V3/V4/V6/V7/V15 hold · non-extractable-handle candor honest (bidx defense-in-depth framing).

---

## 1. Threat model — what each requirement buys (carried from brief §1, tightened)

Store-access credentials gate **availability / tamper / deletion** of ciphertext, never its confidentiality — that rests on the enclave, unchanged. The zero-knowledge law is preserved: the passphrase and KEK never leave the client; the broker sees only a challenge proof and (slice 3) seals *to* the instance. The stolen-ciphertext story is unchanged.

| Requirement | Defeats | Does NOT defeat (candor — shipped in the docs, not polish) |
|---|---|---|
| **Rolling** (short-lived, rotating) | A credential lifted from a memory dump, crash/proxy log, or devtools session is dead within TTL (minutes–1 h). Revocation = broker stops re-issuing; no client-side rotation ceremony. | Live abuse **within** TTL. |
| **Non-extractable** | An attacker copying the app bundle, `localStorage`, or IndexedDB **at rest** gets nothing replayable: the steady-state proof key is a WebCrypto `extractable:false` `['sign']` HMAC key; the seed is at-rest ciphertext under the vault DEK. With slice 3 the instance RSA-OAEP private key is `extractable:false` — even in-page script cannot `exportKey` it. | **A resident XSS attacker while the vault is unlocked.** Such an attacker can (a) drive the whole proof flow with the live non-extractable key and exfiltrate the *short-lived creds it yields*, and (b) — the stronger bound this spec makes explicit (H-1/H-2) — re-run `deriveBits` from the decrypted seed to mint a **fresh** proof key, because the seed's bytes are re-derivable while unlocked. WebCrypto non-extractability denies **capability-cloning** (offline/later/elsewhere reuse of a *handle*), not **live in-page use or re-derivation**. Any browser design claiming more is overclaiming (repo #306 D5 erasure-scope candor precedent). The non-extractable import is **defense-in-depth against a leaked handle only** — exactly the `bidx.ts` Crypto-#4 framing. |
| **User-bound** (`access = f(app config, unlocked keyring)`) | App config alone (bundle constants, endpoint URLs, table names) grants **zero** cloud access — the broker refuses without a proof derivable only from a decrypted `_broker` seed. **Enrol-vs-use split (I3, the R1 correction made exact):** *using* an existing seed (read → derive → prove) needs only the `_broker` **DEK**, available on every unlock path that can decrypt — including PIN quick-resume / session-restore where the KEK is `null`; *first enrol / DEK-provisioning* creates the `_broker` DEK via `ensureCollectionDEK`→`persistKeyring`, which **throws when `kek===null` (`keyring.ts:1281-1288`)**, so enrol is a **tier-1 (KEK-present) operation** and must surface a clear error on a keyring that only holds a DEK (R-B8). Per-user STS session tags (`{ noydbVault, noydbUser }`) + a scoped inline session policy (`dynamodb:LeadingKeys` / S3 prefix on the vault id) let the cloud enforce per-vault scoping so user A's creds cannot read user B's ciphertext rows. | A compromised **broker host**: it is the credential authority; its compromise mints creds for anyone. Outside the zero-knowledge boundary **by design** — the broker still never sees passphrase, KEK, DEK, or plaintext (§2). Same trust class as the `at-*` family. |
| **Symmetric-verifiable** (broker holds the same key it verifies) | A forged *client* proof grants nothing the broker cannot already grant itself — it **is** the credential mint (§2 candor). Domain-separated per `(vaultId, brokerId)`; one-way HKDF output registered, never the seed. | **A read-only leak of the broker's registered-key store (F3, OWNER-RESOLVED — sharpened, not redesigned).** Because verification is symmetric HMAC, a registered proof key **is** a forgeable credential — an attacker who reads the key-DB can mint valid proofs for any registered vault and pull cloud creds. This is **credential-equivalent unless the store wraps registered keys at rest under a broker-side KMS key** (mandated, §7): with KMS-wrap a read-only DB leak yields only ciphertext the attacker cannot unwrap without also compromising the KMS grant. Asymmetric enrolment (register only a public verifier) would defeat this structurally but is **rejected** (decision 2 — WebCrypto cannot portably derive a deterministic keypair from HKDF output; HSM/KMS-wrap is the accepted mitigation, not a key-shape change). |
| **Transparent** (dev wires cloud at setup; user never sees it) | Nothing — UX/product, not security. Listed so we do not pretend otherwise. | — |

**Enrolment attestation (decision 1).** `/enroll` requires the app's existing developer-backend session/auth token; the broker refuses enrolment without it. This closes the TOFU vault-id-squatting hole (an anonymous client cannot register a proof key for an arbitrary `vaultId`). The reference host (§7) shows the check.

## 2. Protocol — enrol / challenge / mint / refresh / rotate / revoke

**What the broker learns:** `vaultId`, `brokerId`, a registered 32-byte HKDF output (one-way; inverts to nothing), the requested `profile`, request timing/IP, and the dev-backend attestation identity at enrol. **What it never learns:** passphrase, KEK, any DEK/CEK, collection names, record contents, or the broker **seed** (only the *derived* proof bits are registered; re-derivation under a new `brokerId` yields an unlinkable key).

**Enrolment** (`CredentialBrokerHandle.enroll()`, idempotent — a **two-phase commit**, I9):
1. Decrypt-or-**create** the seed under a **create-if-absent CAS** (I4): read `_broker/<brokerId>`; if absent, mint 32 random bytes and persist encrypted **with an optimistic version-guard** (write iff still absent). A concurrent enrol that loses the CAS re-reads the winner's seed rather than persisting a second one — two tabs never generate two DEKs/seeds for one `brokerId` (the pre-CAS bug: divergent DEKs → last-write-wins → orphaned-DEK `TamperedError`). **Enrol is a tier-1 (KEK-present) op (I3):** first-seed creation calls `ensureCollectionDEK`→`persistKeyring`, which throws when `kek===null`; enrol on a DEK-only keyring (PIN quick-resume / session-restore) surfaces `BrokerEnrolmentError` with a "re-authenticate to enrol" message (R-B8), never a raw `persistKeyring` throw. Requires owner/admin role.
2. Derive the proof bits (§3): `proofBits = HKDF(seed, salt 'noydb-broker-proof', info ['noydb-broker-proof', vaultId, brokerId])` → 256 bits.
3. `POST /enroll` with `{ vaultId, brokerId, proofKey: base64(proofBits) [, instanceHint (slice 3)] }` **plus** the dev-backend attestation token (from `BrokerConfig.attestation()`), sent as an `Authorization`-style header the reference host validates. The broker **wraps `registeredProofKey` under its KMS key before storing** (§7, F3) `(vaultId, brokerId) → wrap(registeredProofKey)`. (H-2: the derive-time bits are extractable by nature — this one-time TLS-protected registration is the symmetric-key share; the steady-state `['sign']` import at step "challenge" is the non-extractable form.)
4. **Commit:** only after a 2xx from `/enroll` does the handle mark the seed record `registered: true` (a field on the `_broker` record, I9). `credentialSource` refuses (fail-fast `BrokerEnrolmentError`) while `registered !== true`, so a seed persisted at step 1 whose `/enroll` POST 401'd does not silently degrade later mints into opaque `BrokerProofError`s. Zero `proofBits` in a `finally` after both base64-encoding and any throw (F5).

**Challenge–response mint** (`StoreCredentialSource` refresh, or explicit):
1. Client → `POST /challenge { vaultId, instancePid? }`.
2. Broker → `{ challenge: base64(32 random bytes), expiresAt: ISO }`; stored server-side **single-use**, TTL ≤ 60 s. The broker persists the **exact `challenge`/`expiresAt` strings it emitted** and MACs those bytes verbatim on verify (F8 — never a reparsed/reformatted copy, which would self-inflict a 401 on ms-precision or `Z`-vs-`+00:00` drift). The broker SHOULD reject/clamp a minted TTL below `2×skewMs` (I6b — a sub-skew credential is born stale).
3. Client re-derives `proofBits` from the seed, imports the non-extractable `['sign']` HMAC key, computes `proof = base64(HMAC-SHA-256(proofKey, canonical))` where `canonical = JSON.stringify(['noydb-broker-proof-v1', vaultId, endpointOrigin, brokerId, profile ?? '', instancePid ?? '', challenge, expiresAt])`, then zeroes `proofBits` in a `finally`. **`profile` is bound into the MAC (F1)** — a proof captured at a low-priv `profile` cannot be re-submitted at a higher-priv one. **`endpointOrigin` is bound (F4)** — a proof cannot be relayed to a different broker endpoint that reuses the same `brokerId`. **`instancePid`, when present, MUST be non-empty (F7)** — absent (field omitted) and empty-string are distinct; empty is forbidden so `?? ''` cannot alias "no instance" to a real registered instance.
4. Client → `POST /credentials { vaultId, challenge, proof, profile }`.
5. Broker `verifyBrokerProof(...)`: **atomically burn-and-check-fresh the challenge FIRST** (single-use consumption is folded into the audited primitive, F2 — burn-on-presentation, not on success; a replay within TTL finds the challenge already consumed and 401s before any MAC work), then recompute HMAC over the same canonical (**same `profile`, `endpointOrigin`, `expiresAt` verbatim**) against the KMS-unwrapped `registeredProofKey` and compare via `crypto.subtle.verify('HMAC', …)` (constant-time, portable — F6), assert `now < expiresAt` (client clock never trusted — `expiresAt` rides inside the MAC), and (slice 3) match `instancePid` against the registered `instanceHint` (F7). On success mint scoped short-lived creds (§7), return `{ kind:'aws', …, expiresAt }` (≤ 1 h). Slice 3: seal the response to the instance hint.

**Replay protection:** server-random single-use challenge (burned on presentation, F2) + TTL; the proof binds `vaultId`, `endpointOrigin`, `brokerId`, `profile`, `expiresAt`, `challenge`, and (slice 3) `instancePid` — a proof cannot be replayed for another vault, another endpoint, another profile, another instance, a reused challenge, or after the window.

**Refresh / cache (decision 7 — persist-nothing default).** Credentials live only in a closure and die with the tab. The `StoreCredentialSource` returned by `credentialSource(profile)` holds a **single-flight, per-`profile` cache** whose in-flight promise is **cleared-on-reject via `try/finally`** (I6a — a rejected round-trip must never stay pinned in the cache map, wedging every future call; the `ensureCollectionDEK` precedent at `keyring.ts:1242-1246`). Cached creds are valid until a **floored** boundary `max(expiresAt − skewMs, now + minCacheMs)` (I6b — clamps a sub-skew TTL so it is not born stale and does not thrash re-prove every call); default `skewMs` 60 000 ms. Concurrent near-expiry calls await one in-flight `/challenge`+`/credentials` round-trip; a call past the boundary re-proves. Nothing is written to disk.

**Rotate** (`rotate()`) — **quiesce-then-swap, non-torn (I5):** (1) **quiesce** the single-flight cache — bump a `credentialSource` epoch and abort/await any in-flight round-trip so no closure is mid-proof with the old bits; (2) mint a fresh seed, **register the new proof key first** (`/enroll` with the new bits), then (3) overwrite `_broker/<brokerId>` locally. The broker **accepts both the old and new registration for a short grace window** so an in-flight sync flush that already computed a proof under the old key still verifies, closing the torn-proof `BrokerProofError` window (I5). Same `brokerId` by default (broker replaces the registration; optionally a new `brokerId` for unlinkability). **Revoke = re-enroll or delete the seed record** and let the broker drop the registration; there is no client-side key-rotation ceremony beyond this.

**Symmetric-HMAC candor (decision 2, accepted; F3 sharpened):** the broker holds the same key it verifies, so it could forge client proofs — a non-weakening at mint time, because the broker already **is** the credential mint (forging a proof to itself grants nothing it cannot grant anyway). The real exposure the audit surfaced is **at rest**: a read-only leak of the broker's registered-key store is **credential-equivalent** — an attacker with the key bytes mints valid proofs for any registered vault. The mandated mitigation (§7) is that the reference host **wraps every registered proof key under a broker-side KMS key**, so a DB-only leak yields unusable ciphertext. An asymmetric variant would remove the at-rest forgeability structurally but is rejected (WebCrypto cannot portably derive a deterministic keypair from HKDF output); KMS-wrap is the accepted control. HMAC-SHA-256 + KMS-wrap is the honest, simpler choice.

## 3. Keys, derivations, and the `_broker` seed lifecycle

All HKDF-SHA256, following the `derivePresenceKey` / `deriveSealedFieldKey` convention (salt = UTF-8 of a `noydb-*` domain string; `info` = UTF-8 of an **injective JSON-array** domain tag; non-extractable imported key; raw bits `fill(0)` after use).

**Proof-key derivation (P-C, brief §2), new enclave module `kernel/enclave/broker/proof.ts`:**

```
seedBytes  = 32 random bytes, decrypted from _broker/<brokerId>
hkdf       = importKey('raw', seedBytes, 'HKDF', /*extractable*/ false, ['deriveBits'])
proofBits  = deriveBits({ name:'HKDF', hash:'SHA-256',
                          salt: utf8('noydb-broker-proof'),
                          info: utf8(JSON.stringify(['noydb-broker-proof', vaultId, brokerId])) },
                        hkdf, 256)                              // 32 bytes — the value REGISTERED at /enroll
proofKey   = importKey('raw', proofBits, { name:'HMAC', hash:'SHA-256' },
                       /*extractable*/ false, ['sign'])        // steady-state, non-extractable
// proofBits.fill(0) after both (a) base64 for enrol AND (b) import for sign
proof      = base64(sign('HMAC', proofKey, utf8(canonical)))   // canonical per §2 step 3
```

Domain constants: `BROKER_PROOF_DOMAIN = 'noydb-broker-proof'` (HKDF salt **and** first `info` element) and the MAC version tag `'noydb-broker-proof-v1'` (first `canonical` element). `seedBytes` **and** `proofBits` are zeroed in a `finally` on every path incl. throw (F5, `recovery.ts:276-307` pattern). *(F9, info — the HKDF salt is unversioned while the MAC tag carries `-v1`; a future KDF change would version the salt, but there is no dual-query today so it is deferred, not shipped.)*

**New enclave functions (ADDITIVE to the Contract v1 barrel `kernel/enclave/index.ts`):**
- `deriveBrokerProofBits(seed, vaultId, brokerId): Promise<Uint8Array>` — the HKDF step (returns the raw bits, for one-time enrol registration).
- `deriveBrokerProofKey(seed, vaultId, brokerId): Promise<EnclaveKey>` — imports the non-extractable `['sign']` key (zeroes the transient bits).
- `computeBrokerProof(seed, vaultId, brokerId, canonicalParts): Promise<string>` — composes derive + sign for the client; `canonicalParts` carries `endpointOrigin`, `profile ?? ''`, `instancePid ?? ''`, `challenge`, `expiresAt` (F1/F4/F7). Zeroes `seedBytes` **and** `proofBits` in a `finally` on every path incl. throw (F5 — durable secret material, the `recovery.ts:276-307` `try{}finally{secret.fill(0)}` pattern, **not** the ephemeral-CEK happy-path of `managed-passphrase.ts:221`).
- `issueChallenge(opts?: { ttlMs?: number }): { challenge: string; expiresAt: string }` — host-side nonce mint; the caller persists the returned strings **verbatim** and MACs those exact bytes (F8).
- `verifyBrokerProof(args: { consumeChallenge, registeredProofKey, vaultId, endpointOrigin, brokerId, profile, instancePid?, challenge, expiresAt, proof }): Promise<boolean>` — **(1) `await consumeChallenge(challenge)` FIRST** (atomic burn-and-return-was-fresh — single-use consumption folded into the seam, not left to the host; burn-on-presentation, F2 — a not-fresh result short-circuits to reject before any MAC work); **(2)** recompute the canonical over the **same `endpointOrigin`/`brokerId`/`profile`/`instancePid`/verbatim `challenge`+`expiresAt`** (F1/F4/F7/F8) and compare with `crypto.subtle.verify('HMAC', importedRegisteredKey, proofBytes, canonicalBytes)` (constant-time, portable — no Node `timingSafeEqual`, F6); **(3)** assert `now < expiresAt`; (slice 3) assert `instancePid` matches the registered `instanceHint`. `registeredProofKey` arrives already KMS-unwrapped by the host (§7).
- (slice 3) `sealCredentialsToInstance(creds, hint)` / `openSealedCredentials(blob, privateKey)` — thin wrappers over `sealRsaOaepTlv` / `parseRsaOaepTlv` + `aesGcmOpen`.

**Why the crypto lives behind the enclave barrel (governance decision, justified — §7 governance).** Proof-key derivation and MAC signing/verification are **key/MAC ops over secret bytes** — precisely the class the `enclave-body-only` / `enclave-barrel-only` law confines to `kernel/enclave/**` (as `_det`, `_bidx`, and presence derivations are). The seed's at-rest **encryption** and the network/cache **orchestration** are ciphertext + plumbing, which the same law permits in the party layer — exactly mirroring `sync-credentials.ts` (party) using the enclave `encrypt`/`openEnvelopeJson`. So: crypto in `kernel/enclave/broker/proof.ts`; everything else in `with-party/broker/**`, delegating via a dynamic import through the barrel (the `classified/active.ts` seam).

**The `_broker` reserved namespace** (`with-party/broker/seed.ts`, modeled on `sync-credentials.ts`):
- Constant `BROKER_SEED_COLLECTION = '_broker'`. Record id = `brokerId`. Payload `{ brokerId, seed: base64(32B), endpoint, createdAt }`, encrypted under the `_broker` collection DEK via `ensureCollectionDEK` + `encrypt` (auto-generated on first use), stored as a normal `EncryptedEnvelope`.
- **Role-gated:** owner/admin only, via the `requireAdminAccess` pattern (`PermissionDeniedError` otherwise). Custodian is intentionally excluded — the seed is transport-auth material, not the custodian's operational scope (same rationale as `_sync_credentials`).
- **Not reachable via `vault.collection('_broker')` — but this guard does NOT exist today and the broker SHIPS it (C1).** The audit verified that `vault.ts:856-867` rejects **only** `_dict_*`/`_sequences`/`_links_*` (`isLinkCollectionName` et al.); there is **no generic `_`-prefix guard** — `_keyring`/`_sync_credentials` are convention-protected only. So the broker MUST add a new `vault.collection()` reject entry for `_broker` (mirroring `isLinkCollectionName`). This lands as part of the **generalized reserved-secret-collection guard shipped in the separate `fix/reserved-secret-collection-leak` security PR** (which also closes the identical shipped `_sync_credentials` readability hole); the broker **rides** that PR and adds `_broker` to its reserved set. **The spec claims no pre-existing guard.**
- **The `_broker` DEK MUST be excluded from `grant()` sub-admin propagation (C2 — a hard requirement, not a convenience).** The audit verified `grant()` (`keyring.ts:483-487`) wraps **every** `_`-prefixed collection DEK into every newly-minted keyring regardless of role; the code comment calling this "a metadata leak, not a plaintext leak" is **true for `_ledger`/`_history` but FALSE for `_broker`**, whose record *contents are the secret seed*. Left unfixed, any granted operator/client keyring can decrypt `_broker`, re-derive the proof key, mint cloud creds, and the "user-bound" property is **void**. Fix: exclude secret-bearing reserved collections (`_broker`, `_sync_credentials`) from the grant-propagation loop — the **excluded set** shipped by `fix/reserved-secret-collection-leak`; the broker spec states `_broker` is a member of that set. (This also shrinks the I7 `rotateKeys` torn-write exposure — a DEK never propagated to sub-admins is not dragged into their `revoke()`/`rotateKeys` affectedCollections.)
- **Lifecycle:** generate (enrol, idempotent, CAS-guarded — reuse existing unless `rotate()`; enrol is a KEK-present tier-1 op, I3), persist encrypted, decrypt-on-use (each proof derivation decrypts, derives, zeroes both `seedBytes` and `proofBits` in a `finally`, F5), rotate (quiesce cache → register-new → overwrite, I5), revoke (delete record + broker drops registration). Survives passphrase rotation and collection-DEK rotation of *other* collections (it is DEK-rooted on its own `_broker` DEK; **use** needs a DEK, **enrol/DEK-provisioning** needs the KEK — I3). **Rotate-`_broker`-in-isolation (I7):** whoever builds perRecordKeys-aware DEK rotation MUST rotate the `_broker` DEK **alone**, never batched with a mixed perRecordKeys collection whose `_cek` body could throw mid-loop (the #578 D-5 hazard, `keyring.ts:810-819`) and strand the seed under an unsaved DEK; or make `rotateKeys` two-phase (stage all re-encryptions → persist keyring → commit). The C2 propagation-exclusion already keeps `_broker` out of most sub-admin `rotateKeys` batches.

## 4. Adapter seam — the `credentials` refresh hook (decisions 4, 5)

**Contract shape (A-1): type-only addition to the `/to` port + a per-store factory option.** The hub port gains **types only**; each store adds `credentials?: StoreCredentialSource` to its own factory options and owns its client-rebuild mechanics. No new `NoydbStore` method (the 6-method contract is untouched; the hub never calls the source — only the app wires it).

**Exact type additions (defined in `packages/hub/src/kernel/types.ts`, re-exported by `/to` — H-3):**

```ts
/** Vendor-neutral short-lived store credentials. `kind` is the credential-PAYLOAD
 *  discriminator — orthogonal to StoreAuthKind ('iam'|'api-key'|…), which is unchanged. */
export type StoreCredentials =
  | { readonly kind: 'aws'
      readonly accessKeyId: string
      readonly secretAccessKey: string
      readonly sessionToken?: string
      readonly expiresAt?: string }              // ISO 8601
  | { readonly kind: 'token'                     // postgres/turso/supabase/webdav/bearer — a LATER slice
      readonly token: string
      readonly expiresAt?: string }

/** Refresh hook a store calls when it has no credentials or they are near expiry. */
export type StoreCredentialSource = () => Promise<StoreCredentials>
```

**Store-side discipline — two distinct refresh owners (A1, corrected).** The `kind:'aws'` and `kind:'token'` arms do **not** share a refresh mechanism:

- **`kind:'aws'` → the AWS SDK owns refresh.** `to-aws-dynamo` wires the source as a functional credential *provider* (`config.credentials = async () => mapAws(await source())`); the SDK's `memoizeIdentityProvider` re-invokes the provider at its own expiry window **iff each returned identity carries an `expiration: Date`**. Therefore `mapAws` **MUST** emit `expiration: new Date(creds.expiresAt)` — **exact field mapping (A5):** `{ accessKeyId, secretAccessKey, sessionToken, expiration: creds.expiresAt ? new Date(creds.expiresAt) : undefined }`. Omitting `expiration` silently defeats rolling (the SDK memoizes forever). The store does **not** run its own 60 s / rebuild / forced-retry logic on this arm — the SDK does. (No `credentials` key on `config` ⇒ ambient chain, preserved.)
- **`kind:'token'` (a LATER slice) → the store owns refresh.** For non-SDK token stores the store itself calls the source lazily on first use and when `expiresAt − now < 60_000 ms`, rebuilds its client on change, and on an auth error forces **one** refresh + retry before surfacing `NetworkError`. **The V-A1/V-A2/V-A3 store-managed vectors below apply to this `kind:'token'` path only** (A1).

**Testing the discipline (A2, corrected).** These behaviours are **NOT** covered by `adapter-conformance` — `runStoreConformanceTests` constructs a `NoydbStore` and drives only CRUD; `credentials` is a per-store factory option the harness never sees, and V-A4 is AWS-SDK-specific (not vendor-neutral). Slice 1 therefore ships them as **hand-written per-store tests** (CLAUDE.md permits) — **or**, if a reusable harness is wanted, scopes a **new conformance module** (spy credential-source + client-rebuild observer + forced-refresh injector) as explicit slice-1 work. The spec does **not** claim the existing harness enforces this.

**Slice-1 AWS wiring (decision 5).** `credentials` ships **vendor-neutral**; slice 1 exercises only the `kind:'aws'` arm:
- `to-aws-dynamo` (`noy-db-to`, `dynamo(options: DynamoOptions)`): add `credentials?: StoreCredentialSource` to `DynamoOptions`; thread into the lazily-built `config` object (the `getClient` fallback at `to-aws-dynamo/src/index.ts:110-112`, which today sets only `region`/`endpoint` and no `credentials` key → ambient chain) as `config.credentials`. The pre-built `client?: DynamoDocClient` path is unchanged (an app supplying its own client owns its provider).
- `to-aws-s3` (`noy-db-to`): same option shape.
- `as-aws-s3` (**this repo**, `packages/as-aws-s3` — plaintext-by-design `as-*` family): same option by **direct import** of `StoreCredentialSource`, no port involvement.

The `kind:'token'` arm (`to-postgres`/`turso`/`supabase`) is a later slice (H-4: those stores declare `StoreAuthKind: 'api-key'`, which is unrelated to the credential payload discriminator; a `'token'` credential feeding an `'api-key'`-declared store is correct and requires no `StoreAuth` change).

**Versioning / seam consequences (this IS an adapter-contract change — loud by design):**
- `/to` is golden-frozen (`__tests__/to-surface-golden.test.ts` imports `../src/port/to/index.js`): an additive change is a **visible baseline update** to `to-surface.golden.json` (`types` array gains `StoreCredentials`, `StoreCredentialSource`) + the compile-time `import type` pin. Allowed.
- `/adapter` (the deprecated alias) stays **byte-identical** to its historical symbol set — the new types go to `/to` **only**; its golden is untouched.
- noy-db-to `check-architecture.mjs` rules all pass unchanged: `hub-peer-range` (import stays `@noy-db/hub/to`), `to-only` (only the `/to` subpath), `no-crypto-deps` (credentials are opaque strings, not crypto).
- Per the family discipline ("a hub release forces a noy-db-to rebuild only when the store contract changes") **this is exactly such a release** — see §7 cross-repo sequencing.

## 5. Broker service wiring in hub (decision 3)

New opt-in service **`@noy-db/hub/broker`** with `withBroker()`, at `with-party/broker/` (party dimension — identity/auth, adjacent to `sync-credentials`). Mirrors `withClassified()` exactly:

- **`with-party/broker/strategy.ts`** — the `BrokerStrategy` interface + `NO_BROKER` throwing stub:
  ```ts
  export interface BrokerStrategy {
    enroll(ctx: BrokerCtx): Promise<void>
    rotate(ctx: BrokerCtx): Promise<void>
    credentialSource(ctx: BrokerCtx, profile?: string): StoreCredentialSource
  }
  export const NO_BROKER: BrokerStrategy = {
    async enroll()  { throw new BrokerNotEnabledError() },
    async rotate()  { throw new BrokerNotEnabledError() },
    credentialSource() { throw new BrokerNotEnabledError() },
  }
  ```
  `BrokerCtx` carries `{ store, vault, keyring, config }` (the seed API needs `store`+`vault`+`keyring`; the network client needs `config`).
- **`with-party/broker/active.ts`** — `withBroker(config: BrokerConfig): BrokerStrategy`, each method dynamic-importing the seed lifecycle (`./seed.js`) and the enclave crypto (`../../kernel/enclave/index.js`), so the impl is tree-shaken until opted in.
- **`with-party/broker/index.ts`** — barrel exporting `withBroker`, `NO_BROKER`, the client surface types (§ below), the error classes, and the **host helpers** `issueChallenge` / `verifyBrokerProof` / (slice 3) `sealCredentialsToInstance` (re-exported from the enclave barrel — a Lambda/Worker imports `@noy-db/hub/broker` and gets them, `crypto.subtle`-only).

**Client surface (`@noy-db/hub/broker`, refined from brief §3):**
```ts
export interface BrokerConfig {
  readonly brokerId: string                       // stable id; part of the HKDF info tag AND the proof canonical.
                                                  // MUST be globally-unique / endpoint-derived (F4) — reusing one
                                                  // brokerId across two endpoints enables cross-endpoint relay.
  readonly endpoint: string                       // https broker base URL; its origin is bound into the proof MAC (F4)
  readonly attestation?: () => string | Promise<string>  // dev-backend session token for /enroll (decision 1)
  readonly fetch?: typeof fetch                    // DI for tests / non-window runtimes
  readonly skewMs?: number                         // refresh margin, default 60_000
}
export interface CredentialBrokerHandle {
  enroll(): Promise<void>                          // generate+persist seed (idempotent), register proof key
  rotate(): Promise<void>                          // rotate seed + re-register (revokes old proof key)
  credentialSource(profile?: string): StoreCredentialSource  // single-flight, per-profile cache to expiresAt − skew
}
export function withBroker(config: BrokerConfig): BrokerStrategy
```

**Vault accessor:** `vault.broker(): CredentialBrokerHandle` on `kernel/vault.ts` (kernel-api golden addition), backed by `brokerStrategy` (default `NO_BROKER`); it throws `BrokerNotEnabledError` when not opted in. Wiring parallels `classifiedStrategy`: a `brokerStrategy?: BrokerStrategy | undefined` option on `NoydbConfig` (`kernel/collection-config.ts`), defaulted `?? NO_BROKER`.

**Bundle impact: 0 bytes when not opted in** (NO_BROKER stub + `active.ts` dynamic-import seam, tree-shaken). Est. ~400–600 LOC when opted in (seed lifecycle + HKDF/HMAC in the enclave module + challenge client + refresh cache). No new npm deps — `crypto.subtle` + `fetch` only, so `hub-portable` and `no-crypto-deps` pass untouched.

## 6. Refusal & error matrix

| # | Condition | Enforced at | Error / outcome |
|---|---|---|---|
| R-B1 | `vault.broker()` without `withBroker()` | vault accessor, `NO_BROKER` stub | `BrokerNotEnabledError` (message points to `withBroker()` from `@noy-db/hub/broker`) |
| R-B2 | seed op (`enroll`/`rotate`/read) by a non-owner/admin role | `with-party/broker/seed.ts` `requireAdminAccess` | `PermissionDeniedError` |
| R-B3 | `/enroll` without a valid dev-backend attestation | **reference host** (§7) + client surfaces host 401/403 | `BrokerEnrolmentError` |
| R-B4 | broker host unreachable / `/challenge` / `/credentials` network failure — **OR any `credentialSource` throw during a sync flush, incl. a transient `BrokerProofError` from an I5/I7 torn window (I8)** | `credentialSource` throws; **store** catches, forces one retry, then surfaces; **the sync layer treats ALL `credentialSource` throws (network AND proof) as offline-degradable — requeue, not drop** | store `NetworkError` — offline writes queue; a mid-flush `BrokerProofError` also requeues; **never data loss** (H-5/I8) |
| R-B5 | proof rejected (MAC mismatch, expired `expiresAt`, reused/**burned** challenge, wrong `profile`/`endpointOrigin`/`instancePid`) | reference host `verifyBrokerProof` (challenge burned-on-presentation before compare) → 401; client surfaces | `BrokerProofError` |
| R-B6 | `vault.collection('_broker')` | **new `vault.collection()` reject the broker SHIPS** (rides the generalized reserved-secret-collection guard in `fix/reserved-secret-collection-leak`; C1 — there is no pre-existing `_`-prefix guard) | reserved-collection error |
| R-B7 | a granted sub-admin/operator/client keyring attempting to decrypt `_broker` (the seed) | `grant()` propagation **excludes** the `_broker` DEK (secret-bearing-reserved excluded set, `fix/reserved-secret-collection-leak`; C2) | `_broker` DEK absent from the sub-admin keyring → decrypt impossible (not merely refused) |
| R-B8 | `enroll()` on a DEK-only keyring (`kek===null`: PIN quick-resume / session-restore) — first-seed provisioning needs the KEK (I3) | `with-party/broker/seed.ts` intercepts the `ensureCollectionDEK`→`persistKeyring` `kek===null` throw | `BrokerEnrolmentError` ("re-authenticate to enrol"), never a raw `persistKeyring` throw; **use** of an existing seed is unaffected (DEK suffices) |

New error classes (`kernel/errors.ts`, additive): `BrokerNotEnabledError`, `BrokerEnrolmentError`, `BrokerProofError`. `PermissionDeniedError` and store `NetworkError` are reused. R-B6/R-B7 land in the `fix/reserved-secret-collection-leak` PR (the broker rides it, adds `_broker` to both the reserved-name set and the grant-excluded set).

## 7. Governance & cross-repo sequencing

**SERVICES.md.** New row in **Cluster G (Collaboration & Auth)**: `@noy-db/hub/broker` · `withBroker()` · "Passphrase-bound rolling non-extractable store-auth broker (enrol/challenge/credentials + refresh hook)" · ~500 LOC off-bundle · pairs with `team`, `session`. A service doc page `noy-db-docs/content/docs/services/broker.md` follows the standard template and embeds the ~100-line reference Lambda.

**Reference-host mandated obligations (documented in the doc page + reference Lambda):**
- **KMS-wrap registered proof keys at rest (F3, MANDATED — not optional).** The host MUST store each `registeredProofKey` wrapped under a broker-side KMS key and unwrap only in-memory at verify time. A read-only leak of the key store is otherwise **credential-equivalent** under symmetric HMAC (§1/§2 candor). Promote from "nice-to-have HSM aside" to a stated security requirement of any conforming host.
- **Single-use challenge store with atomic burn-on-presentation (F2).** The `consumeChallenge(challenge)` the host passes to `verifyBrokerProof` MUST atomically test-and-delete (burn before compare), and persist/MAC the **verbatim** emitted `challenge`/`expiresAt` strings (F8).
- **Rate-limit `/credentials` per `(vaultId, brokerId)` (I10, SHOULD).** Bounds the multi-tab credential-amplification surface; app-side hooks + consent audit remain the primary controls.
- **Accept old+new registration for a short grace window on rotate (I5).**

**Enclave vs party-layer boundary (decided — §3 justification).** Proof crypto behind the **enclave Contract v1 barrel** (`kernel/enclave/broker/proof.ts`, ADDITIVE — a fork must provide the four/​six new fns); seed lifecycle + fetch + cache in the **party layer** (`with-party/broker/**`), mirroring `sync-credentials`. The `enclave-body-only` ratchet extends to the new identifiers (`deriveBrokerProofBits`, `deriveBrokerProofKey`, `computeBrokerProof`, `verifyBrokerProof`, `issueChallenge`) and the literals `'noydb-broker-proof'` / `'noydb-broker-proof-v1'`; **opaque proof/challenge/credentials strings in transit are explicitly permitted** anywhere (fetch bodies, cache).

**Architecture guards (all pass, verified against `scripts/check-architecture.mjs`):**
- `strategy-opt-in`: `with-party/broker/` exports `withBroker()` → satisfies `checkEveryServiceGated` with no exempt entry. Add a `STRATEGY_GATED_APIS` row `{ api: /\.broker\s*\(/, option: 'brokerStrategy', factory: 'withBroker' }`. **Caveat (A4):** this catch fires only in files that also inline-call `createNoydb(` (`check-architecture.mjs:388`; the "5 of 12 seams" limitation), so it trips the static scan **at inline-construction sites**, not universally — a consumer that constructs the vault elsewhere is not caught by the scan (the `NO_BROKER` runtime throw still guards it).
- `hub-portable` (no Node built-ins — hence `crypto.subtle.verify`, never Node `timingSafeEqual`, F6), `no-crypto-deps` (crypto.subtle + fetch only), `peer-deps`, `kernel-surface` (broker touches `vault.ts` only for the one accessor — keep under the ratchet), `no-outbound-klum-import` (decision 8: no cargo re-export).

**Goldens touched:** `to-surface.golden.json` (+2 types; **also correct its stale `source` metadata at line 3 from `src/kernel/to/index.ts` → the real `src/port/to/index.ts` — A6, harmless but misdirecting**) · enclave Contract v1 barrel golden (+ the new fns) · kernel-api golden (`vault.broker()` + `brokerStrategy` option) · **cargo-surface golden UNCHANGED** (decision 8, klum re-export deferred) · `/adapter` alias golden **unchanged**. The `_broker` reserved-name reject + grant-exclusion touch **no broker-repo golden** — they ship in `fix/reserved-secret-collection-leak` (C1/C2) with that PR's own goldens/tests.

**`features.yaml`** gains a `broker` capability entry (schema-validated via `pnpm validate:features`).

**Changeset plan.** Hub: **one minor** changeset covering the `withBroker()` service **and** the `StoreCredentials`/`StoreCredentialSource` adapter types (they ship together — slice 1 types + slice 2 service can land in one hub minor, or slice 1 alone first; either way the adapter type is the cross-repo trigger). noy-db-to: a **separate** changeset later (peer-floor bump + `credentials` option on the AWS stores).

**Cross-PR dependency (C1/C2 — the broker plan gates on a shipped-code security PR).** Slice 2's `_broker` reserved-name reject and grant-propagation exclusion are **not** broker-repo code — they are the generalized reserved-secret-collection guard + grant-exclusion shipped by **`fix/reserved-secret-collection-leak`** (which independently closes the identical shipped `_sync_credentials` readability/propagation hole). That PR MUST land (and, for the grant-exclusion, be in the hub release the broker ships against) **before** slice 2 can claim R-B6/R-B7. The broker PR adds `_broker` to that PR's reserved-name set and grant-excluded set.

**Cross-repo sequencing (mirrors the #552 `/cargo` publish precedent).** The adapter-seam change must **land + publish in a hub release BEFORE noy-db-to can adopt it** (noy-db-to tests run against the *published* `@noy-db/hub`, not a workspace link):
1. Hub PR ships `StoreCredentials`/`StoreCredentialSource` on `/to` (+ golden bump) and `as-aws-s3`'s `credentials` option → publish hub `0.3.0-pre.N` (`N ≥ 4`; `0.3.0-pre.3` shipped classified slice-2b) on `@next`.
2. noy-db-to bumps every adopting store's `@noy-db/hub` peer floor from the current `^0.3.0-pre.1` to `^0.3.0-pre.N` (and the matching `devDependencies` pin), adds `credentials?` to `to-aws-dynamo` / `to-aws-s3`, its own changeset + release. Non-adopting stores are untouched (types are additive). **This bump cannot merge before step 1 is published. The peer-floor bump is a MANUAL correctness gate (A3)** — `hub-peer-range` in noy-db-to checks the peer-dep *shape*, not the floor *value*, so nothing mechanically catches a store that references the new `/to` symbols while pinning a floor below the hub minor that introduced them; the reviewer must verify the floor.
3. Slice 2 (`withBroker()`) and slice 3 (sealed delivery) are **hub-internal** — no further noy-db-to coordination (the stores already carry the hook from slice 1), but slice 2 gates on `fix/reserved-secret-collection-leak` (above).

## 8. Phasing — three independently valuable slices

Each slice ships its own conformance vectors and states its cross-repo coordination.

### Slice 1 — adapter `credentials` hook (AWS-only)
**Ships:** `StoreCredentials` + `StoreCredentialSource` in `kernel/types.ts`, re-exported by `/to` (golden bump); `credentials?` option on `to-aws-dynamo` / `to-aws-s3` (noy-db-to, peer-floor bump) + `as-aws-s3` (this repo); the store-side refresh discipline as **hand-written per-store tests** (A2 — the `adapter-conformance` harness has no credential hook; do not claim it does).
**Value without any broker:** apps wire their existing Cognito / STS / Amplify credential providers **today** — the #479 bolt-on becomes a supported seam. No new service, no bundle-gate change.
**Cross-repo:** the only slice needing hub→noy-db-to sequencing (§7). Hub publish first, then noy-db-to peer bump (manual floor gate, A3).
**Conformance vectors:**
- **V-A0** (`kind:'aws'`, A1/A5) `mapAws` emits `expiration: new Date(creds.expiresAt)` so the SDK `memoizeIdentityProvider` re-invokes at the window; a source returning ISO `expiresAt` yields an identity whose `expiration` is a `Date`; a missing `expiresAt` yields `expiration: undefined`.
- **V-A1/V-A2/V-A3 (`kind:'token'`-path ONLY, A1)** — V-A1 store calls the source lazily on first use and when `expiresAt − now < 60 s` · V-A2 store rebuilds its client on credential change · V-A3 on an auth error the store forces one refresh + retry before `NetworkError`. *(On the `kind:'aws'` arm the SDK owns this — not the store; these three do not apply.)*
- **V-A4** `kind:'aws'` maps to a functional `AwsCredentialIdentity` provider (no `credentials` key ⇒ ambient chain, preserved).
- **V14** `to-surface.golden.json` gains exactly `StoreCredentials`, `StoreCredentialSource`; its `source` metadata reads `src/port/to/index.ts` (A6); `/adapter` alias golden byte-identical.

### Slice 2 — proof + `withBroker()` service (delivery = plain HTTPS, persist-nothing)
**Ships:** `@noy-db/hub/broker` (`with-party/broker/{strategy,active,index,seed}.ts`), `kernel/enclave/broker/proof.ts` (+ barrel), the `_broker` seed lifecycle (CAS enrol, quiesce-then-swap rotate, `registered` flag), the `'noydb-broker-proof'` derivation, the challenge client + single-flight refresh cache (clear-on-reject, TTL floor), host `issueChallenge`/`verifyBrokerProof`(+`consumeChallenge` burn) helpers, the reference ~100-line Lambda/STS doc (**KMS-wrap + burn + rate-limit obligations**), SERVICES.md row + bundle gate + `features.yaml` + `STRATEGY_GATED_APIS` entry.
**Cross-repo:** none — hub-internal (stores already have the hook). **Cross-PR:** gates on `fix/reserved-secret-collection-leak` (the `_broker` reject + grant-exclusion, C1/C2).
**Conformance vectors:**
- **V1** proof binds `vaultId`: a proof minted for vault A fails `verifyBrokerProof` when replayed as vault B.
- **V3** proof binds `challenge`: replaying a proof under a different or reused challenge fails.
- **V4** proof binds `expiresAt`: a proof past `expiresAt` fails (host checks `now < expiresAt`; `expiresAt` is inside the MAC — client clock untrusted).
- **V5** single-use challenge **burned on presentation before the MAC compare (F2):** a second `/credentials` with the same challenge → 401 even when the second proof is byte-identical and unexpired; `verifyBrokerProof` calls `consumeChallenge` first and short-circuits on not-fresh with no MAC work.
- **V6** seed rotation revokes the old proof key: after `rotate()`, a proof from the old seed fails verification (broker holds the new registration) — **except within the I5 grace window** (see V21).
- **V7** broker never receives passphrase/KEK/DEK/seed: a `fetch` spy records enrol/challenge/credentials bodies containing only `{ vaultId, brokerId, proofKey, challenge, proof, profile, instancePid? }` — no seed, DEK, or passphrase.
- **V8** cache single-flight: N concurrent `credentialSource()` calls near expiry trigger exactly **one** `/challenge`+`/credentials` round-trip.
- **V9** refresh-on-expiry: the source returns cached creds until the floored boundary `max(expiresAt − skewMs, now + minCacheMs)`, then mints fresh.
- **V10** enrol refused without attestation: `/enroll` without the dev-backend token → `BrokerEnrolmentError` (reference host 401).
- **V11** `_broker` unreachable via `vault.collection('_broker')` → reserved-collection error from the **new** reject the broker ships (C1; rides `fix/reserved-secret-collection-leak`); seed only via the seed API.
- **V12** steady-state proof key non-extractable: `exportKey` on `proofKey` throws — **and** the candor vector: a test asserting the docs state that a live-unlocked context can re-derive fresh bits from the seed (H-1; not a code guarantee, a documented bound).
- **V13** broker down ⇒ store `NetworkError`, local writes still queue (no data loss).
- **V13b (I8)** a `credentialSource` throwing `BrokerProofError` **mid-sync-flush** (a torn I5/I7 window) is treated as offline-degradable: the flushed ops **requeue, not drop** — no data loss on the proof-error arm, not only the network arm.
- **V17 (C2 grant-exclusion)** after `grant()` mints a sub-admin/operator/client keyring, that keyring has **no `_broker` DEK** and cannot decrypt the seed record (asserted on the keyring contents, not merely a refused API) — a granted principal cannot re-derive the proof key.
- **V18 (F1 profile-binding)** a `{challenge, proof}` minted for `profile:'read'` fails `verifyBrokerProof` when re-submitted with `profile:'admin'` (profile is inside the MAC).
- **V19 (F4 endpoint-binding)** a proof minted against endpoint origin X fails verification at a different broker origin Y that reuses the same `brokerId` (endpoint origin is inside the MAC).
- **V20 (I4 enrol-CAS)** two concurrent `enroll()` on an absent seed produce **one** persisted seed/DEK (the CAS loser re-reads the winner), never two divergent seeds → no orphaned-DEK `TamperedError` on a subsequent read.
- **V21 (I5 rotate-quiesce+grace)** `rotate()` bumps the `credentialSource` epoch and quiesces in-flight round-trips before overwrite; an in-flight proof computed under the **old** key still verifies within the broker grace window (register-new-before-overwrite), and no `BrokerProofError` is surfaced to a concurrent flush.
- **V22 (I6 cache-hygiene)** (a) a rejected in-flight `/credentials` promise is cleared from the cache (next call retries, is not wedged); (b) a minted TTL `< 2×skewMs` is floored/rejected so the source does not re-prove on every call.
- **V23 (I9 partial-enrol)** a seed persisted whose `/enroll` POST 401'd leaves `registered !== true`; `credentialSource()` fails fast with `BrokerEnrolmentError`, never an opaque `BrokerProofError`; a subsequent successful `enroll()` sets `registered: true` and mints normally.
- **V2b** role gate: a non-owner/admin `enroll()`/`rotate()` → `PermissionDeniedError`.
- **V-KEK (R-B8, I3)** `enroll()` on a DEK-only keyring (`kek===null`) → `BrokerEnrolmentError` ("re-authenticate"), while `credentialSource()` on an already-enrolled seed succeeds with the DEK alone.

### Slice 3 — sealed-to-instance delivery + instance identity (opt-in)
**Ships:** a non-extractable RSA-OAEP-2048 instance keypair; `RecipientHint` v1 `'rsa-oaep-sha256'` registration at enrol (`instanceHint`); the D-2 sealed-TLV response path (`sealCredentialsToInstance`/`openSealedCredentials` over `sealRsaOaepTlv`/`parseRsaOaepTlv`+`aesGcmOpen`, zero new wire formats); `instancePid` bound into the proof MAC.
**Cross-repo:** none — hub-internal. Independent of slices 1–2 being useful.
**Conformance vectors:** **V15** creds sealed to instance X's hint cannot be opened by instance Y's private key · **V2** (slice-3 arm, F7) proof binds `instancePid`: a proof for instance X rejected for instance Y; `verifyBrokerProof` matches `instancePid` against the registered `instanceHint`, and an **empty-string `instancePid` is rejected** (absent ≠ `''`, so `?? ''` cannot alias "no instance" onto a registered one) · V16 the instance RSA-OAEP private key is `extractable:false` (IndexedDB), `exportKey` throws.

## 9. Non-goals

Store-side pushdown of the `credentials` refresh into the store contract as a method (A-2, rejected — construction-time config, not a cross-cutting hub call) · `at-broker-*` package or a new prefix family (H-1/H-2 of brief §6, rejected — userland-with-helpers) · `StoreAuth` `kind:'broker'` / `flow:'rolling'` descriptor (decision 6 — declared-only, additive later if something consumes it) · klum-db cargo re-export of broker types (decision 8 — deferred; cargo is additive-only so deferring costs nothing) · `kind:'token'` store adoption (postgres/turso/supabase — a later slice; the type ships now) · **hub-side** rate limiting (out — but the reference *host* SHOULD rate-limit `/credentials` per `(vaultId,brokerId)`, I10; app-side hooks + consent audit remain the primary controls) · asymmetric client-signing enrolment (decision 2 — KMS-wrap is the accepted at-rest control, F3).

## 10. Open questions for the owner

**Resolved by the 3-lens audit (moved into the design body):**

- ~~**OQ1 — enrolment candor / proof-key transmission (H-2, F3).**~~ **RESOLVED.** Symmetric HMAC verification requires the broker to hold the same key bytes, so `/enroll` shares a symmetric verification key — **not** a zero-knowledge registration; the "non-extractable" claim covers only the steady-state signing key (V12). The registered-key-store-at-rest leak this exposes is **credential-equivalent** and is mitigated by the **mandated broker-side KMS-wrap** (§1 candor row, §2 candor, §7 reference-host obligation), owner-resolved to symmetric-HMAC + KMS-wrap, **not** an asymmetric key shape. The §1 candor language is sharpened accordingly.
- ~~**OQ2 — `profile` → proof-key / STS-role cardinality (F1).**~~ **RESOLVED.** `profile` is now **bound into the proof MAC** (F1) — one `_broker` seed/proof key per vault; the host maps `profile` → a distinct STS role/session policy. A proof captured at one profile cannot be re-submitted at another. Recorded in §2 step 3/5, §3 canonical, V18.
- ~~**OQ3 — `brokerId` rotation default (F4).**~~ **RESOLVED: stable `brokerId` default** (confirmed). `rotate()` overwrites the same `brokerId` and the broker replaces the registration; unlinkable-rotation (new `brokerId`) stays opt-in. F4 additionally binds the **endpoint origin** into the MAC and mandates a globally-unique `brokerId` in `BrokerConfig` JSDoc, closing cross-endpoint relay (V19).

**Genuinely still open (deferred to slice-3 design):**

1. **Instance keypair persistence, lifecycle & multi-tab (slice 3; OQ4, I11).** Where the non-extractable RSA-OAEP private key lives (which IndexedDB store) and its lifecycle across logout / lock / multi-tab / clear-site-data. Two sub-decisions the audit sharpened: **(a)** bind keypair **deletion to logout/lock** so it does not outlive its unlock (I11 — today it would survive a re-lock unless cleared); **(b)** decide whether two tabs of one instance **share one keypair or register two `instancePid`s** — which determines whether sealed creds survive a tab reload and how `instancePid` binding (F7) is scoped. Deferrable because slices 1–2 are useful without sealed-to-instance delivery; flagged now because it shapes the slice-3 wire and the `instanceHint` registration.
