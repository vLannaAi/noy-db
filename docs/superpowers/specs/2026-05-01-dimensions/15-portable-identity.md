# Dimension 15 — Portable identity and federation

## Purpose

Decouple a user's identity and data from any specific service. ATProto, Solid, Nostr, Matrix, ActivityPub, Veramo, and UCAN all converge on the same architectural axis: **the user owns their identity (a DID), the user owns their data (a signed, portable repo), and any service that processes them is interchangeable.** None of the existing 14 dimensions name this primitive — and yet it's the strongest unifying signal in the post-2023 decentralised-app landscape, and it directly serves the noy-db mission of "full privacy and full independence."

## Why this is its own dimension, not an extension of Dim 02

Dimension 02 covers *unlock methods* — how you authenticate to your own vault. Dimension 15 covers *identity portability and federation* — how your vault's records carry an issuer signature, how that issuer's identity is verifiable independently of the storage backend, and how data moves between services without rewrite. These are orthogonal:

- A vault could use `on-passphrase` (Dim 02) and have no portable identity (Dim 15) — the noy-db default today.
- A vault could use `on-webauthn` *and* sign every record with a DID-bound key — Dim 02 + Dim 15 composing.

The signal that this is its own dimension: 7+ independent ecosystems (ATProto, Solid, Nostr, Matrix, ActivityPub, Fission, Veramo) all building toward the same primitive without coordinating. That's a real axis.

## Current state

- Identity in noy-db today is *vault-internal*: the keyring binds passphrase → KEK → DEKs, but there's no externally-verifiable identity.
- Records are encrypted but not signed by a portable identity. A vault dump's authenticity is verifiable only if you know the issuer's keyring out-of-band.
- No DID, no lexicons, no federation contract, no signed-event repo shape, no portability protocol.
- `.noydb` bundles are portable across noy-db consumers, but not across *protocols* — a Bluesky client cannot read them.

## Target state

A noy-db vault can optionally bind to a **portable identity** (`vault.identity = did:plc:abc123...`), sign every record with the identity's signing key, and expose the vault as a **federation-compatible repo** for protocols the user opts into. The user can move their vault between services (PDS-style portability) without re-encrypting or losing record provenance. Records carry verifiable signatures even after export. Cross-app interop becomes possible without breaking zero-knowledge: the *signature* is portable, the *content* stays encrypted unless the user explicitly opens a federation channel.

## Concrete additions

**Identity primitives (hub):**
- `withIdentity({ did, signer, keyType })` — bind a vault to a portable DID; records signed on write
- `vault.identity` — read-only resolver returning the bound DID and verification methods
- `vault.exportRepo()` — export a signed Merkle-DAG repo (ATProto-shaped) suitable for migration to a different PDS or noy-db instance
- `vault.importRepo(repo, { verify })` — import and verify a portable repo from another service

