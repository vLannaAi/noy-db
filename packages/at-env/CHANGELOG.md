# Changelog — at-env

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

Docs-only: pruned internal issue-tracker references from source comments (Track A comment-provenance prune). No code or public API change.

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

First release. Debuts the `at-*` sealing-key provider family.

- Env-var `SealingKeyProvider` ([#187](https://github.com/vLannaAi/noy-db/issues/187)) — derives a vault sealing key from an environment variable, for unattended / managed-host unlock where no human is present to type a passphrase.
- Carries AES-256-GCM sealed wrap material; the provider never sees plaintext DEKs.
