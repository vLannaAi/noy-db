# Changelog — at-macos-keychain

## 1.0.0-pre.8

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.8

## 1.0.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.7

## 1.0.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.6

## 0.3.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.5

## 0.3.0-pre.4

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.4

## 0.3.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.3

## 0.3.0-pre.2

### Minor Changes

- 0.3 version line continues — lockstep with `@noy-db/hub` 0.3.0-pre.2 (describe() group/order metadata, \_history in the .noydb pod; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.2

## 0.3.0-pre.1

### Minor Changes

- 0.3 version line — lockstep with `@noy-db/hub` 0.3.0-pre.1 (kernel/enclave reorg, family doors, `withX()` service gating; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.1

## 0.2.0-pre.31

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.31

## 0.2.0-pre.5

Version-only lockstep bump; no source changes since pre.4.

## 0.2.0-pre.4

Version-only lockstep bump; no source changes since pre.3.

## 0.2.0-pre.3

Version-only lockstep bump; no source changes since pre.2.

## 0.2.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.2

## 0.2.0-pre.1

### Patch Changes

- Managed-mode vaults now also require a `shamirRecovery` provider passed to `createNoydb` (managed mode mandates strong recovery; [#211](https://github.com/vLannaAi/noy-db/issues/211)). No API change to this package.
- Updated dependencies
  - @noy-db/hub@0.2.0-pre.1

## 0.1.0-pre.16

First release. Part of the `at-*` sealing-key provider family debut.

- macOS Keychain `SealingKeyProvider` ([#191](https://github.com/vLannaAi/noy-db/issues/191)) — stores the vault sealing key in the OS Keychain via `@napi-rs/keyring` (peer dependency), so unlock is gated by the OS account rather than a typed passphrase.
- Envelope aligned with the hub sealed-envelope format.
- Carries AES-256-GCM sealed wrap material; the provider never sees plaintext DEKs.
