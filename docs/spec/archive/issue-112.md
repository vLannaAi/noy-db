# Issue #112 — feat(auth-oidc): @noy-db/auth-oidc — OAuth/OIDC bridge with split-key key connector (Bitwarden-style)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-09
- **Milestone:** v0.7.0
- **Labels:** type: feature, type: security, area: core, epic

---

## Summary

New package: **`@noy-db/auth-oidc`** — an OpenID Connect bridge that lets users unlock a compartment via federated login (LINE, Google, Apple, Microsoft, Okta, Auth0, Keycloak, any OIDC-compliant provider) **without the server ever seeing plaintext or the unwrapped KEK**.

The mechanism is the **split-key pattern**, same as Bitwarden's SSO key connector: the server holds a *fragment* of the KEK, the client holds a *device secret*, and the real KEK is reconstructed client-side by combining the two. Neither half alone is sufficient. The server sees the fragment (not the key), the device sees the device secret (not the key), and only the unlocked client briefly holds the reconstructed KEK in memory.

This is the "let me use my LINE / Google account to open the compartment" story for consumers who have existing social or SSO identity and don't want to manage separate passphrases. The IdP is demoted from "authority over your data" to "witness that you are who you say you are" — it proves identity, it does not hold keys.

## Priority provider: LINE

The primary consumer for noy-db is a Thailand-based platform where LINE is effectively universal identity. **LINE is the v1 reference provider** and the first target on the test matrix. Google and Apple follow. Microsoft / Okta / Auth0 / Keycloak are listed as supported out of the box via the standard OIDC discovery path, but LINE's quirks get explicit integration tests and documentation.

LINE Login compatibility notes (as of LINE Login v2.1):

