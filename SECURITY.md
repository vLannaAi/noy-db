# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in NOYDB, please report it responsibly:

1. **Do NOT open a public issue**
2. Email security concerns to the maintainers via GitHub private vulnerability reporting
3. Include a description of the vulnerability and steps to reproduce

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Security Model

NOYDB is a zero-knowledge storage layer. Backends never see plaintext data.

### Cryptographic Primitives

| Purpose | Algorithm | Parameters |
|---------|-----------|------------|
| Data encryption | AES-256-GCM | 256-bit key, 96-bit random IV per operation |
| Key derivation | PBKDF2-SHA256 | 600,000 iterations, 32-byte random salt |
| Key wrapping | AES-KW (RFC 3394) | 256-bit KEK wraps DEKs |
| Random generation | CSPRNG | `crypto.getRandomValues()` |
| Biometric | WebAuthn / FIDO2 (PRF-capable) | Platform secure enclave — derived key is enclave-bound; non-PRF WebAuthn is a presence/liveness gate, not a confidentiality factor |

All operations use the Web Crypto API (`crypto.subtle`). Zero npm crypto dependencies.

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Lost USB stick | AES-256-GCM — without the secret, all data is ciphertext |
| Cloud admin reads data | Zero-knowledge by default — backends store only ciphertext; non-PRF WebAuthn enrollments are refused by default but can be explicitly opted in via `allowNonPrfInsecure`, producing a documented non-confidential presence gate |
| Brute-force secret | PBKDF2 600K iterations (~200ms/attempt). a 12-char secret is infeasible |
| Tampered record **body** | AES-GCM auth tag — decrypt fails with `TamperedError`. Covers `_data` only; see *Envelope metadata is not authenticated* below |
| Revoked user retains data | Revocation always re-encrypts the affected collections under new DEKs — the rotation cannot be skipped |
| Compromised biometric store | Wrapped KEK encrypted by WebAuthn credential (PRF-capable); non-PRF enrollments self-decrypt and are not recommended for this threat model |

### Envelope metadata is not authenticated

The AES-GCM auth tag covers a record's **body** (`_data`). The sibling fields on
the envelope — `_v` (version), `_ts`, `_by`, `_source`, `_tier`, `_noydb` — sit
**outside** the AEAD and carry no integrity. A storage backend can rewrite them
and the tag still verifies.

This is a real gap, not a theoretical one, and it has a concrete consequence:

> **A remote store — or a `by-peer` peer — is trusted for the integrity of
> version ordering and envelope placement, while being untrusted for
> confidentiality.**

That sentence is the honest statement of today's boundary. Confidentiality is
what the zero-knowledge design delivers; ordering integrity is not, and nothing
elsewhere in this document should be read as promising it.

What that permits, all currently possible and all silent:

| A hostile store can… | Because | Effect |
|---|---|---|
| **Roll a record back** — re-serve an old envelope with an inflated `_v` | sync merges on a bare `remote._v > local._v` and never decrypts before applying | The client's newer data is overwritten. No error; `pull()` reports zero failures |
| **Relocate an envelope** into another collection or record id | identity is not bound into the tag | A record appears somewhere it was never written |
| **Hide a record** by marking it `_tier: 1` | tier-0 reads treat elevated as missing | The record vanishes from queries with no error |
| **Forge provenance** by rewriting `_by` / `_source` | unauthenticated | "Who wrote this" is not trustworthy against a hostile store |
| **Withhold or serve stale data** | inherent | Freshness is not defensible against a store you depend on |

Work in progress: a record-identity AAD primitive exists in the hub and binds
`{collection, id, _tier, _by}`, but **is not yet wired into the record path**, so
none of the above is mitigated today. Version rollback additionally requires a
client-held anchor and is not addressed by that work at all. Note the vault name
is deliberately *not* bound — `adoptPartition` legitimately re-homes records into
a new vault, so relocation across vaults is a supported operation rather than
purely an attack.

Tracking: [#1041](https://github.com/vLannaAi/noy-db/issues/1041) (identity
binding), [#1042](https://github.com/vLannaAi/noy-db/issues/1042) (fail closed at
merge), [#1044](https://github.com/vLannaAi/noy-db/issues/1044) (signed vault
head), [#1051](https://github.com/vLannaAi/noy-db/issues/1051) (the refactor that
unblocks the wiring).

### What NOYDB Does NOT Protect Against

- Malicious application code (app has access to decrypted data in memory)
- Keylogger capturing the secret (OS-level; biometric mitigates this)
- Memory dump attacks (DEKs in process memory during session; mitigated by `db.close()`)
- **Version rollback, envelope relocation, and metadata forgery by an untrusted
  store or peer** — see *Envelope metadata is not authenticated* above
- A hostile store **suppressing** a revocation's `_keyring` delete. Rotation
  makes the retained keyring's DEKs worthless, which is the protection that
  matters, but the file itself can still be served

### Recommendations

1. Use secrets of 12+ characters or 4+ word diceware
2. Enroll biometric for daily use to reduce secret exposure
3. Store the secret in a password manager — loss means permanent data loss
4. Prefer a store you control for the **primary** target. The confidentiality
   guarantee holds against any backend, but ordering integrity currently does
   not — see *Envelope metadata is not authenticated*
