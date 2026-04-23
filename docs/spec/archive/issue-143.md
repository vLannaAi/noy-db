# Issue #143 — feat(core): StoreCapabilities.auth — authentication kind and flow metadata per store

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.10.0
- **Labels:** type: feature, priority: medium, area: core, area: adapters

---

## Summary

Add an `auth` field to `StoreCapabilities` so developers and tooling (DevTools panel, adapter probe, guidance docs) can inspect what authentication a store requires without reading its source or docs.

## Proposed shape

```ts
interface StoreCapabilities {
  casAtomic: boolean          // #141
  auth: StoreAuth
}

interface StoreAuth {
  /**
   * The authentication mechanism(s) this store uses.
   * Array when multiple are supported (e.g. WebDAV accepts Basic or OAuth).
   */
  kind: AuthKind | AuthKind[]

  /**
   * Whether credentials are required at all.
   * false for memory, local file, browser (OS or browser handles access).
   */
  required: boolean

  /**
   * How credentials are obtained / refreshed.
   *
   * 'static'   — set once at construction time (env vars, config, DSN,
   *               API key). No user interaction after setup.
   * 'oauth'    — redirect flow with token refresh. Requires user interaction
   *               on first use and periodically on token expiry.
   * 'kerberos' — enterprise SSO / domain ticket. Transparent when domain-joined;
   *               explicit keytab otherwise.
   * 'implicit' — OS or runtime handles it transparently (filesystem ACL,
   *               browser same-origin policy). No credentials in NOYDB config.
   */
  flow: 'static' | 'oauth' | 'kerberos' | 'implicit'
}

type AuthKind =
  | 'none'              // memory, local file
  | 'filesystem'        // OS ACL — file, sqlite, SMB/NFS via OS mount
  | 'browser-origin'    // browser same-origin — store-browser
  | 'aws-iam'           // access key / role / instance profile — store-dynamo, store-s3
  | 'cloudflare-token'  // Cloudflare API token — store-d1, store-r2
  | 'google-oauth2'     // Google OAuth 2.0 — store-google-drive
  | 'apple-id'          // Apple ID / iCloud — store-icloud
  | 'smb-ntlm'          // NTLM or Kerberos — store-smb
  | 'nfs-unix'          // Unix UID/GID or Kerberos NFSv4 — store-nfs
  | 'supabase-key'      // anon / service role key — store-supabase
  | 'firebase-sdk'      // Firebase credentials / service account — store-firestore
  | 'turso-token'       // Turso auth token — store-turso
  | 'postgres-dsn'      // connection string (user+password, optional mTLS) — store-postgres
  | 'http-basic'        // username + password over HTTPS — store-webdav
  | 'http-oauth'        // OAuth bearer token — store-webdav (Nextcloud)
  | 'ipfs-api'          // IPFS API key — store-ipfs
  | 'git-credential'    // SSH key / PAT / GitHub token — store-git
```

## Known values for all stores

| Store | `kind` | `flow` | `required` |
|---|---|---|---|
| `store-memory` | `none` | `implicit` | false |
| `store-file` (local) | `filesystem` | `implicit` | false |
| `store-file` (iCloud path) | `apple-id` | `implicit` | true |
| `store-browser` | `browser-origin` | `implicit` | false |
| `store-dynamo` | `aws-iam` | `static` | true |
| `store-s3` | `aws-iam` | `static` | true |
| `store-icloud` | `apple-id` | `implicit` | true |
| `store-smb` | `smb-ntlm` | `static` or `kerberos` | true |
| `store-nfs` | `nfs-unix` | `implicit` or `kerberos` | true |
| `store-google-drive` | `google-oauth2` | `oauth` | true |
| `store-postgres` | `postgres-dsn` | `static` | true |
| `store-supabase` | `supabase-key` | `static` | true |
| `store-firestore` | `firebase-sdk` | `static` | true |
| `store-d1` | `cloudflare-token` | `static` | true |
| `store-r2` | `cloudflare-token` | `static` | true |
| `store-turso` | `turso-token` | `static` | true |
| `store-webdav` | `['http-basic', 'http-oauth']` | `static` or `oauth` | true |
| `store-git` | `git-credential` | `static` | true |
| `store-ipfs` | `ipfs-api` | `static` | false |

## Why this matters

- **Developer guidance** — the adapter probe (#138) and DevTools panel (#140 v0.10) can surface auth requirements before the developer tries to connect
- **OAuth stores** (`flow: 'oauth'`) need special handling: token refresh can add 200–500ms to the first operation after expiry, and the token must be stored in `_sync_credentials` (reserved collection, #110) not in plaintext config
- **Kerberos stores** (`flow: 'kerberos'`) are transparent when domain-joined but require explicit `kinit` / keytab in CI or non-domain environments — a common deployment surprise
- **Implicit stores** (`flow: 'implicit'`) require no NOYDB config but may still fail at runtime if OS permissions are wrong — the probe should distinguish between 'no credentials needed' and 'credentials are handled outside NOYDB'

## Context

- Companion to `casAtomic` (#141) — both are `StoreCapabilities` fields
- Depends on store rename #140 for final type names
- OAuth token storage in `_sync_credentials`: #110
