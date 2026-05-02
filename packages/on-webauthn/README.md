# @noy-db/on-webauthn

[![npm](https://img.shields.io/npm/v/%40noy-db/on-webauthn.svg)](https://www.npmjs.com/package/@noy-db/on-webauthn)

> WebAuthn hardware-key keyrings for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/on-webauthn
```

## What it is

WebAuthn hardware-key keyrings for noy-db — Touch ID, Face ID, Windows Hello, YubiKey, FIDO2 passkeys

## Plumbing into `createNoydb`

`unlockWebAuthn(enrollment)` returns an `UnlockedKeyring`. As of `@noy-db/hub@0.1.0-pre.4` ([issue #5](https://github.com/vLannaAi/noy-db/issues/5)), pass it directly to `createNoydb` via the `getKeyring` callback — no passphrase bridge required:

```ts
import { createNoydb } from '@noy-db/hub'
import { unlockWebAuthn } from '@noy-db/on-webauthn'

const enrollment = await loadEnrollmentFromIDB()  // your storage of choice

const db = await createNoydb({
  store,
  user: 'alice',
  getKeyring: (vault) => unlockWebAuthn(enrollment),
})
```

The callback is invoked lazily on the first `openVault(name)` per vault and the keyring is cached for the lifetime of the instance. `secret` and `getKeyring` are mutually exclusive — provide exactly one.

For first-time bootstrap (no enrollment exists yet), open the vault with a passphrase, enroll WebAuthn from the unlocked keyring (`enrollWebAuthn(keyring, ...)`), persist the enrollment, then swap to `getKeyring` on subsequent sessions.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/on-webauthn`](https://github.com/vLannaAi/noy-db/tree/main/packages/on-webauthn)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
