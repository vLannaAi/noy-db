# Threat model (DRAFT)

> **Status:** v0.25 draft — pilot feedback expected to refine. Tracked in #285 (SPEC reorg) and #289 (LTS lock).

NOYDB's threat model defines what an attacker can and cannot achieve. The library is "zero-knowledge" in a specific, narrow sense: anyone who reads the storage layer (cloud provider, sysadmin, lost USB stick) sees only ciphertext. The core does NOT defend against compromise of the consumer's process — once code runs alongside an unlocked vault, that code can do anything the user could.

## In-scope adversaries

### Storage adversary
*"Whoever sees the data on disk."* Cloud provider, sysadmin, anyone who exfiltrates the `to-*` backend.

**They cannot:**
- Read record contents (AES-256-GCM ciphertext)
- Discover field values (no plaintext indexes by default; deterministic encryption is opt-in and explicit)
- Recover the KEK or DEKs (KEK never persisted; DEKs only in wrapped form)
- Forge records that pass authentication (GCM tag fails closed)
- Reorder, substitute, or truncate blob chunks (AAD = `${eTag}:${index}:${count}`)

**They can:**
- Observe write timing and frequency (operational metadata)
- See vault names, collection names, record IDs, `_v` and `_ts` envelope fields (these are unencrypted by design — the sync engine needs them)
- Delete records (denial of service; `verifyBackupIntegrity()` detects gaps via the ledger when `withHistory()` is enabled)

### Network-on-the-wire adversary
*"Whoever taps the connection between consumer and store."*

**They cannot:** anything more than the storage adversary, because what crosses the wire is the same ciphertext that lands on disk.

**They can:** whatever transport-level attacks are possible against the underlying connection (TLS downgrade, CA compromise). Mitigation lives in the consumer's TLS / VPN / mTLS configuration — not in NOYDB.

### Revoked user
*"User Alice was granted access, then revoked."*

**They cannot read records written AFTER `db.rotateKeys()` runs.** Rotation generates new DEKs, re-wraps for the remaining keyring entries, and Alice's wrapped DEKs in `_keyring/alice` no longer match.

**They can read records written BEFORE rotation** if they kept the old DEKs (which they had legitimate access to during the grant window). NOYDB does not re-encrypt envelope `_data` on rotation — that would be O(records) and is reserved for "deep rotation" follow-up work.

### Hostile peer (sync target)
*"The remote store you push/pull against is malicious."*

**They cannot:** read plaintext (same as storage adversary).

**They can:** withhold or replay records. The local `verifyBackupIntegrity()` chain check detects out-of-order or gapped ledger entries.

## Out-of-scope adversaries

### Consumer-process adversary
*"Code running in the same process as the unlocked vault."*

NOYDB does NOT defend against this. The KEK and DEKs are in JavaScript objects in your process; another piece of code in the same JS context can read them. Mitigations are the consumer's responsibility:
- Don't load untrusted code into a process that's holding an unlocked vault
- Use `db.close()` aggressively at idle to clear keys from memory
- Use `withSession({ idleTimeoutMs, lockOnBackground })` to enforce auto-close
- Use a separate iframe / Worker / process for untrusted UI

### Side-channel adversary
*"Power analysis, timing, cache-based attacks against the Web Crypto API."*

Out of scope. The Web Crypto API in modern runtimes mitigates these for AES, but NOYDB does not add additional defenses.

### Quantum adversary
*"Future quantum computer that breaks AES-256 and PBKDF2."*

Out of scope until a clear migration path exists. AES-256 has 128-bit post-quantum security (Grover's algorithm) — adequate for current threat models. Post-quantum primitives are a future-major-version effort.

## What "zero-knowledge" means here

A sentence to put in front of pilots:

> **Storage and network attackers see only ciphertext.** Anything stronger — defending against malicious code in your own process, defending against side-channel attacks, defending against quantum computers — is explicitly out of scope. NOYDB protects the data at rest and in transit; protecting the running process is the consumer's job.

## See also

- [SECURITY.md](../../SECURITY.md) — disclosure policy
- [docs/core/02-encryption.md](../core/02-encryption.md) — the crypto guarantees this model rests on
- [SPEC.md § Threat model](../../SPEC.md) — formal version (TODO per #285)
