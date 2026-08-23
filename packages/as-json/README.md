# @noy-db/as-json

[![npm](https://img.shields.io/npm/v/%40noy-db/as-json.svg)](https://www.npmjs.com/package/@noy-db/as-json)

> Structured JSON plaintext export for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/as-json
```

## What it is

Structured JSON plaintext export for noy-db — decrypts records and emits one JSON document per vault. Gated by `vault.assertCanExport('plaintext', …)` capability; writes an audit-ledger entry on every call. Part of the @noy-db/as-* portable-artefact family (plaintext tier).

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/as-json`](https://github.com/vLannaAi/noy-db/tree/main/packages/as-json)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
