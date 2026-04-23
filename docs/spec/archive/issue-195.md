# Issue #195 — feat(on-email-otp): @noy-db/on-email-otp — email OTP with SMTP + customizable mail template

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security

---

Email-delivered one-time code for unlock. Options: SMTP host/port/user/pass config, from address, subject template, HTML template, plaintext fallback. Template variables: {code}, {expires_at}, {display_name}, {vault_name}. Ships a default template; consumer can override. Includes test helper (ephemeral SMTP server mock, e.g. smtp-tester or mailhog-style). Code stored server-side keyed by email + nonce; validation is constant-time.
