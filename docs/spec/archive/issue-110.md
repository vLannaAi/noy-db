# Issue #110 — feat(core): _sync_credentials reserved collection — encrypted per-adapter OAuth token store

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-09
- **Milestone:** v0.7.0
- **Labels:** type: feature, type: security, area: core

---

## Summary

Add a reserved internal collection, **`_sync_credentials`**, that stores per-adapter OAuth tokens (and any other long-lived sync secrets) as encrypted records inside the compartment itself. Tokens are wrapped with the compartment's own DEK, live on disk as ciphertext like any other record, and are lazily decrypted into memory only after the session is unlocked.

This is the primitive that keeps `@noy-db/drive`, future `@noy-db/dropbox`, `@noy-db/icloud`, and any other OAuth-backed adapter honest to the zero-knowledge invariant. Without it, adapters are forced to stash refresh tokens in `localStorage` or plaintext config — both of which reintroduce the third-party trust boundary the project exists to eliminate.

## Motivation

Every consumer cloud adapter needs to store an OAuth refresh token somewhere. The bad options:

- **`localStorage`** — trivially scrapable by any XSS, persistent across sessions, no protection at rest.
- **`IndexedDB`** unencrypted — same as above, harder to grep.
- **An env var or config file** — fine for server deployments, useless for PWAs, and the consumer has to solve rotation.
- **A separate keychain call** — works on native platforms, doesn't work on web, creates a platform-specific code path in every adapter.

The good option is the one the library already solves for every other secret: **encrypt it with the compartment's DEK, store it as a record, unwrap it when the session is unlocked.** That's exactly what `_sync_credentials` formalizes.

## Proposed design

### Reserved collection with a well-known shape

```
compartment/
├── _keyring/
├── _sync/              (existing — dirty tracking)
├── _sync_credentials/  (NEW)
│   ├── drive.json          (encrypted)
│   ├── dropbox.json        (encrypted)
│   └── icloud.json         (encrypted)
├── invoices/
└── ...
```

Like `_keyring` and `_sync`, this collection is:

- **Filtered out of `loadAll()`** — underscore-prefixed, adapters already skip it
- **Encrypted with the compartment DEK** — same crypto path as business records
- **Versioned via the ledger chain** — token rotation is a ledger event, which means it's tamper-evident and audit-visible
- **Not exported by default** — `dump()` includes it behind an opt-in flag; consumers restoring on a new device usually want a fresh OAuth grant, not to inherit the exporter's token

### Record shape

```ts
interface SyncCredentialRecord {
  provider: 'drive' | 'dropbox' | 'icloud' | 's3' | string
  version: 1

  // OAuth 2.0 tokens
  refreshToken: string
  accessToken?: string         // optional — may be kept in memory only
  accessTokenExpiresAt?: string // ISO8601
  scope: string                // granted scopes, for auditing
  tokenType: 'Bearer' | string

  // Provider-specific metadata
  providerAccountId?: string   // Drive user ID, for sanity checks
  providerAccountEmail?: string // Displayed in UI, helps user detect confused-deputy

  // Audit trail
  grantedAt: string            // ISO8601
  grantedBy: string            // noy-db user ID who ran the OAuth flow
  lastRefreshedAt?: string
  lastUsedAt?: string
}
```

The `providerAccountEmail` field matters for UX: a user who has two Google accounts on the same machine needs to know **which** Google account the compartment is synced to. Showing the email at sync time prevents the "I connected the wrong account" category of confusion.

### API surface

```ts
// Stored internally, accessed via a helper API on the session:
await session.setSyncCredential('drive', {
  refreshToken: '1//...',
  scope: 'https://www.googleapis.com/auth/drive.file',
  tokenType: 'Bearer',
  grantedBy: session.userId,
  grantedAt: new Date().toISOString(),
  providerAccountEmail: 'vlanna@example.com',
})

const cred = await session.getSyncCredential('drive')
// → decrypted record, or null if none

await session.deleteSyncCredential('drive')
// → revokes locally; adapter should also call the provider's revoke endpoint
```

Adapters consume this via the session API, not directly. `@noy-db/drive` at startup:

```ts
const cred = await session.getSyncCredential('drive')
if (!cred) throw new DriveAuthRequiredError()
const accessToken = await refreshIfExpired(cred)
```

### Not exported by default

`compartment.dump()` currently includes every underscore-prefixed collection except `_sync` (dirty tracking is session-local). `_sync_credentials` joins the exclusion list by default:

```ts
await compartment.dump()                          // excludes _sync_credentials
await compartment.dump({ includeSyncCreds: true }) // opt-in
```

Rationale: a `.noydb` bundle exported for USB transport or archival should not automatically carry long-lived OAuth tokens. If the bundle leaks, the tokens leak with it. Exporting credentials is a legitimate operation for "migrate sync setup to a new device," but it must be explicit.

## Acceptance criteria

- [ ] `_sync_credentials` is filtered out of `loadAll()` and `listCompartments()` by all existing adapters (memory, file, s3, dynamo, browser). Covered by tests.
- [ ] Records in the collection are encrypted with the compartment DEK, verified by test that reads raw adapter bytes and confirms no plaintext token appears.
- [ ] `session.getSyncCredential()` throws `SessionExpiredError` on destroyed sessions — no silent return of stale data.
- [ ] `session.setSyncCredential()` writes a ledger entry so token rotation is tamper-evident.
- [ ] `dump()` excludes `_sync_credentials` by default; test verifies the exported JSON has no refresh token substrings.
- [ ] `dump({ includeSyncCreds: true })` includes the collection; test verifies round-trip.
- [ ] Deleting a credential locally does not silently assume the provider was also notified — the method returns a `{ revokedLocally: true, revokedRemotely: false }` result and it's the adapter's job to call the provider's revoke endpoint and update the flag.

## Security notes

- **The refresh token inherits the same trust boundary as invoice records.** If an attacker has the passphrase, they have the tokens. If they don't, they don't — even with full disk access.
- **A locked compartment cannot sync in the background.** This is a feature: a stolen locked device cannot silently exfiltrate data, because the refresh token is unreadable until the user unlocks with the passphrase.
- **Token rotation is a ledger event.** Admins reviewing the audit log can see when OAuth was re-authorized, by whom, and to which scopes.
- **The provider account email is stored in plaintext inside the encrypted record** (not in a separate header). Even metadata doesn't leak outside the envelope.

## Out of scope

- Multi-provider token bundling (one record per provider is the shape — no generic "secrets store").
- Token rotation automation beyond the access-token refresh that adapters already do.
- Revoking tokens at the provider from a logged-out state — the provider's revoke endpoint usually requires the token itself, so revoke-on-unlock is the only reasonable path.
- Cross-compartment credential sharing. Each compartment has its own `_sync_credentials`; consumers with multiple compartments re-authorize each.

## Dependencies

Blocked by: session tokens issue (sibling). `session.getSyncCredential()` only makes sense once sessions exist.

Unblocks: `@noy-db/drive` (currently on v0.11.0 milestone, depends on this to land cleanly).
