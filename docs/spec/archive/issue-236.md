# Issue #236 — feat(on-magic-link): extract hub/session magic-link helpers into @noy-db/on-magic-link

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security

---

Currently `deriveMagicLinkKEK` / `createMagicLinkToken` / `isMagicLinkValid` / `buildMagicLinkKeyring` / `MAGIC_LINK_DEFAULT_TTL_MS` all export from `@noy-db/hub`. Conceptually they are a passphrase-less unlock path, identical in shape to `@noy-db/on-oidc` and `@noy-db/on-webauthn` — wrap a keyring at enrol time, produce a single-use token, reconstruct the keyring at unlock.

Extract into new workspace package `packages/on-magic-link/` with enrol + unlock + token-verify exports. Hub keeps a thin re-export wrapper for backward compat during the v0.15.1 window; those wrappers can be removed in v0.16 or v1.0.

Closes the last "auth helper living in hub" — after this, every `@noy-db/on-*` concern is in its own package. Pairs naturally with `@noy-db/on-recovery` (one-time codes) and `@noy-db/on-email-otp` (planned in v0.15 Auth fork).
