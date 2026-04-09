# @noy-db/auth-webauthn

## 1.0.0

### Minor Changes

- eb52e1f: **New package: `@noy-db/auth-webauthn` (#111)** — hardware-key keyrings via
  WebAuthn + PRF extension. Enrolling creates a `WebAuthnEnrollment` record
  (stored alongside the keyring) that maps a passkey's PRF output to the
  compartment KEK. On subsequent unlocks the passphrase prompt is skipped
  entirely.

  Key features:

  - PRF extension for deterministic key derivation; `rawId`-HKDF fallback for
    authenticators without PRF support.
  - `BE`-flag guard — throws `WebAuthnMultiDeviceError` if `singleDevice: true`
    and the credential was synced to a cloud keychain.
  - Errors: `WebAuthnNotAvailableError`, `WebAuthnCancelledError`,
    `WebAuthnMultiDeviceError`.

  Exports: `enrollWebAuthn`, `unlockWebAuthn` and types `WebAuthnEnrollment`,
  `WebAuthnEnrollOptions`, `WebAuthnUnlockOptions`.

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0
