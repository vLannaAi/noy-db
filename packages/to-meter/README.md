# @noy-db/to-meter

[![npm](https://img.shields.io/npm/v/%40noy-db/to-meter.svg)](https://www.npmjs.com/package/@noy-db/to-meter)

> Pass-through meter for @noy-db/to-* stores

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-meter
```

## What it is

Pass-through meter for @noy-db/to-* stores — wraps any NoydbStore and records per-method latency percentiles, error rates, and byte counts on real traffic. Optional synthetic liveness probe emits degraded / restored events. No synthetic benchmarks (see @noy-db/to-probe for that) — this measures what your app is actually doing.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-meter`](https://github.com/vLannaAi/noy-db/tree/main/packages/to-meter)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