**DID resolvers / methods:**
- `@noy-db/did-plc` — Public Ledger of Credentials (ATProto's DID method)
- `@noy-db/did-web` — `did:web` (DNS-bound)
- `@noy-db/did-key` — `did:key` (self-contained, no external resolution)
- `@noy-db/did-ion` — Sidetree-protocol DIDs (Microsoft / Decentralized Identity Foundation)

**Signed-record primitive:**
- `withSignedRecords({ method: 'detached' | 'inline', algorithm: 'ed25519' | 'p256' })` — every record gets an `_sig` field next to the existing `_iv`, `_data`, etc.; `_sig` is a signature over the canonical-JSON-encoded plaintext, by the vault identity's signing key
- Verification at read time is opt-in (`vault.collection('x', { verify: true })`)
- Composes with `withHistory`: the hash-chained ledger entries can be signed too, giving an audit log that's externally verifiable

**Federation transports (sibling to `by-*`):**
- `@noy-db/fed-atproto` — ATProto firehose + repo sync; lexicons declared per collection
- `@noy-db/fed-activitypub` — ActivityPub outbox/inbox; collection records mapped to AS2 objects
- `@noy-db/fed-nostr` — Nostr event publishing/subscription; relay endpoints configurable
- `@noy-db/fed-matrix` — Matrix federation protocol bridge
- `@noy-db/fed-solid` — Solid pod compatibility layer (LDP + WAC)

**Lexicon / typed protocol contracts:**
- `vault.lexicon('app.bsky.feed.post', collectionSchema)` — declare a collection's lexicon (typed protocol contract); records emit/consume in the lexicon's wire format when federated
- Lexicons are themselves data (collection of `app.lexicon.*` entries), so they can be versioned and federated

**UCAN / capability tokens:**
- `vault.capabilities.issue({ to: did, can: 'read', resource: 'collection://invoices', expires })` — issue a UCAN-shaped capability token
- `vault.capabilities.verify(token)` — verify and apply a presented capability
- Composes with Dim 02 — `on-ucan` accepts UCAN-token unlock; composes with Dim 14 — public-CDN derivations gated by signed UCAN URLs

**Web-of-trust attestation:**
- `vault.attest({ subject, claim, evidence })` — sign an attestation about another DID
- `vault.verifyAttestations({ subject })` — collect and verify attestations across the network
- Composes with Dim 02's `on-shamir` for *social* recovery (k-of-n attestations from trusted DIDs)

## Hard tradeoffs

**1. Signature visibility vs metadata privacy.**
- Signatures are **plaintext metadata** on every record. A backend storing signed-but-encrypted records sees *which DID signed which record at what time* — a non-trivial metadata leak.
- Two honest paths: **(a)** disclosed signatures (default; pragmatic for federation) — backend learns issuer DID per record; **(b)** blinded signatures via group signatures or ring signatures — backend learns "some member of group G signed this" without knowing which (research-grade, not free-tier-aligned).
- Default: (a) with explicit warning. (b) staged for if/when blind-signature libraries become production-ready.

**2. Federation vs zero-knowledge.**
- Federation requires *some* cleartext flow — at minimum the lexicon-shaped public envelope. ActivityPub posts are public by definition; ATProto repos are public by default with selective encryption.
- noy-db's federation strategies must therefore be **opt-in per collection**, not vault-wide. A `withFederation('atproto')` strategy applies only to collections explicitly federated; the rest stay zero-knowledge.

**3. Identity loss = data orphaning.**
- If the user loses their DID signing key (the equivalent of a passphrase loss), their *future* records can't be signed and their *historical* records can't be reattributed.
- Mitigation: DID rotation primitive (`vault.identity.rotate({ from, to, attestation })`) — the new DID issues an attestation transferring authority from the old DID; verifiers accept records from either as belonging to the same logical identity.
- Composes with Dim 02 `on-shamir` for split-key DID rotation.

**4. Lexicon governance.**
- Lexicons (typed protocol descriptions) are distributed data — who decides what `app.bsky.feed.post` means? ATProto picked a centralised authority for `app.bsky.*`; for noy-db, lexicons should be *user-namespaced* by default (`com.noydb.<your-did>.<collection>`) with explicit opt-in to community lexicons.

## Non-goals & tradeoffs

- **Building a PDS service.** noy-db is the user's data substrate; running a PDS is a separate operational concern (deploy templates can help — Cloudflare Workers, Fly Machines, Deno Deploy as PDS hosts).
- **Onboarding flows for non-technical users.** DID creation has UX hurdles. We provide primitives; apps build the friendly wrapper.
- **Cross-protocol bridging beyond noy-db's scope.** A noy-db vault federating via ATProto and ActivityPub at once is *possible* (each as opt-in per collection) but cross-protocol semantic mapping is the application's responsibility.
- **Replacing existing keyrings with DIDs.** The keyring layer (passphrase → KEK → DEKs) stays unchanged. Identity is *additional* — bind a DID to a vault, the keyring continues to encrypt the data; the DID signs metadata.

## Dependencies / sequencing

- Capability metadata in Dim 01 — backends need an `identityAware: boolean` flag (some backends store signatures as opaque bytes; others might index by DID)
- Dim 02 already has `on-token` (proof-of-token-ownership) and `on-oidc` (OIDC split-key); adding `on-ucan` extends the same family
- Dim 14 (derived data) intersects: federation publishes public derivations (a "rendered" lexicon-shaped post derived from the encrypted source record)
- Dim 12 (streams) intersects: Nostr is *event-shaped*; ATProto repos are *Merkle-DAG-shaped* (close to streams + content-address blobs)
- `withSignedRecords` lands first as the floor — a vault can be signed-but-not-federated. Federation strategies layer on top.

## Cross-references

- `features.yaml` → propose new `identity` and `federation` sections parallel to `auths` and `transports`
- Related: Dim 02 (auth methods + UCAN), Dim 05 (transport family), Dim 11 (signed audit log via `withHistory`), Dim 12 (event-sourced federation), Dim 14 (public derivations as federated content), Dim 09 (the read-only viewer is a natural consumer of portable repos)
- Spec anchor: new `SUBSYSTEMS.md#identity-and-federation` section; cross-link to `SPEC.md#zero-knowledge-invariant` to document the federation-vs-zk-tradeoff explicitly

## Open questions

- **DID method choice for the default.** `did:plc` (ATProto-aligned, requires a DID-PLC server), `did:web` (DNS-controlled, simple, requires domain), or `did:key` (self-contained, no resolution, but no rotation)? Each has tradeoffs; default likely `did:web` for the SME mission (no extra infra).
- **Signing-key storage.** The DID's signing key is a high-value secret. Stored alongside the keyring (encrypted with KEK) or external (hardware token, OS keychain via `on-biometric`)?
- **Lexicon discovery.** How does a federated consumer discover what lexicon a noy-db vault uses? In-band (record carries lexicon URI) or out-of-band (well-known URL)?
- **Federation rate limits.** A federated vault can produce a lot of public traffic. Quota/throttle primitive needed before federation lands at scale.
- **Privacy-respecting attestations.** "Alice attests Bob is real" leaks the relationship publicly. Selective disclosure (zero-knowledge proofs) is research-grade; opaque attestation hashes (verifiable but unlinkable) are achievable. Which default?
- **Cross-protocol identity mapping.** The same human can be `did:plc:abc` on ATProto, `https://alice.example/profile` on Solid, and `npub1...` on Nostr. Does noy-db ship an identity-aliasing primitive, or stay protocol-pure?
- **Migration path.** Existing pre-1.0 noy-db vaults have no DID. Adding `withIdentity` to an existing vault — does the bind-time include retroactive signing of existing records (using the new key, but timestamping the signature, not the record), or only sign-from-now-forward?
