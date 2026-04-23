# Issue #237 — feat(on-biometric): extract hub/biometric.ts or fold into @noy-db/on-webauthn after review

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security

---

`packages/hub/src/biometric.ts` currently exports `isBiometricAvailable` / `enrollBiometric` / `unlockBiometric` / `saveBiometric` / `loadBiometric` / `removeBiometric`. Decision needed: does this module overlap with `@noy-db/on-webauthn` (which already covers biometric unlock via WebAuthn passkeys + PRF on modern platforms)?

Two possible outcomes:

1. **Redundant** — the biometric.ts flow is a simpler/older API that WebAuthn subsumes. Delete hub/biometric.ts, redirect any consumers at `@noy-db/on-webauthn`. Simpler.

2. **Distinct** — hub/biometric.ts covers a use case WebAuthn does not (e.g., Capacitor / React Native native biometric APIs outside the web context). Extract into a new `@noy-db/on-biometric` package. More explicit.

Task: audit `hub/src/biometric.ts` against `@noy-db/on-webauthn` public API, decide between (1) and (2), file a follow-up commit or deletion accordingly.
