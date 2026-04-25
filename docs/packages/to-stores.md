# `@noy-db/to-*` — Storage destinations

> **Where your ciphertext lives.** Every `to-*` package implements the same
> 6-method `NoydbStore` contract and only ever sees encrypted envelopes —
> never plaintext. Pick one (or several, via `routeStore`) per vault.

The `to-` prefix reads as *"data goes **to** a backend."* Swap a store and
nothing else in your app changes — the `Collection<T>` API, queries, change
events, multi-user keyrings all work identically over every backend.

---

## The distinctive ones

These are the stores that make people go *"wait, noy-db does that?"* If
you're scanning the list for differentiators, start here.

| Package | What's unusual |
|---|---|
| [`@noy-db/to-meter`](../../packages/to-meter) | **Pass-through metrics wrapper.** Wraps any other store and records op latency, error rate, byte counts — without changing the store's behaviour. Point your existing dashboards at it. |
| [`@noy-db/to-probe`](../../packages/to-probe) | **Diagnostic companion.** Not a backend — runs synthetic benchmarks against any store you pass in and reports on its suitability for a given role (primary, sync-peer, backup, archive). |
| [`@noy-db/to-ssh`](../../packages/to-ssh) | **SFTP over SSH, keys only.** Any Linux/macOS server with `sshd` becomes a backend. Uses your existing `~/.ssh` keys or `SSH_AUTH_SOCK`. No passwords, no new credentials. |
| [`@noy-db/to-drive`](../../packages/to-drive) | **Google Drive with ULID filenames.** Stores each vault as a `.noydb` bundle in Drive's hidden `appDataFolder`. ULIDs so the Drive search index can't leak vault names. |
| [`@noy-db/to-icloud`](../../packages/to-icloud) | **macOS-aware iCloud Drive.** Detects `.icloud` eviction stubs, triggers `brctl download`, raises on iCloud-created conflict files. Bundle store — pair with `wrapBundleStore`. |
| [`@noy-db/to-cloudflare-r2`](../../packages/to-cloudflare-r2) | **Zero egress fees.** S3-compatible, backed by `@noy-db/to-aws-s3`. Ideal for archive tiers that stream the whole vault. |
| [`@noy-db/to-cloudflare-d1`](../../packages/to-cloudflare-d1) | **Edge SQLite.** Runs inside Cloudflare Workers via the `D1Database` binding. Native `D1.batch()` for atomic multi-op transactions. |
| [`@noy-db/to-turso`](../../packages/to-turso) | **Hosted libSQL with multi-region replication.** Native async driver — cleaner fit than a sync shim. |

---

## The essentials

The stores 80% of apps start with.

| Package | When to use |
|---|---|
| [`@noy-db/to-memory`](../../packages/to-memory) | Tests, REPL, ephemeral caches. `casAtomic: true`, `txAtomic: true` — a great sanity backstop. |
| [`@noy-db/to-file`](../../packages/to-file) | Local disk / USB stick. JSON file per record. The simplest persistent backend. |
| [`@noy-db/to-browser-idb`](../../packages/to-browser-idb) | IndexedDB in browsers / PWAs. Atomic CAS via single `readwrite` transaction. |
| [`@noy-db/to-browser-local`](../../packages/to-browser-local) | `localStorage` — small vaults, synchronous read path. |
| [`@noy-db/to-aws-dynamo`](../../packages/to-aws-dynamo) | DynamoDB single-table. Atomic CAS via `ConditionExpression`. |
| [`@noy-db/to-aws-s3`](../../packages/to-aws-s3) | S3. `casAtomic: false` — pair with DynamoDB for CAS-safe primary + S3 blobs via `routeStore`. |

---

## Full catalog (20 packages)

**Local**

- [`to-memory`](../../packages/to-memory) · in-memory, testing
- [`to-file`](../../packages/to-file) · JSON file per record, USB / local disk
- [`to-sqlite`](../../packages/to-sqlite) · single-file SQLite for 10K+ records

**Browser**

- [`to-browser-idb`](../../packages/to-browser-idb) · IndexedDB (atomic CAS)
- [`to-browser-local`](../../packages/to-browser-local) · localStorage

**Cloud — AWS**

- [`to-aws-dynamo`](../../packages/to-aws-dynamo) · DynamoDB single-table
- [`to-aws-s3`](../../packages/to-aws-s3) · S3 object store

**Cloud — Cloudflare**

- [`to-cloudflare-r2`](../../packages/to-cloudflare-r2) · R2 (S3-compatible, zero egress)
- [`to-cloudflare-d1`](../../packages/to-cloudflare-d1) · D1 edge SQLite (Workers binding)

**Cloud — other**

- [`to-supabase`](../../packages/to-supabase) · Supabase Postgres pool
- [`to-turso`](../../packages/to-turso) · libSQL with replication
- [`to-postgres`](../../packages/to-postgres) · node-postgres with `jsonb`
- [`to-mysql`](../../packages/to-mysql) · mysql2 with `JSON`

**Remote filesystems**

- [`to-ssh`](../../packages/to-ssh) · SFTP, public-key auth only
- [`to-webdav`](../../packages/to-webdav) · Nextcloud / ownCloud / Apache mod_dav
- [`to-smb`](../../packages/to-smb) · SMB/CIFS (NTLM or Kerberos)
- [`to-nfs`](../../packages/to-nfs) · NFS with mount diagnostics

**Personal cloud drives**

- [`to-icloud`](../../packages/to-icloud) · iCloud Drive (macOS)
- [`to-drive`](../../packages/to-drive) · Google Drive

**Tooling (not backends)**

- [`to-probe`](../../packages/to-probe) · diagnostic / benchmark companion
- [`to-meter`](../../packages/to-meter) · pass-through metrics wrapper

---

## Picking one

- **"I need a database on this machine."** → `to-file` or `to-sqlite` (10K+).
- **"I'm in a browser."** → `to-browser-idb` (PWAs) or `to-browser-local` (tiny).
- **"I have an AWS account."** → `to-aws-dynamo` primary + `to-aws-s3` blobs via [`routeStore`](../../packages/hub/README.md).
- **"I have ssh access to a box."** → `to-ssh`.
- **"I'm in Cloudflare Workers."** → `to-cloudflare-d1` + `to-cloudflare-r2`.
- **"I'm just testing."** → `to-memory`.

Don't pick one forever — a vault can sync to multiple `SyncTarget`s with
different stores, roles, and policies. See the
[`sync` subsystem](../subsystems/sync.md) and the
[realtime-crdt-app recipe](../recipes/realtime-crdt-app.md).

[← Back to README](../../README.md)
