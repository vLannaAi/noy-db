# {{PROJECT_NAME}}

An Electron + Vue 3 + Pinia desktop starter using
[noy-db](https://github.com/vLannaAi/noy-db) for encrypted local
storage. Scaffolded by `create-noy-db`.

## Stack

- **Electron** — cross-platform desktop runtime
- **Vue 3 + Pinia** — reactive renderer
- **@noy-db/hub** — zero-knowledge encrypted document store
- **@noy-db/to-file** — JSON-on-disk adapter (perfect for the
  USB-stick workflow)
- **@noy-db/in-pinia** — `defineNoydbStore` Pinia integration

Records are encrypted with AES-256-GCM before touching disk. The
on-disk JSON only ever contains `{ _iv, _data, _ts, _v }` envelopes.

## When to pick this template

- You want a **desktop app** that stores data locally — no cloud.
- You need a **portable vault** (USB stick, external drive) that
  moves between machines.
- You need rich OS integration (menus, tray, native file dialogs)
  that a browser SPA can't give you.

## Getting started

```bash
pnpm install
pnpm dev          # launches Electron with Vite HMR
pnpm build        # builds the renderer + packages with electron-builder
```

First launch prompts for a passphrase — that passphrase derives the
master encryption key. Lose it and the data is unrecoverable (by
design: the library cannot help you recover it).

## Project layout

```
electron/
  main.ts              # Electron main process — creates the BrowserWindow
src/
  main.ts              # Renderer bootstrap: pinia + noydb + mount
  App.vue              # Root component
  components/          # InvoiceTable.vue, AddInvoiceForm.vue
  stores/invoices.ts   # defineNoydbStore<Invoice>('invoices', { vault: 'demo' })
index.html
vite.config.ts
```

## Security posture

The generated scaffold opens Electron with `nodeIntegration: true`
and `contextIsolation: false` so the renderer can import
`@noy-db/to-file` directly. This is the pragmatic default for
**local-first apps that never load remote content**. If you're
shipping to production or plan to embed third-party content:

1. Move the Noydb handle to the main process.
2. Bridge a narrow API via `contextBridge` in a preload script.
3. Re-enable `contextIsolation` and disable `nodeIntegration`.

See the [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
for the full hardening guide.

## USB-stick workflow

```ts
// src/main.ts — swap the dir for a user-selected path
import { jsonFile } from '@noy-db/to-file'
const dir = '/Volumes/USB/myapp'   // or prompt the user
const db = await createNoydb({ store: jsonFile({ dir }), ... })
```

Because `to-file` writes plain JSON envelopes (each already
encrypted), the entire vault can travel on a USB stick or sync
directory with zero additional tooling.

## Documentation

- [noy-db START_HERE](https://github.com/vLannaAi/noy-db/blob/main/docs/choose-your-path.md)
- [Topology matrix](https://github.com/vLannaAi/noy-db/blob/main/docs/topologies.md)
- [Architecture](https://github.com/vLannaAi/noy-db/blob/main/docs/architecture.md)
