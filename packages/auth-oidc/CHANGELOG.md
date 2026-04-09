# @noy-db/auth-oidc

## 1.0.0

### Minor Changes

- bbf13ff: **New package: `@noy-db/auth-oidc` (#112)** — OAuth/OIDC bridge with
  Bitwarden-style split-key connector. The KEK is XOR-split into a `serverHalf`
  (held by the key-connector endpoint) and a `deviceHalf` (in the browser); the
  server never sees the full KEK.

  Key features:

  - `enrollOidc` / `unlockOidc` round-trip using PKCE + id_token.
  - Built-in `knownProviders.line()`, `knownProviders.google()`,
    `knownProviders.apple()` factory helpers.
  - `parseIdTokenClaims` / `isIdTokenExpired` utilities.
  - Errors: `OidcTokenError`, `KeyConnectorError`,
    `OidcDeviceSecretNotFoundError`.

  Exports: `enrollOidc`, `unlockOidc`, `knownProviders`, `parseIdTokenClaims`,
  `isIdTokenExpired` and types `OidcProviderConfig`, `OidcEnrollment`,
  `OidcEnrollOptions`, `OidcUnlockOptions`.

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0
