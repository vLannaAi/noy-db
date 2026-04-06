# @noy-db/browser

> Browser storage adapter for [noy-db](https://github.com/vLannaAi/noy-db) — localStorage and IndexedDB with optional key obfuscation.

[![npm](https://img.shields.io/npm/v/@noy-db/browser.svg)](https://www.npmjs.com/package/@noy-db/browser)

## Install

```bash
pnpm add @noy-db/core @noy-db/browser
```

## Usage

```ts
import { createNoydb } from '@noy-db/core'
import { browser } from '@noy-db/browser'

const db = await createNoydb({
  adapter: browser({
    backend: 'localStorage', // or 'indexedDB' or 'auto'
    prefix: 'my-app',
    obfuscate: true,         // hash keys + XOR-encode metadata
  }),
  userId: 'alice',
  passphrase: await promptUser(),
})
```

## Key obfuscation

With `obfuscate: true`, storage keys look like:

```
my-app:d2e076ae:f4494ed9:7f2f8a9c  →  { _iv: "…", _data: "…" }
```

No collection names, no record IDs, no compartment names visible in DevTools. Combined with AES-256-GCM ciphertext in `_data`, this gives full metadata privacy on the client.

## Backends

| Backend | Use when |
|---------|----------|
| `localStorage` | Small datasets (<5MB), synchronous API, simpler DevTools inspection |
| `indexedDB` | Larger datasets, better performance, binary-friendly |
| `auto` | Prefers IndexedDB, falls back to localStorage |

## License

MIT © vLannaAi — see the [noy-db repo](https://github.com/vLannaAi/noy-db) for full documentation.
