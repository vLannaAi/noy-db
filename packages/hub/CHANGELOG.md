# Changelog — hub

## 0.1.0-pre.4

### Features

- **`NoydbOptions.getKeyring` callback** ([#5](https://github.com/vLannaAi/noy-db/issues/5)) — added an optional `getKeyring?: (vault: string) => Promise<UnlockedKeyring>` callback to `NoydbOptions`. Lets biometric (WebAuthn), OIDC split-key, Shamir, and any other unlock path that produces an `UnlockedKeyring` plug into `createNoydb` directly, without a passphrase bridge. `secret` and `getKeyring` are mutually exclusive; the callback is invoked lazily on the first vault open and the keyring is cached per `(instance, vault)`. Errors propagate from `openVault(name)`. Full backward compatibility — passphrase consumers see no change.

## 0.1.0-pre.1 — Initial pre-release
