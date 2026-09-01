# @noy-db/in-pwa

## 0.7.0

### Patch Changes

- READMEs now document the API that exists (#1252). Every fenced example in
  shipped prose compiles against the built `dist`, enforced by
  `check:prose-examples`.

  The two that were more than renames:

  - **on-recovery**: the README taught the KEK-wrapping architecture removed in
    the tier-2 wrap-DEKs unification (`0.1.0-pre.8`, #42) — `unwrapKEKFromRecovery`,
    `wrapKEKForRecovery`, `kek:` option, `_recovery_<N>` keyring entries, and a
    40-line manual unlock loop, none of which exist. Rewritten to the real flow:
    `generateRecoveryCodeSet({ deks })` → `db.team.enrollRecovery` →
    `db.recoverSecret` (which burns and auto-rotates), with a History note on why
    there is no KEK path.
  - **in-vue**: `enrollBiometric`/`unlockWithBiometric` never existed in any
    version. The section now teaches `@noy-db/on-webauthn`'s real API, which is
    framework-neutral and called from Vue directly.

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
  - @noy-db/hub@0.7.0

## 0.7.0-pre.16

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.16

## 0.7.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.12

## 0.7.0-pre.11

### Patch Changes

- READMEs now document the API that exists (#1252). Every fenced example in
  shipped prose compiles against the built `dist`, enforced by
  `check:prose-examples`.

  The two that were more than renames:

  - **on-recovery**: the README taught the KEK-wrapping architecture removed in
    the tier-2 wrap-DEKs unification (`0.1.0-pre.8`, #42) — `unwrapKEKFromRecovery`,
    `wrapKEKForRecovery`, `kek:` option, `_recovery_<N>` keyring entries, and a
    40-line manual unlock loop, none of which exist. Rewritten to the real flow:
    `generateRecoveryCodeSet({ deks })` → `db.team.enrollRecovery` →
    `db.recoverSecret` (which burns and auto-rotates), with a History note on why
    there is no KEK path.
  - **in-vue**: `enrollBiometric`/`unlockWithBiometric` never existed in any
    version. The section now teaches `@noy-db/on-webauthn`'s real API, which is
    framework-neutral and called from Vue directly.

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.11

## 0.7.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.9

## 0.7.0-pre.8

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.8

## 0.7.0-pre.6

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.6

## 0.7.0-pre.5

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.5

## 0.7.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.4

## 0.7.0-pre.3

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.3

## 0.7.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.2

## 0.7.0-pre.1

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.1

## 0.7.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.0

## 0.6.0

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
  - @noy-db/hub@0.6.0

## 0.6.0-pre.24

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.24

## 0.6.0-pre.23

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.23

## 0.6.0-pre.22

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.22

## 0.6.0-pre.21

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.21

## 0.6.0-pre.20

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.20

## 0.6.0-pre.19

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.19

## 0.6.0-pre.18

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.18

## 0.6.0-pre.17

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.17

## 0.6.0-pre.16

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.16

## 0.6.0-pre.15

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.15

## 0.6.0-pre.14

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.14

## 0.6.0-pre.13

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.13

## 0.6.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.12

## 0.6.0-pre.11

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.11

## 0.6.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.10

## 0.6.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.9

## 0.6.0-pre.8

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.8

## 0.6.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.7

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
