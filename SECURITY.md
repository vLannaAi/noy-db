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
| Biometric | WebAuthn / FIDO2 | Platform secure enclave |

All operations use the Web Crypto API (`crypto.subtle`). Zero npm crypto dependencies.

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Lost USB stick | AES-256-GCM — without passphrase, all data is ciphertext |
| Cloud admin reads data | Zero-knowledge — backends store only ciphertext |
| Brute-force passphrase | PBKDF2 600K iterations (~200ms/attempt). 12-char passphrase is infeasible |
| Tampered record | AES-GCM auth tag — decrypt fails with TAMPERED error |
| Revoked user retains data | Key rotation re-encrypts with new DEKs |
| Compromised biometric store | Wrapped KEK encrypted by WebAuthn credential |

### What NOYDB Does NOT Protect Against

- Malicious application code (app has access to decrypted data in memory)
- Keylogger capturing passphrase (OS-level; biometric mitigates this)
- Memory dump attacks (DEKs in process memory during session; mitigated by `db.close()`)

### Recommendations

1. Use passphrases of 12+ characters or 4+ word diceware
2. Enroll biometric for daily use to reduce passphrase exposure
3. Always use `rotateKeys: true` when revoking access
4. Store passphrase in a password manager — loss means permanent data loss
