# `@noy-db/on-*` — Authentication / unlock paths

> **How you log on.** Each `on-*` package is a way to unlock the KEK
> (key-encryption key) that wraps the DEKs (data-encryption keys) in a
> user's keyring. Composable — stack them however your threat model
> needs.

The `on-` prefix reads as *"you get **on** via this method."* Every package
in this family is a **crypto primitive only** — storage, rate-limiting,
audit integration, and UI belong to the caller. That keeps the surface
testable, auditable, and independent of the hub version.

---

## The distinctive ones

| Package | What's unusual |
|---|---|
| [`@noy-db/on-shamir`](../../packages/on-shamir) | **k-of-n secret sharing** for the KEK. Split the unlock across `n` trustees; need any `k` to reconstruct. For founders, legal successors, multi-party vault custody. Pure GF(256) arithmetic, no library deps. |
| [`@noy-db/on-threat`](../../packages/on-threat) | **Lockout + duress + honeypot** triad. N wrong passphrases → lockout → wipe. Duress passphrase triggers data-destruct. Separate honeypot passphrase surfaces a decoy vault. Plausible-deniability primitives. |
| [`@noy-db/on-webauthn`](../../packages/on-webauthn) | **Hardware-key passkey unlock** via WebAuthn PRF. No passphrase at all — the YubiKey / Touch ID / Face ID is the factor. PRF extension + BE-flag guards for real hardware residency. |
| [`@noy-db/on-oidc`](../../packages/on-oidc) | **Split-key OIDC bridge.** Half the KEK lives in the user's head (passphrase), half comes from the OIDC provider on successful federated login. Neither piece alone unlocks. |
| [`@noy-db/on-magic-link`](../../packages/on-magic-link) | **One-shot viewer session.** A signed URL grants read-only access for a bounded time window. Ideal for client portals — no account creation, no shared passphrase. |

---

## The essentials

| Package | When to use |
|---|---|
| [`@noy-db/on-recovery`](../../packages/on-recovery) | Printable recovery codes — the last-resort unlock when everything else is unavailable. 20-char Base32 + checksum, PBKDF2-derived wrapping key. |
| [`@noy-db/on-totp`](../../packages/on-totp) | RFC 6238 TOTP, validated against the official test vectors. Pair with a passphrase for second-factor unlock. Zero dependencies — HMAC via Web Crypto. |
| [`@noy-db/on-email-otp`](../../packages/on-email-otp) | Email OTP with a caller-supplied transport — bring your own SMTP / SES / Resend / Mailgun. |
| [`@noy-db/on-pin`](../../packages/on-pin) | Session-resume PIN / biometric quick-lock. For "fast unlock after idle" UX. |

---

## Full catalog (9 packages)

- [`on-webauthn`](../../packages/on-webauthn) · hardware keys / passkeys (WebAuthn PRF)
- [`on-oidc`](../../packages/on-oidc) · OAuth / OIDC split-key bridge
- [`on-magic-link`](../../packages/on-magic-link) · one-shot viewer session
- [`on-recovery`](../../packages/on-recovery) · printable recovery codes
- [`on-shamir`](../../packages/on-shamir) · k-of-n secret sharing
- [`on-totp`](../../packages/on-totp) · RFC 6238 TOTP
- [`on-email-otp`](../../packages/on-email-otp) · email OTP with transport abstraction
- [`on-pin`](../../packages/on-pin) · session-resume PIN
- [`on-threat`](../../packages/on-threat) · lockout + duress + honeypot triad

---

## Composition

`on-*` packages are building blocks. You layer them however your policy
needs — typical stacks:

- **Personal app.** `on-pin` (quick resume) + passphrase (long-idle).
- **Team vault.** `on-webauthn` primary + `on-recovery` fallback.
- **Enterprise SSO.** `on-oidc` + `on-totp` (2FA).
- **Client portal.** `on-magic-link` for viewers, passphrase for owner.
- **High-risk.** `on-shamir` k-of-n + `on-threat` duress + `on-webauthn` primary.

Each package is stateless primitives — the caller decides persistence,
audit logging, and rate-limiting. That's why every `on-*` ships with its
own `docs/spec/archive/` entry explaining the threat model rather than
imposing one.

[← Back to README](../../README.md)
