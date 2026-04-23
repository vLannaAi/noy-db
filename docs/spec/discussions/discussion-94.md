# Discussion #94 — @noy-db/drive: Google Drive bundle adapter (OAuth + opaque-handle filenames)

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **State:** closed
- **Comments:** 1
- **URL:** https://github.com/vLannaAi/noy-db/discussions/94

---

Proposal for a new adapter package, `@noy-db/drive`, targeting consumer Google Drive accounts. Depends on the bundle adapter interface (sibling discussion) and the `.noydb` container format (sibling discussion). **This discussion is only about the Drive-specific choices**: OAuth, scopes, token storage, API surface.

## Why Drive, why now

- Every Android phone ships with Drive preinstalled and an already-authenticated Google account. For mobile-first deployments — which includes most of Southeast Asia — this is the lowest-friction "cloud storage" the user already has, already paid for, and already trusts to some degree.
- Free tier: 15 GB shared across Gmail/Photos/Drive (not 50 GB — that's the paid Google One tier). Typical compressed encrypted bundle at the spec's 50K-record ceiling is well under 100 MB. A free-tier consumer gets 150+ bundles.
- Drive never sees plaintext. Our encryption guarantees are unchanged — Drive stores an opaque blob with a custom MIME type. Google's ToS around content scanning is moot because there's nothing to scan.
- Drive's native file revisions act as a free versioning backstop alongside NOYDB's ledger.

## File naming: opaque handle, no business identity

Drive files are named **`<handle>.noydb`** where `<handle>` is the ULID assigned at first export (see `.noydb` format discussion).

```
NoyDB/
├── 01HXG4F5ZK7QJ8M3R6T9V2W0YN.noydb
├── 01HXG4G2A9F0K1P3Q5S7T9V0WX.noydb
└── 01HXG4H8B7C2D4E6F8G0H2J4KL.noydb
```

Why: Drive folder listings are visible to anyone the user shares the parent folder with, indexed by Google's account-internal search, surfaced in account-takeover incident logs, and visible to Google Workspace admins on managed accounts. Naming the file `acme-corp.noydb` would leak client identity to all of those surfaces. Naming it by an opaque handle leaks nothing.

The mapping `handle → human-readable compartment name` lives **inside** the bundle (encrypted, in the dump), never outside.

## Scope choice: `drive.file`, not `drive.appdata` or `drive`

| Scope | Visibility | Verdict |
|---|---|---|
| `drive.appdata` | Hidden app-private folder | ❌ Breaks "share a bundle with a colleague via Drive" |
| `drive.file` | User-visible files the app created or user picked | ✅ **Recommended default** |
| `drive` | Full Drive read/write | ❌ Overreach; consent screen will scare users |

`drive.file` is the right default because:

1. Bundles are visible in Drive UI → user can manually share, move, rename, delete.
2. Google's OAuth consent screen for `drive.file` doesn't require brand verification / third-party audit. `drive` does.
3. Least-privilege: revoking the app only orphans `.noydb` files; nothing else in the user's Drive is touched.

## OAuth flow: Authorization Code with PKCE

Pure browser/PWA means **no client secret**. Standard OAuth 2.0 Authorization Code + PKCE (RFC 7636). The adapter ships with a `createDriveAuth()` helper that handles:

1. Building the authorize URL with `code_challenge` (S256).
2. Handling the redirect callback and exchanging `code` + `verifier` for tokens.
3. Refreshing access tokens lazily.
4. Detecting revocation (401 → re-auth required) and emitting a lifecycle event.

Redirect strategies:

- **Desktop browser:** popup with `postMessage` back.
- **Android browser:** full-page redirect (popups are hostile on mobile). State param carries return path.
- **Browser extension:** `chrome.identity.launchWebAuthFlow` (simplest path — Chrome handles the redirect URI for you).
- **Electron / native wrapper:** loopback redirect on `http://127.0.0.1:<random>`.

All paths hand back the same `{ accessToken, refreshToken, expiresAt }` shape.

## Token storage: inside NOYDB, encrypted

**This is the part that has to be right.** The refresh token is a long-lived credential. Storing it in `localStorage` or unencrypted IndexedDB is a non-starter — any XSS walks away with persistent Drive access.

Proposal: store Drive OAuth tokens inside a **reserved internal collection**, `_sync_credentials`, encrypted with the compartment's own DEK. Same wrapping as any other record.

Consequences:

- The refresh token gets the exact same zero-knowledge treatment as invoice data. Drive sees ciphertext; disk sees ciphertext; memory decrypts only during an active session.
- A stolen locked device cannot silently sync in the background — the attacker needs the passphrase to even read the refresh token. **Feature**, not bug: matches the existing invariant that KEK lives only in memory.
- Background sync from a service worker is impossible while the compartment is locked. Also a feature.
- One extra AES-GCM decrypt per session. Negligible cost.

Integrates with the v0.7 "Identity & sessions" milestone (`ROADMAP.md:304`) — the session unlock path gains one extra step: after KEK is in memory, opportunistically decrypt `_sync_credentials` and prime the Drive client.

## API surface

```ts
import { drive } from '@noy-db/drive'
import { createNoydb } from '@noy-db/core'

const db = await createNoydb({
  auth: { userId: 'vlanna', passphrase: '...' },
  sync: drive({
    auth: {
      mode: 'pkce',
      clientId: '1234.apps.googleusercontent.com',
      redirectUri: 'https://app.example.com/oauth/callback',
      scopes: ['drive.file'],
    },
    folder: 'NoyDB',                // user-visible folder name; created if missing
    compression: 'brotli',
  }),
})
```

The adapter takes no `fileName` option — file naming is `<handle>.noydb`, derived from the compartment's persisted handle, not configurable. Consumers who want to call their bundles something else are leaking metadata they probably didn't mean to leak.

## Drive API calls — minimal surface

| Bundle method | Drive API calls |
|---|---|
| `pullBundle` | `files.list?q=name='<handle>.noydb'+and+'<folderId>'+in+parents` (cached) → `files.get?alt=media` with `If-None-Match: <etag>` |
| `pushBundle` | `files.update?uploadType=multipart` with `If-Match: <etag>` (existing) OR `files.create` (first upload) |
| `headVersion` | `files.get?fields=headRevisionId,modifiedTime` (no body) |
| `listBundles` | `files.list?q=name+contains+'.noydb'+and+trashed=false` |

**No `googleapis` npm dep.** Plain `fetch()` against `https://www.googleapis.com/drive/v3/...`. Keeps the bundle-size budget reachable (`ROADMAP.md:609`: adapters <10 KB gzipped).

## Lifecycle events

- `drive:auth-required` — no valid token, need to re-run OAuth
- `drive:quota-exceeded` — user hit 15 GB or daily quota
- `drive:conflict` — push lost the ETag race, retrying
- `drive:rate-limited` — 429 or `userRateLimitExceeded`, backing off

Surfaced through `useSync()` so the app can render non-fatal warnings — critical for mobile where "out of storage" is a common failure mode.

## Open questions

1. **Public OAuth client ID — do we ship one?** A shared default `clientId` in `@noy-db/drive` means consumers get zero-config OAuth, but every NOYDB app shows up as "NOYDB" on the Google consent screen, not the consumer's brand. Leaning toward: no default, require consumers to register their own. The scaffolder can template the OAuth setup.
2. **Service account support?** Only relevant for shared-folder deployments. YAGNI for v1.
3. **Shared drives (Google Workspace team drives)?** Same API, different `corpora` param. Easy follow-up.
4. **What goes in `_sync_credentials` besides Drive tokens?** Eventually any other OAuth tokens (Dropbox, Box, etc.). Worth picking a multi-provider schema from day one.
5. **Cross-device handle reconciliation.** If a user installs NOYDB on a second device and authenticates to Drive, how does the second device know which `.noydb` files are "theirs"? Probably: list bundles, download header from each, prompt user to select + enter passphrase to confirm ownership. Costs N HEAD requests on first sync per device.

## Out of scope for this discussion

- Whether the bundle adapter interface should exist at all — sibling discussion.
- The `.noydb` container format — sibling discussion.
- Sync frequency and scheduling — sibling discussion.
- Reader UX (CLI extension, browser extension, file association) — sibling discussion.


> _Comments are not archived here — see the URL for the full thread._
