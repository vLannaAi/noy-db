# @noy-db/in-devtools

[![npm](https://img.shields.io/npm/v/%40noy-db/in-devtools.svg)](https://www.npmjs.com/package/@noy-db/in-devtools)

> Framework-agnostic, read-only inspector for a live [noy-db](https://github.com/vLannaAi/noy-db) — vaults, collections, schema, stats, records, and live writes.

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/in-devtools
```

## What it is

`createInspector(db, { meter? })` turns a live `Noydb` instance into serializable, read-only views for a CLI, a browser panel, or the terminal TUI ([`@noy-db/in-devtools-tui`](https://www.npmjs.com/package/@noy-db/in-devtools-tui)). It is a pure consumer of public hub APIs — read-only and zero-knowledge-respecting: it never holds passphrases and shows only what the caller's unlocked session can already read.

```ts
import { createInspector } from '@noy-db/in-devtools'

const inspector = createInspector(db)

inspector.listVaults()                                // accessible vaults
inspector.snapshot(vault)                             // collections: fields, indexes, refs, stats
inspector.records(vault, 'invoices', { limit: 50 })   // page decrypted rows (default 50, ceiling 500)
inspector.subscribe((e) => console.log(e))            // live write events
inspector.pendingWrites()                             // write-queue state
```

Pass a [`@noy-db/to-meter`](https://www.npmjs.com/package/@noy-db/to-meter) handle as `meter` to also expose `meterSnapshot()`.

## Documentation

- Guide — [`content/docs/families/in/devtools.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/families/in/devtools.md)
- Source — [`packages/in-devtools`](https://github.com/vLannaAi/noy-db/tree/main/packages/in-devtools)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)

## License

MIT
