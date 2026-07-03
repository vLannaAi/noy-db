# @noy-db/on-pin

[![npm](https://img.shields.io/npm/v/%40noy-db/on-pin.svg)](https://www.npmjs.com/package/@noy-db/on-pin)

> Session-resume PIN quick-lock for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/on-pin
```

## What it is

Session-resume PIN quick-lock for noy-db — after a full passphrase unlock, a short-lived PIN (or a per-device biometric) re-unlocks the cached DEKs without re-typing the passphrase. PIN never replaces the passphrase; only resumes an already-unlocked session.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/on-pin`](https://github.com/vLannaAi/noy-db/tree/main/packages/on-pin)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
