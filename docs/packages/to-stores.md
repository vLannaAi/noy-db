# `@noy-db/to-*` — Storage destinations

> **Where your ciphertext lives.** Every `to-*` package implements the same
> 6-method `NoydbStore` contract and only ever sees encrypted envelopes —
> never plaintext. Pick one (or several, via `routeStore`) per vault.

The `to-` prefix reads as *"data goes **to** a backend."* Swap a store and
nothing else in your app changes — the `Collection<T>` API, queries, change
events, multi-user keyrings all work identically over every backend.

---

## Essentials (ship in this repo)

The stores 80% of apps start with, plus the tooling pair. For the in-memory case the kernel ships a **built-in default store** — `createNoydb()` needs no `store` — so `@noy-db/to-memory` below is the *fuller* in-memory backend, not a prerequisite to start.

| Package | When to use |
|---|---|
| [`@noy-db/to-memory`](../../packages/to-memory) | **Fuller in-memory store** (the kernel's built-in default already covers basic in-memory). Tests, REPL, ephemeral caches; adds `listVaults` / `tx` / `listPage` over the 6-method built-in. `casAtomic: true`, `txAtomic: true` — a great sanity backstop. |
| [`@noy-db/to-file`](../../packages/to-file) | Local disk / USB stick. JSON file per record. Also ships `saveBundle` / `loadBundle` and `exportBlobsToDirectory` (target-profile filename sanitization + Zip-Slip path containment). |
| [`@noy-db/to-browser-idb`](../../packages/to-browser-idb) | IndexedDB in browsers / PWAs. Atomic CAS via single `readwrite` transaction. |
| [`@noy-db/to-probe`](../../packages/to-probe) | **Diagnostic companion.** Not a backend — runs synthetic benchmarks against any store you pass in and reports on its suitability for a given role (primary, sync-peer, backup, archive). |
| [`@noy-db/to-meter`](../../packages/to-meter) | **Pass-through metrics wrapper.** Wraps any other store and records op latency, error rate, byte counts — without changing the store's behaviour. Point your existing dashboards at it. |

---

## Extended stores — now in noy-db-to

Cloud object stores, SQL databases, remote filesystems, personal drives, and
Cloudflare adapters live in the companion repo
**[noy-db-to](https://github.com/vLannaAi/noy-db-to)** under the **same
`@noy-db` npm names** — install them exactly as before:

```bash
pnpm add @noy-db/to-aws-dynamo   # DynamoDB single-table
pnpm add @noy-db/to-aws-s3       # S3 / R2 object store
pnpm add @noy-db/to-postgres     # node-postgres
# …and so on
```

| Package | Description |
|---|---|
| `@noy-db/to-browser-local` | `localStorage` — small vaults, synchronous read path |
| `@noy-db/to-aws-dynamo` | DynamoDB single-table. Atomic CAS via `ConditionExpression`. |
| `@noy-db/to-aws-s3` | S3. `casAtomic: false` — pair with DynamoDB for CAS-safe primary + S3 blobs via `routeStore`. Also ships `s3Bundle()` for whole-vault snapshot storage. |
| `@noy-db/to-cloudflare-r2` | Zero egress fees. S3-compatible, backed by `@noy-db/to-aws-s3`. |
| `@noy-db/to-cloudflare-d1` | Edge SQLite inside Cloudflare Workers via the `D1Database` binding. |
| `@noy-db/to-postgres` | node-postgres with `jsonb`. |
| `@noy-db/to-mysql` | mysql2 with `JSON`. |
| `@noy-db/to-sqlite` | Single-file SQLite for 10K+ records. |
| `@noy-db/to-supabase` | Supabase Postgres pool. |
| `@noy-db/to-turso` | Hosted libSQL with multi-region replication. |
| `@noy-db/to-ssh` | SFTP over SSH, keys only. Any Linux/macOS server with `sshd` becomes a backend. |
| `@noy-db/to-webdav` | Nextcloud / ownCloud / Apache mod_dav. |
| `@noy-db/to-smb` | SMB/CIFS (NTLM or Kerberos). |
| `@noy-db/to-nfs` | NFS with mount diagnostics. |
| `@noy-db/to-drive` | Google Drive with ULID filenames. Stores each vault as a `.noydb` bundle in Drive's hidden `appDataFolder`. |
| `@noy-db/to-icloud` | macOS-aware iCloud Drive. Detects `.icloud` eviction stubs, triggers `brctl download`. |

→ Source, issues, and changelogs: **[github.com/vLannaAi/noy-db-to](https://github.com/vLannaAi/noy-db-to)**

---

## Picking one

- **"I need a database on this machine."** → `to-file` or `to-sqlite` (10K+, noy-db-to).
- **"I'm in a browser."** → `to-browser-idb` (PWAs) or `to-browser-local` (tiny, noy-db-to).
- **"I have an AWS account."** → `to-aws-dynamo` primary + `to-aws-s3` blobs via `routeStore` (both in noy-db-to).
- **"I have ssh access to a box."** → `to-ssh` (noy-db-to).
- **"I'm in Cloudflare Workers."** → `to-cloudflare-d1` + `to-cloudflare-r2` (both in noy-db-to).
- **"I'm just testing."** → nothing — the built-in in-memory default is enough; reach for `to-memory` only when you need `listVaults` / `tx` / `listPage`.

Don't pick one forever — a vault can sync to multiple `SyncTarget`s with
different stores, roles, and policies. See the
[`sync` subsystem](../subsystems/sync.md) and the
[realtime-crdt-app recipe](../recipes/realtime-crdt-app.md).

[← Back to README](../../README.md)
