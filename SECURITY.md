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

The AES-GCM auth tag covers a record's **body** (`_data`). Since #1041 it also
covers the record's **identity** — `{collection, id, _tier, _by}` are bound in as
additional authenticated data, so a storage backend that rewrites them produces
an envelope that no longer authenticates.

> **A remote store — or a `by-peer` peer — cannot alter, relocate, re-author or
> splice any record it serves. It can still withhold, and it can still rewind.**

That is narrower than the promise a reader might want, and it is exact. What
follows is what each half means.

### Closed

| A hostile store attempting to… | is refused because |
|---|---|
| **Relocate an envelope** into another collection or record id | identity is bound into the tag; the reader recomputes AAD from the address it fetched from |
| **Expose an elevated record** by lowering `_tier` | a tier-N body relabelled tier 0 is opened with the wrong key |
| **Forge or strip `_by` / `_source`** | both are bound; a tampered field changes the AAD and defeats itself |
| **Splice another record's body** under this record's metadata | the body authenticates at the identity it was sealed for, not the one it is served under |
| **Have a forged envelope committed by sync** | since #1042 the merge verifies **before** `local.put`, so a rejection leaves the local copy untouched |

The vault name is deliberately **not** bound: `adoptPartition` legitimately
re-homes records into a new vault, so cross-vault relocation is a supported
operation rather than purely an attack.

### Still open, and precisely how

**Version rollback is not prevented.** `_v` remains outside the AEAD, so a store
can re-serve a genuinely old envelope with an inflated `_v` and it authenticates
correctly — it *is* a real record this client wrote. Binding `_v` requires the
sync engine to re-seal when it advances a version rather than restamping
metadata; the seam for that exists (`MergeAuthority.advance`) but the binding
does not.

**Withholding is not preventable at all.** A store serving nothing, or serving a
genuine older record, cannot be caught by examining the records it does serve.

**Raising `_tier` is withholding, not alteration** — and this is the correction
the adversarial harness produced within minutes of first running, against a
design document that claimed otherwise. The tier-0 read gate treats any envelope
claiming `_tier > 0` as *missing* and returns before decrypting, so AAD never
sees it. Nor can reordering help: a reader holding only the tier-0 key cannot
distinguish a genuine elevation from a forged one, because both fail under the
key it has. The record is hidden, not corrupted.

Both become **detectable** — not prevented — with
[`withVaultHead()`](./docs/subsystems/vault-head.md), which keeps an
authenticated `{id → version}` manifest the store cannot forge and reports
`withheld` and `rolled-back` records on sweep. It is opt-in because it costs a
write per commit and, on a single-device offline vault, defends against nothing.

**A peer with no key for a collection accepts its records unverified.** It cannot
judge what it cannot decrypt. Rejecting instead would break replication of data
a peer legitimately holds but this client is not cleared to read. Such records
are inert here and displace nothing.

**Anti-entropy rests on the client's own store.** A fully cold device with no
local state cannot detect a consistently old world, because the store can present
a coherent past. Closing that needs an external anchor.

Tracking: [#1041](https://github.com/vLannaAi/noy-db/issues/1041) (identity
binding — **done**), [#1042](https://github.com/vLannaAi/noy-db/issues/1042)
(fail closed at merge — **done**),
[#1044](https://github.com/vLannaAi/noy-db/issues/1044) (vault head — **done**),
[#1051](https://github.com/vLannaAi/noy-db/issues/1051) (the refactor that
unblocked the wiring — **done**). Binding `_v` remains.

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
