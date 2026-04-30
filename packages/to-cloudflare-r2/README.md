# @noy-db/to-cloudflare-r2

[![npm](https://img.shields.io/npm/v/%40noy-db/to-cloudflare-r2.svg)](https://www.npmjs.com/package/@noy-db/to-cloudflare-r2)

> Cloudflare R2 adapter for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-cloudflare-r2
```

## What it is

Cloudflare R2 adapter for noy-db — S3-compatible object storage with zero egress fees. Thin wrapper around @noy-db/to-aws-s3 configured for the R2 endpoint. casAtomic: false (same caveat as S3).

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-cloudflare-r2`](https://github.com/vLannaAi/noy-db/tree/main/packages/to-cloudflare-r2)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
