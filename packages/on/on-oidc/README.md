# @noy-db/on-oidc

[![npm](https://img.shields.io/npm/v/%40noy-db/on-oidc.svg)](https://www.npmjs.com/package/@noy-db/on-oidc)

> OAuth/OIDC bridge for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/on-oidc
```

## What it is

OAuth/OIDC bridge for noy-db — federated login (LINE, Google, Apple, Okta, any OIDC-compliant provider) using a split-key model where the KEK is XOR-split between a device half and a server half. The server never sees the unwrapped KEK or any plaintext.

## ⚠️ Server-side dependency

**This package handles the CLIENT side only.** Using OIDC as a tier-2 unlock requires you to operate a **key-connector server** that:

1. Verifies ID tokens against the issuer's JWKS (`PUT/GET /kek-fragment` endpoints).
2. Stores per-user `serverHalf` indexed by the OIDC `sub` claim.
3. Periodically rotates the encryption key used for stored serverHalves.

The protocol is fully documented at the top of [`src/index.ts`](./src/index.ts). noy-db does **not** ship a reference implementation, hosted instance, or deployment template — implementing this server is a consumer responsibility (any runtime that can verify JWT signatures + has a KV-style store works: Cloudflare Worker, Lambda, Express, Go).

**If you don't want to run a server**, use [`@noy-db/on-webauthn`](https://www.npmjs.com/package/@noy-db/on-webauthn) instead — platform passkey via Touch ID / Face ID / Windows Hello gives the same "Login with X" UX without server infrastructure, because the platform passkey IS the device-bound credential. See [issue #37](https://github.com/vLannaAi/noy-db/issues/37) for the discussion.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/on-oidc`](https://github.com/vLannaAi/noy-db/tree/main/packages/on-oidc)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
