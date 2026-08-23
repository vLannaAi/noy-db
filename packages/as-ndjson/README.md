# @noy-db/as-ndjson

[![npm](https://img.shields.io/npm/v/%40noy-db/as-ndjson.svg)](https://www.npmjs.com/package/@noy-db/as-ndjson)

> Newline-delimited JSON export for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/as-ndjson
```

## What it is

Newline-delimited JSON export for noy-db — streaming plaintext export suitable for data pipelines, warehouse ingestion, and jq pipelines. Gated by `vault.assertCanExport('plaintext', …)`. Part of the @noy-db/as-* portable-artefact family (plaintext tier).

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/as-ndjson`](https://github.com/vLannaAi/noy-db/tree/main/packages/as-ndjson)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
