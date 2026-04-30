# @noy-db/to-icloud

[![npm](https://img.shields.io/npm/v/%40noy-db/to-icloud.svg)](https://www.npmjs.com/package/@noy-db/to-icloud)

> iCloud Drive bundle store for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-icloud
```

## What it is

iCloud Drive bundle store for noy-db — macOS-aware persistence that detects eviction stubs (.icloud) and conflict files automatically. Treats each vault as a single .noydb bundle, safe for the Apple ecosystem.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-icloud`](https://github.com/vLannaAi/noy-db/tree/main/packages/to-icloud)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
