# Changelog — at-azure-keyvault

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

### Minor Changes

- First release. Azure Key Vault `SealingKeyProvider` — RSA-OAEP-256 encrypt/decrypt. RSA decrypt is version-bound: pin a versioned keyId (auto-rotation on a versionless key orphans sealed vaults) ([#190](https://github.com/vLannaAi/noy-db/issues/190)).

