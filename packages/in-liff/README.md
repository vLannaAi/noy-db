# @noy-db/in-liff

[![npm](https://img.shields.io/npm/v/%40noy-db/in-liff.svg)](https://www.npmjs.com/package/@noy-db/in-liff)

> LIFF (LINE Front-end Framework) shell binding for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/in-liff
```

## What it is

The boot layer for a noy-db portal SPA opened from LINE: one `initLiffApp()` call establishes the **shell** (`'liff' | 'browser' | 'pwa'` — one SPA, three shells), enforces LINE Login, reads the ID token for the `@noy-db/on-oidc` split-key unlock, and ingests a `@noy-db/hub/share-link` deep link from the current location.

The LIFF SDK is **injected, never a dependency** — every entry point takes a `LiffLike` (the six-member structural slice this package calls), so apps pass the real `liff` global and tests pass fakes.

```ts
import liff from '@line/liff'
import { initLiffApp, getFreshIdToken, openExternal } from '@noy-db/in-liff'

const ctx = await initLiffApp({ liff, liffId: import.meta.env.VITE_LIFF_ID })
// ctx: { shell, loggedIn, idToken, inClient, deepLink }

// Later, right before an on-oidc serverHalf fetch:
const token = getFreshIdToken(liff) // re-login on expiry (navigates away), or { onExpired: 'throw' }
```

## Token lifecycle

LIFF ID tokens live ~1 hour with **no silent refresh**. Expiry is detected client-side from the JWT `exp` (no network, no signature check — verification is the key-connector server's job, per `@noy-db/on-oidc`'s documented split). An unlocked noy-db session **survives token expiry**: the token is needed again only at the next serverHalf fetch — call `getFreshIdToken` exactly there.

## The platform handoff matrix (escape hatch)

`openExternal(liff, url)` breaks out of LINE's in-app WebView:

| Platform | What happens |
|---|---|
| **Android** | In-scope links open the **installed PWA directly** (WebAPK link capture); the WebAPK shares Chrome's origin storage. |
| **iOS** | Always opens Safari; the installed home-screen app cannot be targeted by URL and has its **own storage partition** — show an interstitial for the manual hop. |
| **All** | LINE's WebView storage is always isolated: the new shell starts empty and re-enrolls via the custodian re-invite (`@noy-db/on-oidc`) — a ceremony, not a data transfer. |

## In-LINE constraints

- **No WebAuthn** in LINE's in-app WebView — the in-LINE offline lock options are PIN and device-trust (`@noy-db/on-pin`); biometrics become available after detaching to the external browser / PWA shells.
- IndexedDB and `crypto.subtle` are available in all three shells (LIFF apps are HTTPS by requirement).

## Scope

Login + `openWindow` only — no LIFF messaging/share APIs, no server code, no UI. The PWA-side helpers (persistence, eviction guard, install prompts) live in `@noy-db/in-pwa`; the two packages share the `AppShellContext` union structurally, with no dependency between them.

## Status

**Pre-release** (`0.4.0-pre.x`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/in-liff`](https://github.com/vLannaAi/noy-db/tree/main/packages/in-liff)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)

## License

[MIT](./LICENSE) © vLannaAi
