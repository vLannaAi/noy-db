# @noy-db/on-totp

[![npm](https://img.shields.io/npm/v/%40noy-db/on-totp.svg)](https://www.npmjs.com/package/@noy-db/on-totp)

> TOTP (RFC 6238) authenticator-app second factor for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/on-totp
```

## What it is

TOTP (RFC 6238) authenticator-app second factor for noy-db — generate secrets, otpauth:// provisioning URIs, and constant-time code verification. Zero dependencies (HMAC-SHA1 via Web Crypto). Part of the @noy-db/on-* authentication family.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/on-totp`](https://github.com/vLannaAi/noy-db/tree/main/packages/on-totp)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