- OIDC-compliant ID tokens with standard claims (`iss`, `aud`, `sub`, `exp`, `nonce`)
- Discovery doc at `https://access.line.me/.well-known/openid-configuration`
- `sub` claim is **channel-specific** — the same human has different `sub` values in different apps (LINE's "channel" = OAuth client). Key connector user lookup must key on `{ issuer, sub }`, not `sub` alone. Important: a user switching LINE developer channels breaks unlock; this must be documented clearly.
- `email` claim requires a separate scope AND per-channel review by LINE before the scope can be requested. The library must NOT depend on `email` being present — `sub` is the only guaranteed identifier.
- RSA-signed ID tokens on modern API versions (standard JWKS verification path).
- No non-standard flow bits — the standard Authorization Code + PKCE path works.

Apple (Sign in with Apple) notes:

- OIDC-compliant ID tokens
- Email is often a relay address (`abc123@privaterelay.appleid.com`) — valid but not human-identifying
- No standard `userinfo` endpoint — all claims live in the ID token
- `name` claim is only returned on the very first consent, never again
- Token exchange uses a private-key-signed client assertion, not a client secret

## Explicitly NOT supported: Meta / Facebook Login

Meta's Facebook Login is **OAuth 2.0, not OIDC**. It does not issue standard ID tokens; identity verification goes through the Graph API's `/me` endpoint, which bypasses JWKS signature verification and standard claim validation. Integrating it would require a separate adapter path that gives up most of the OIDC hardening guarantees.

**Meta/Facebook is out of scope for v1 and will stay out of scope unless a specific consumer asks and is willing to accept the reduced security properties.** Consumers who need Facebook-based identity can bridge via their own Firebase/Auth0 setup that issues a proper OIDC-compliant ID token downstream.

## Motivation

Passphrase-only unlock is a non-starter for many legitimate deployments:

- **Client portals.** An accounting firm's clients want to review their records; "here is a passphrase, memorize it" is not acceptable UX.
- **Employee access in SSO'd orgs.** Companies with Okta/Azure AD already pay for centralized identity. Making users maintain a separate compartment passphrase is friction without security gain (the IdP is the source of truth for who they are).
- **Onboarding new users on the operator role.** Typing a shared passphrase into a form is easy to phish; going through the org's normal login is not.

At the same time, the library cannot give up its zero-knowledge invariant just because the user authenticated via Google. The server (the OIDC client that issues tokens to us) must **never** be able to decrypt compartment data, even with a full compromise of its database.

Split-key auth is the established pattern that solves this without compromise.

## Proposed design

### Three-party split-key protocol

Parties:

1. **Client** — noy-db running in the browser/PWA
2. **IdP** — Google / Okta / Azure / Keycloak (issues ID tokens, library does not need to trust it with data)
3. **Key connector** — a small server the consumer deploys, holds per-user KEK fragments

Flow:

```
ENROLLMENT (once per user)
──────────────────────────

1. User unlocks compartment with passphrase (normal path).
   Client now holds plaintext KEK.

2. Client generates:
   - device_secret  (32 bytes random, stays on device forever)
   - kek_fragment   (XOR or HKDF-combined with device_secret)

   kek_fragment = HKDF(KEK, salt=device_pubkey_hash, info="noydb/oidc/v1")
   device_secret = KEK XOR kek_fragment
   # OR an HKDF-based split; XOR is simplest for exposition

3. Client stores device_secret locally (encrypted with WebAuthn/platform keychain).

4. Client sends kek_fragment to the key connector, authenticated with the
   user's current OIDC ID token. The connector stores:
   { subject_claim, kek_fragment, wrapped_with_server_key }

   The server's encryption-at-rest key protects the fragment against DB dump,
   but even in plaintext the fragment alone reveals nothing about KEK.

5. Client records in the compartment's keyring that this user has an OIDC
   credential available at key_connector_url with subject_claim X.


UNLOCK
──────

1. User clicks "Sign in with Google" in the noy-db UI.
2. Standard OIDC Authorization Code + PKCE flow → client receives ID token.
3. Client sends ID token to the key connector → connector verifies the token
   against the IdP's JWKS → returns kek_fragment for that subject_claim.
4. Client reads device_secret from local storage.
5. Client reconstructs KEK = kek_fragment XOR device_secret (or HKDF equivalent).
6. Client wraps KEK with session wrapping key (see session-tokens issue).
7. Compartment is unlocked.

The connector never saw the KEK. The IdP never saw the KEK. The device_secret
never left the device. Only the unlocked client briefly held the KEK in memory.
```

**Why both halves are necessary:**

- Stealing the connector's database gives the attacker kek_fragments and ID-token subjects, but no device_secrets → nothing decrypts.
- Stealing a device gives the attacker a device_secret, but no kek_fragment unless they can also obtain a valid ID token → still nothing decrypts.
- Compromising the IdP alone lets the attacker forge ID tokens, which then let them pull kek_fragments from the connector — but they still need the device_secret from a specific device.

All three have to fail together to lose the compartment. Passphrase-only has one point of failure (the passphrase); split-key has three.

### The key connector

The consumer deploys the key connector themselves. We ship it as a **tiny reference implementation** (single TypeScript file, ~200 lines) covering:

- OIDC ID token validation (JWKS fetch + signature check + audience/issuer/expiry checks)
- CRUD on the `{ subject_claim → kek_fragment }` store
- At-rest encryption using a server-held key (documented as "protect this with your deployment's normal secret management")
- Rate limiting (to prevent brute force of fragments via forged subjects)

The connector does not need to be high-availability, doesn't hold business data, doesn't need special hardware. A $5/month VPS is enough for a small firm. For enterprise, it deploys next to the consumer's existing IdP infrastructure.

**Critical: the connector is not trusted with plaintext.** If the connector is compromised, the attacker still needs device_secret to decrypt anything. The threat model is "the connector can leak fragments to an attacker who can forge ID tokens for any user in the IdP" — which is a significant compromise already.

### Package shape

```
packages/auth-oidc/
├── src/
│   ├── index.ts           # enrollOidc, unlockWithOidc
│   ├── pkce.ts            # shared with @noy-db/drive — extract to @noy-db/auth-oauth helper?
│   ├── split-key.ts       # HKDF split + reconstruction
│   ├── connector-client.ts # fetch + verify key connector responses
│   └── device-secret.ts   # platform-specific storage (WebAuthn PRF preferred, keychain fallback)
└── reference-connector/
    ├── server.ts          # the ~200-line reference connector
    └── README.md          # "deploy this next to your IdP"
```

Package depends on `@noy-db/core` (session primitive) and — once it exists — `@noy-db/auth-oauth` (shared PKCE helper, also used by `@noy-db/drive`).

### API surface

```ts
import { enrollOidc, unlockWithOidc } from '@noy-db/auth-oidc'

// Enrollment (once, after initial passphrase unlock)
// Primary consumer deploys the key connector next to their IdP.
await enrollOidc(db, {
  compartment: 'acme',
  userId: 'vlanna',
  passphrase: 'correct horse battery staple',
  oidc: {
    // LINE is the v1 reference provider for the Thai market
    issuer: 'https://access.line.me',
    clientId: '<line-channel-id>',
    redirectUri: 'https://app.example.com/oauth/callback',
    scopes: ['openid', 'profile'],   // email is optional and channel-gated on LINE
  },
  keyConnector: {
    url: 'https://noydb-kc.example.com',
  },
})

// Subsequent unlock (no passphrase)
const session = await unlockWithOidc(db, {
  compartment: 'acme',
  userId: 'vlanna',
  sessionPolicy: { idleTimeoutMs: 15 * 60 * 1000 },
})
// → pops up LINE sign-in, reconstructs KEK, opens session
```

## Device-secret storage

This is the part where the package intersects with `@noy-db/auth-webauthn`. The device_secret must be protected at rest on the device. Options, in order of preference:

1. **WebAuthn PRF** — derive device_secret from a locally-enrolled WebAuthn credential's PRF output. Non-extractable, bound to a specific credential, requires biometric/PIN on every unlock. Best option.
2. **Non-extractable WebCrypto key wrapping** — encrypt device_secret with a non-extractable AES-KW key stored in IndexedDB. Weaker than WebAuthn PRF because a memory dump during active use can recover it, but still blocks disk-snapshot attackers.
3. **localStorage plaintext** — refused. Not implemented.

Option 1 is the default when WebAuthn is available. Option 2 is the fallback. Consumers can force option 1 with `requireWebAuthn: true` in the enrollment config.

## Acceptance criteria

- [ ] **Key connector never sees plaintext KEK.** Test with a mock connector that asserts every request body contains only a fragment-shaped blob, never a recognizable KEK.
- [ ] **Unlock requires all three inputs** (valid ID token + valid fragment + valid device_secret). Tests for each individual missing input → all must fail.
- [ ] **ID token validation includes issuer, audience, expiry, signature, nonce, and replay-cache check.** Each covered by a negative test.
- [ ] **Device_secret storage defaults to WebAuthn PRF when available.** Test that the fallback only engages when `window.PublicKeyCredential` is undefined.
- [ ] **Revocation from the connector** (when an admin removes a user) results in a clean `OidcUnlockFailedError` on next unlock, not a silent stale-key success.
- [ ] **The reference connector validates JWKS against the stated issuer** with cache refresh on key rotation. Covered by integration test against a local IdP simulator.
- [ ] **Enrollment is idempotent** — re-enrolling the same user against the same connector updates the fragment rather than creating a duplicate.
- [ ] **The library refuses to use HTTP for the connector URL.** HTTPS only, validated at import time.
- [ ] **LINE is on the integration test matrix as the v1 reference provider.** Tests cover: channel-specific `sub` claim handling, missing `email` claim handling, RSA ID token verification against LINE's JWKS, and the Authorization Code + PKCE flow end-to-end against a LINE sandbox channel.
- [ ] **Meta / Facebook Login is NOT implemented.** Attempting to pass a Facebook issuer URL throws `UnsupportedProviderError` with a message explaining why (OAuth 2.0 only, no OIDC ID tokens).

## Open questions

1. **Multiple IdPs per user?** A user might want both LINE and Google as unlock paths (e.g. LINE on mobile, Google on desktop). Probably yes — the keyring supports multiple credentials already for WebAuthn; OIDC should follow suit.
2. **Magic-link unlock overlap.** Magic-link (sibling issue) is structurally similar: server issues ephemeral secret → client combines with something local. Should magic-link share the split-key infrastructure? Lean: yes, magic-link is a special case where device_secret is replaced by a one-time-use token delivered via email.
3. **Connector deployment options.** Ship a Docker image? A Cloudflare Worker template? A Deno Deploy example? Lean: start with a single reference TypeScript file and document 2-3 deployment paths in the README.
4. **Hosted reference connector at noydb.dev.** Tempting, but creates a central trust point we said we would never have. Hard no.
5. **Account key rotation** — what happens if the user rotates the KEK? The kek_fragment on the connector needs to be updated atomically, and old device_secrets need to be invalidated. Design this up front; v1 supports manual re-enrollment, v2 supports automatic.
6. **Session binding to ID token lifetime.** Should the noy-db session expire when the OIDC ID token expires? Probably — "your SSO session ended" is a natural trigger to re-lock the compartment.

## Non-goals

- We do not ship an IdP. Consumers use their existing OIDC provider.
- We do not provide multi-tenant connector hosting. Each consumer deploys their own.
- We do not support SAML. OIDC only. SAML consumers can bridge via Keycloak or similar.
- We do not support implicit flow. Authorization Code + PKCE only.
