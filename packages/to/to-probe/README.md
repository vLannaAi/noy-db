# @noy-db/to-probe

[![npm](https://img.shields.io/npm/v/%40noy-db/to-probe.svg)](https://www.npmjs.com/package/@noy-db/to-probe)

> Diagnostic companion for the @noy-db/to-* store family

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-probe
```

## What it is

Diagnostic companion for the @noy-db/to-* store family — not itself a storage backend. Setup-time suitability test + topology check + runtime reliability monitor. Exercises the 6-method NoydbStore contract across five axes (write latency, CAS integrity, hydration cost, sync economics, network resilience) and produces a structured risk-scored report.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-probe`](https://github.com/vLannaAi/noy-db/tree/main/packages/to-probe)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
