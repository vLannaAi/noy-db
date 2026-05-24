# Changelog — at-env

## 0.2.0-pre.1

### Patch Changes

- Managed-mode vaults now also require a `shamirRecovery` provider passed to `createNoydb` (managed mode mandates strong recovery; [#211](https://github.com/vLannaAi/noy-db/issues/211)). No API change to this package.
- Updated dependencies
  - @noy-db/hub@0.2.0-pre.1

## 0.1.0-pre.16

First release. Debuts the `at-*` sealing-key provider family.

- Env-var `SealingKeyProvider` ([#187](https://github.com/vLannaAi/noy-db/issues/187)) — derives a vault sealing key from an environment variable, for unattended / managed-host unlock where no human is present to type a passphrase.
- Carries AES-256-GCM sealed wrap material; the provider never sees plaintext DEKs.
