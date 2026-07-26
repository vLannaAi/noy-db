# @noy-db/in-pwa

[![npm](https://img.shields.io/npm/v/%40noy-db/in-pwa.svg)](https://www.npmjs.com/package/@noy-db/in-pwa)

> Installable/offline shell helpers for noy-db SPAs

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/in-pwa
```

## The premise: the PWA starts empty

An installed PWA lives in **its own storage partition**. On first open it holds no
data: the app runs the online enrollment (unlock + re-invite via
[`@noy-db/on-oidc`](https://github.com/vLannaAi/noy-db/tree/main/packages/on-oidc))
and hydrates the vault from the firm cloud store into
[`@noy-db/to-browser-idb`](https://github.com/vLannaAi/noy-db/tree/main/packages/to-browser-idb).
From then on the installed app is the **offline-capable home of the vault**:
offline boot = cached app shell (service worker) + local IndexedDB vault.

This package is the browser-shell plumbing around that lifecycle. It holds **no
keys** and sees **no plaintext** — every helper here operates on browser shell
APIs or on opaque ciphertext-store presence, so it adds nothing to the threat
model.

## Persistence & eviction

Eviction of the local vault is the top PWA risk. iOS ITP evicts all
script-writable storage (IndexedDB included) of **non-installed** web content
after ~7 days without interaction; installed home-screen apps are safer, and
`navigator.storage.persist()` exempts an origin from best-effort eviction where
granted. Two helpers cover the risk:

### `requestPersistence()`

```ts
import { requestPersistence } from '@noy-db/in-pwa'

const res = await requestPersistence()
// { persisted: boolean, quota?: number, usage?: number,
//   grantedBy: 'already' | 'granted' | 'denied' | 'unsupported' }
```

Wraps `navigator.storage.persist()` + `estimate()` with a clear grant/deny
signal. **Never throws** — browsers without the Storage API resolve to
`grantedBy: 'unsupported'`. Call it during enrollment; warn the user on
`'denied'`.

### `guardLocalVault()` — fail closed at boot

If the partition *was* evicted, the app must never crash and never present a
silent empty vault as truth. The guard probes the local store before the vault
is opened and routes a missing vault into re-enrollment:

```ts
import { guardLocalVault } from '@noy-db/in-pwa'
import { browserIdb } from '@noy-db/to-browser-idb'

const store = browserIdb()
const { healthy } = await guardLocalVault(store, 'firm', (why) => {
  // why: { present: false, reason: 'empty' | 'probe-failed', cause? }
  routeToReEnrollment()
})
if (healthy) {
  /* open the vault normally */
}
```

The probe (`probeLocalVault(store, vaultId)`) is **store-agnostic** — it speaks
only the 6-method `NoydbStore` contract (`@noy-db/hub/to`), never
`to-browser-idb` internals. It checks the vault's `_keyring` marker records
first (every encrypted vault persists its owner keyring at creation — the same
signal the hub uses for "vault provisioned"), then falls back to a `loadAll()`
envelope scan for plaintext-mode vaults. A **broken store is treated exactly
like a missing vault**: probe errors resolve to
`{ present: false, reason: 'probe-failed' }` and trigger `onEvicted` — fail
closed, never a throw from the probe path.

## Install UX

```ts
import { captureInstallPrompt, getDisplayContext, isIosSafari } from '@noy-db/in-pwa'

// Android/desktop Chromium: defer the browser prompt, re-fire it from your UI.
const install = captureInstallPrompt() // call once at boot
// later, on a user gesture:
const outcome = await install.promptInstall() // 'accepted' | 'dismissed' | 'unavailable'

getDisplayContext() // 'pwa' (standalone display-mode / iOS navigator.standalone) | 'browser'
isIosSafari()       // true → show the "Add to Home Screen" share-sheet interstitial
                    // (iOS never fires beforeinstallprompt)
```

The shared shell-context contract with `@noy-db/in-liff` is exported here as a
plain string union (no runtime coupling):

```ts
export type AppShellContext = 'liff' | 'browser' | 'pwa'
```

## Online/offline transitions

```ts
import { watchOnline } from '@noy-db/in-pwa'

const stop = watchOnline((online) => syncStrategy.setOnline(online))
```

Invokes the callback immediately with `navigator.onLine`, then on every
`online`/`offline` event — shaped for feeding the sync engine's `isOnline`
flag (reconnect replay of the dirty queue lives in `with-sync`; this package
does not import it).

## Service-worker recipe (copy, don't import)

This package ships **no service-worker runtime** — the SW below is a recipe you
copy into your app and version yourself.

> **Hard rule: vault data NEVER goes in the SW cache.** The vault lives
> encrypted in `to-browser-idb`; the service worker caches the **app shell
> only** (HTML/JS/CSS/icons). A SW cache of vault responses would create a
> second, unmanaged copy of ciphertext outside the store contract — and a
> plaintext copy if you cached decrypted API responses. Don't.

```js
// sw.js — app-shell caching only. Bump SHELL_CACHE on every deploy.
const SHELL_CACHE = 'app-shell-v1'
const SHELL_ASSETS = ['/', '/index.html', '/assets/app.js', '/assets/app.css', '/icons/192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Drop caches from previous shell versions.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // App shell only: same-origin GET navigations and static assets.
  // Everything else (sync traffic, APIs) passes straight to the network —
  // vault data is never cached here.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  event.respondWith(
    caches.match(event.request).then((hit) => hit ?? fetch(event.request)),
  )
})
```

Offline boot then composes as: SW serves the cached shell → `guardLocalVault()`
confirms the local vault is present → the app opens it from `to-browser-idb`
with no network at all.

## Detaching from LINE / re-enrollment

Storage partitions are never transferable: LINE's WebView, the browser tab, and
the installed PWA each have isolated storage, so moving the vault into the
installed app is a **re-enroll + re-sync ceremony, never a data transfer** — the
firm re-invites the device via the
[`@noy-db/on-oidc`](https://github.com/vLannaAi/noy-db/tree/main/packages/on-oidc)
unlock flow and the fresh partition hydrates from the firm cloud store, exactly
like first enrollment. `guardLocalVault()`'s `onEvicted` hook is where that
ceremony is (re-)entered.

## Status

**Pre-release** (`0.4.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/in-pwa`](https://github.com/vLannaAi/noy-db/tree/main/packages/in-pwa)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
