# Issue #142 — feat(to-icloud): @noy-db/to-icloud — iCloud Drive bundle store

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, priority: low, area: adapters

---

## Summary

A bundle store for iCloud Drive. Enables noy-db deployments where iCloud is the only available cloud storage — common in China (no Google, limited AWS) and in Apple-ecosystem personal workflows.

No new package is strictly required for basic use: `@noy-db/to-file` already works against any iCloud Drive path (`~/Library/Mobile Documents/…`). This package adds iCloud-aware handling on top.

## Why a dedicated package

`@noy-db/to-file` on an iCloud Drive path works, but silently misbehaves in three iCloud-specific ways:

1. **On-demand eviction.** iCloud may evict a file to cloud-only storage, leaving a `.icloud` stub. A plain `readFile()` on the stub throws `ENOENT` or returns stub metadata instead of the bundle. The store needs to call `xattr -d com.apple.icloud.itemName` (macOS) or the equivalent CloudKit API to trigger a download before reading.
2. **Conflict files.** If two devices write simultaneously, iCloud creates a `filename (device's conflicted copy YYYY-MM-DD).ext` file alongside the original. The store must detect and resolve these rather than ignoring them.
3. **Sync-not-yet-complete writes.** A `writeFile()` returning does not mean the file has been uploaded. The store should surface iCloud's sync status (`NSMetadataUbiquitousItemIsUploadedKey`) via an optional `ping()` implementation.

## Scope

- **macOS / Node.js path:** `@noy-db/to-file` + iCloud-aware wrapper handling eviction, conflict file detection, and upload-status check
- **Browser / iOS (CloudKit JS):** out of scope for this issue — tracked separately as `@noy-db/to-cloudkit`
- **Granularity:** bundle store (whole vault as one `.noydb` file), built on the `NoydbBundleStore` interface from #103
- **`casAtomic`: `false`** — iCloud has no per-record CAS; concurrent writes from multiple devices rely on iCloud's own conflict resolution, which replaces rather than merges. Developers using this store in a multi-device write scenario must pass `acknowledgeRisks: ['no-atomic-cas']` (see #141).

## Recommended role

| Role | Verdict |
|---|---|
| Primary (single user, small collections) | ✅ viable |
| Primary (multi-user) | ❌ — `casAtomic: false`, use `acknowledgeRisks` + presence layer |
| Sync / backup | ✅ recommended use case |

## Sync scheduling

Inherits bundle store defaults from #101: debounced push (30s / 2min floor), interval pull (60s ETag probe). The ETag probe maps to checking `NSMetadataUbiquitousItemContentVersionIdentifierKey` on macOS or the file's `modifiedAt` timestamp.

## Related

- #103 — `NoydbBundleStore` interface (prerequisite)
- #104 — `@noy-db/to-drive` (sibling bundle store)
- #101 — `syncPolicy` scheduling (prerequisite)
- #140 — store rename (naming convention this issue already follows)
- #141 — `casAtomic` + `acknowledgeRisks` (this store ships with `casAtomic: false`)

---
**Naming convention update (2026-04-23):** Renamed from `@noy-db/store-icloud` to `@noy-db/to-icloud`; `@noy-db/store-file` → `@noy-db/to-file`; `NoydbBundleAdapter` → `NoydbBundleStore`; `compartment` → `vault`.
