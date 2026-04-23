# Issue #194 — feat(on-totp): @noy-db/on-totp — TOTP (RFC 6238) authenticator app unlock

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security

---

Register the vault with an authenticator app (Google Authenticator, Authy, 1Password, iOS Passwords, etc.) via an otpauth:// URI and QR code shown at enrolment. Unlock consumes a 6-digit code from the user + a stored share, reconstructing the wrapping key. Uses HMAC-SHA1 per RFC 6238 (or SHA-256 option). Zero external dep — implement using Web Crypto.
