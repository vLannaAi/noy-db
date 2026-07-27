# @noy-db/in-liff

## 0.4.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.5

## 0.4.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.4

## 0.4.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.3

## 0.4.0-pre.2

### Minor Changes

- New satellite `@noy-db/in-liff` — the LIFF shell binding for the LINE client portal (#802): `initLiffApp` (boot, login enforcement, three-shell detection, ID-token read, share-link deep-link ingestion), `getFreshIdToken` (client-side expiry detection, re-login or typed throw — an unlocked session survives token expiry), `openExternal` (the escape hatch, with the Android WebAPK / iOS manual-hop / LINE-WebView-isolation handoff matrix documented). The LIFF SDK is injected via the structural `LiffLike` interface — never a dependency; CI runs fully mocked.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.2
