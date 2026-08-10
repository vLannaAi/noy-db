# @noy-db/in-pwa

## 0.6.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.6

## 0.6.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.5

## 0.6.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.4

## 0.6.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.3

## 0.6.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.2

## 0.6.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.0

## 0.5.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.5.0

## 0.4.0

### Minor Changes

- New satellite `@noy-db/in-pwa` — installable/offline shell helpers for noy-db SPAs (#803). The PWA starts empty: first open in its own storage partition runs online enrollment and hydrates from the firm cloud; from then on it is the offline-capable home of the vault. Ships `requestPersistence()` (`navigator.storage.persist()`/`estimate()` with a clear `'already' | 'granted' | 'denied' | 'unsupported'` signal, never throws), the fail-closed boot-time eviction guard `guardLocalVault()`/`probeLocalVault()` (store-agnostic `_keyring`-marker probe over the `@noy-db/hub/to` contract — a wiped or broken local store routes to re-enrollment, never a crash or a silent empty vault), install UX helpers (`captureInstallPrompt()` deferred `beforeinstallprompt`, `getDisplayContext()` `'pwa' | 'browser'`, `isIosSafari()` for the add-to-home-screen interstitial), the shared `AppShellContext = 'liff' | 'browser' | 'pwa'` union (contract with the upcoming `@noy-db/in-liff`), `watchOnline()` connectivity wiring for the sync engine's `isOnline` flag, and the documented app-shell-only service-worker recipe (vault data never in the SW cache). No SW runtime, no background sync/push, no framework bindings.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0

## 0.4.0-pre.12

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.12

## 0.4.0-pre.11

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.11

## 0.4.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.10

## 0.4.0-pre.9

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.9

## 0.4.0-pre.8

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.8

## 0.4.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.7

## 0.4.0-pre.6

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.6

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

- New satellite `@noy-db/in-pwa` — installable/offline shell helpers for noy-db SPAs (#803). The PWA starts empty: first open in its own storage partition runs online enrollment and hydrates from the firm cloud; from then on it is the offline-capable home of the vault. Ships `requestPersistence()` (`navigator.storage.persist()`/`estimate()` with a clear `'already' | 'granted' | 'denied' | 'unsupported'` signal, never throws), the fail-closed boot-time eviction guard `guardLocalVault()`/`probeLocalVault()` (store-agnostic `_keyring`-marker probe over the `@noy-db/hub/to` contract — a wiped or broken local store routes to re-enrollment, never a crash or a silent empty vault), install UX helpers (`captureInstallPrompt()` deferred `beforeinstallprompt`, `getDisplayContext()` `'pwa' | 'browser'`, `isIosSafari()` for the add-to-home-screen interstitial), the shared `AppShellContext = 'liff' | 'browser' | 'pwa'` union (contract with the upcoming `@noy-db/in-liff`), `watchOnline()` connectivity wiring for the sync engine's `isOnline` flag, and the documented app-shell-only service-worker recipe (vault data never in the SW cache). No SW runtime, no background sync/push, no framework bindings.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.2
