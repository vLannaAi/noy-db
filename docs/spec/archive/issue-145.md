# Issue #145 — feat(to-nfs): @noy-db/to-nfs — NFS network file store

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, priority: low, area: adapters

---

## Summary

A dedicated store for NFS (Network File System) shares — Linux/Unix file servers, macOS Xsan, and enterprise NAS. Sibling to `to-smb` (#144); same indexed layout as `to-file` with NFS-specific safety mitigations.

`@noy-db/to-file` on a mounted NFS path works functionally but has several NFS-specific failure modes that are invisible without dedicated handling.

## Why not just `@noy-db/to-file` on a mounted path

| Concern | `to-file` on NFS mount | `to-nfs` |
|---|---|---|
| Attribute caching | `stat()` may return stale `mtime` / size — version checks can pass on stale data | Detects `noac` mount option; warns if attribute caching is active |
| File locking | `nolock` mount option silently disables POSIX locks | Explicitly detects `nolock` and warns or errors |
| Auth | OS-level UID/GID mapping — invisible to noy-db | Documents Kerberos (NFSv4 sec=krb5) requirements explicitly |
| NFSv3 vs NFSv4 | No distinction | Surfaces protocol version; NFSv4 preferred (stateful, better locking) |

## Authentication

```ts
const store = nfs({
  mountPath: '/mnt/fileserver/accounting',  // pre-mounted NFS path
  // No credentials in config — NFS auth is OS-level.
  // For Kerberos (NFSv4 sec=krb5): ensure valid TGT before opening.
})
```

NFS authentication is handled entirely outside noy-db:

- **AUTH_SYS (NFSv3 default):** OS UID/GID. No noy-db config. Access controlled by server exports + client UID mapping.
- **Kerberos (NFSv4 sec=krb5):** `kinit` before opening the store. noy-db detects ticket expiry via `EKEYEXPIRED` errors and surfaces them as `StoreAuthError`.

```ts
auth: {
  kind: 'nfs-unix',
  flow: 'implicit',  // OS handles it — 'kerberos' when sec=krb5
  required: true,
}
```

## Granularity and file layout

Indexed store — same layout as `to-file`:

```
/mnt/fileserver/accounting/{vault}/{collection}/{id}.json
/mnt/fileserver/accounting/{vault}/_keyring/{userId}.json
```

## StoreCapabilities

```ts
{
  casAtomic: false,       // nolock + stale-attribute risk makes CAS unreliable
  auth: { kind: 'nfs-unix', flow: 'implicit' | 'kerberos', required: true },
}
```

## Runtime checks

On `createStore()`:

1. `statvfs()` to verify path is mounted — fail fast otherwise.
2. Parse `/proc/mounts` (Linux) to detect `noac`, `nolock`, protocol version.
3. Warn on `noac` absent; warn or error on `nolock` present.

## Library

Pure Node — uses `fs/promises` against the mounted path. No dedicated NFS client library needed.

## Related

- #103 — `NoydbBundleStore` interface
- #101 — `syncPolicy` scheduling
- #141 — `casAtomic` + `acknowledgeRisks`
- #144 — `@noy-db/to-smb` (sibling network file store)

---
**Naming convention update (2026-04-23):** Renamed from `@noy-db/store-nfs` to `@noy-db/to-nfs`; `@noy-db/store-file` → `@noy-db/to-file`; `NoydbStore` / `StoreCapabilities` naming aligned to v0.11+ spec.
