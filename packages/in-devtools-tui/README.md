# @noy-db/in-devtools-tui

[![npm](https://img.shields.io/npm/v/%40noy-db/in-devtools-tui.svg)](https://www.npmjs.com/package/@noy-db/in-devtools-tui)

> Interactive terminal inspector for a live [noy-db](https://github.com/vLannaAi/noy-db) — an [ink](https://github.com/vadimdemedes/ink) TUI over [`@noy-db/in-devtools`](https://www.npmjs.com/package/@noy-db/in-devtools).

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add -D @noy-db/in-devtools-tui
```

## Usage

Point the `noydb-inspect` bin at a config file that default-exports your `NoydbOptions`. It unlocks the vault (prompting for the secret, or reading `--secret=…` / `NOYDB_SECRET`), then opens a read-only terminal dashboard of collections, records, and live writes.

```bash
npx noydb-inspect ./noydb.config.mjs --vault=acme
```

Add `--meter` to wrap the store in [`@noy-db/to-meter`](https://www.npmjs.com/package/@noy-db/to-meter) and show live store metrics. Like the inspector core it wraps, the TUI is read-only and never persists your secret.

## Documentation

- Guide — [`content/docs/families/in/devtools-tui.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/families/in/devtools-tui.md)
- Source — [`packages/in-devtools-tui`](https://github.com/vLannaAi/noy-db/tree/main/packages/in-devtools-tui)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)

## License

MIT
