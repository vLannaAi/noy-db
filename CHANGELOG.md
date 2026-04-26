# Changelog

Workspace-level summary. Per-package CHANGELOGs in `packages/<name>/CHANGELOG.md` are the source of truth for release notes.

## Unreleased — Pilot-3 fast-lane batch (2026-04-26)

Five issues landed pre-v0.26 to unblock pilot-3 adoption and harden the ledger under multi-writer contention. All shipped to `main`; no version bump yet.

### `@noy-db/hub` — multi-writer ledger hardening (#296)

`LedgerStore.append()` now uses an optimistic-CAS retry loop on the chain head. Each attempt reads fresh head, claims the next index by writing the entry envelope with `expectedVersion: 0` ("slot must not exist"), and on `ConflictError` invalidates the cache and retries with bounded exponential backoff + jitter. Up to 8 retries; throws `LedgerContentionError` on exhaustion.

Two browser tabs, a web app + offline mobile peer, or a server worker pool all producing ledger entries against the same vault now produce a contiguous, well-ordered chain on `casAtomic: true` stores (memory, idb, dynamo, postgres, d1). Stores with `casAtomic: false` (file, s3, r2 by default) silently accept the CAS argument and remain best-effort under contention — pair them with an advisory lock or single-writer discipline.

Subtle ordering fix: delta envelopes are now persisted **after** the entry-put succeeds. Previously they were written first, which under retry would orphan delta records at indices the writer never claimed. The `deltaHash` is computed off the encrypted envelope's `_data` field in memory — no adapter round-trip needed for the hash.

Pre-existing concurrency hazard fixed alongside: `ensureCollectionDEK` now dedupes in-flight DEK creates per collection. Without that, two concurrent first-time writes to a fresh collection both generated separate DEKs, the second `set` overwrote the first, and any envelope encrypted with the discarded DEK then failed to decrypt (`TamperedError` on read). Exposed by the multi-writer ledger work but applied across all DEK paths.

New error: `LedgerContentionError` (code `LEDGER_CONTENTION`).

### `@noy-db/in-pinia` — auto-updating reactive queries (#281)

### `@noy-db/in-pinia` — auto-updating reactive queries (#281)

`store.liveQuery(fn)` on `defineNoydbStore`. Wraps hub's `Query.live()` into a `ShallowRef<readonly T[]>` + `Ref<Error|null>` pair with `onScopeDispose` auto-teardown. Removes the manual `refresh()` boilerplate adopters were hitting on every cross-collection write — joined-right-side mutations propagate without wiring listeners by hand.

```ts
const outstanding = invoices.liveQuery(q =>
  q.where('status', '==', 'sent').join('clientId').orderBy('dueDate'),
)
// outstanding.items.value re-runs on left OR right-side writes
```

### `@noy-db/hub` + `@noy-db/in-vue` — encrypted-blob ObjectURLs (#284)

- Hub: `BlobSet.objectURL(slot, { mimeType? })` decrypts a slot, builds a `Blob` with the slot's stored `mimeType` (overridable), returns `{ url, revoke }`. Caller owns `revoke()`.
- in-vue: `useBlobURL(collection, idGetter, opts?)` mirrors that into a `Ref<string | null>`. Revokes the prior URL **before** building the next on reactive id change, auto-revokes on scope dispose, stays `null` when `URL.createObjectURL` is unavailable (SSR-safe). Token-guarded against stale resolutions on rapid id changes.

### `@noy-db/hub/util` + `@noy-db/to-file` — filename sanitizer + FS materializer (#292)

- New subpath: `@noy-db/hub/util` exporting `sanitizeFilename(name, opts)` covering 7 target profiles (`posix`, `windows`, `macos-smb`, `zip`, `url-path`, `s3-key`, `opaque`). Always-on transforms: NFC normalize, bidi-override strip, NUL reject (no silent strip — that enables truncation bypass), trim leading/trailing whitespace + control chars. Per-profile reserved-char + reserved-name + length-cap rules with UTF-8-boundary-safe truncation.
- New errors: `FilenameSanitizationError`, `PathEscapeError`.
- `@noy-db/to-file`: `exportBlobsToDirectory(vault, targetDir, opts)` materializes `vault.exportBlobs()` into a real FS directory with profile-aware sanitization, Zip-Slip path containment, and collision policy (`'suffix' | 'overwrite' | 'fail' | callback`). The `'opaque'` profile renames to `${blobId}.${ext}` and writes a sidecar `manifest.json` mapping opaque names back to originals.
- `ExportedBlob.meta.filename` now carries `slot.filename` so the sanitizer has the user-visible name to operate on.

### `@noy-db/hub` — scoped tier elevation (#283)

`vault.elevate(tier, { ttlMs, reason })` returns an `ElevatedHandle` whose `collection(name).put` lands at the elevated tier. Reads on the original vault stay at the inherent tier; only the returned handle is privileged.

```ts
const elevated = await vault.elevate(2, { ttlMs: 15 * 60_000, reason: 'plaintext export' })
await elevated.collection<Doc>('docs').put('d1', record)
await elevated.release()       // or auto-revert on TTL expiry
```

- One `_elevation_audit` envelope per elevation. Each write fires a `CrossTierAccessEvent` stamped with `authorization: 'elevation'`, `reason`, and `elevatedFrom`.
- Per-collection capability gates (`canExportPlaintext`, etc.) are NOT bypassed.
- TTL is checked lazily — no setTimeout to leak. Lazy expiry auto-frees the active-elevation slot so a forgotten `release()` can't deadlock subsequent calls.
- New errors: `ElevationExpiredError`, `AlreadyElevatedError`. `NoKeyForTierError` from the spec is covered by the existing `TierNotGrantedError` (`code: TIER_NOT_GRANTED`).

`CrossTierAccessEvent` gained two optional fields (`reason`, `elevatedFrom`) — additive, existing call sites unchanged.

## Unreleased — v0.25.0-rc.1 (target)

### `@noy-db/hub` — the 17-subsystem catalog

Major restructuring of the public surface. The hub now ships a **minimalist core (~6,500 LOC)** plus **17 opt-in subsystems** behind `with*()` strategy seams. Apps that don't import a subsystem ship none of its code.

The catalog ([SUBSYSTEMS.md](./SUBSYSTEMS.md)) is the product surface — every entry is both a developer-facing feature and a tree-shake-able module:

- **Read & Query** — indexing · joins · aggregate · live
- **Write & Mutate** — history · transactions · crdt
- **Data Shape** — blobs · i18n
- **Time & Audit** — periods · consent
- **Snapshot & Portability** — shadow · bundle
- **Collaboration & Auth** — sync · team · session
- **Operations** — routing

Four subsystems were extracted in this cycle (history, i18n, session, sync); the other 13 ship from prior cycles. See `packages/hub/CHANGELOG.md` for the full migration guide.

### Bundle correctness fix

`tsup.config.ts` now emits ESM with code splitting enabled, fixing a cross-subpath `instanceof` bug introduced when subpaths were first added (#288). CJS retains the v0.24 single-bundle shape.

### Documentation

- 4 starter recipes under [docs/recipes/](./docs/recipes/) with runnable verification
- 17 subsystem one-pagers under [docs/subsystems/](./docs/subsystems/)
- [SUBSYSTEMS.md](./SUBSYSTEMS.md) catalog with cluster groupings, dependency graph, and CI invariants

### Deferred to v0.26

- LTS API lock (api-extractor, JSDoc tagging, error-code inventory, api-stability.md) — #289
- Joins / live / routing extraction (still always-core; planned for v0.26)
- Bundle-size CI gate (#286) — landing in v0.25.x

### Known issues

- #290 — `DictionaryHandle` empty `payloadHash` weakens `verifyBackupIntegrity()` for vaults using both history + i18n. Patch in v0.25.x.

## Prior releases

- **v0.24** — strategy seams batch 1: aggregate, blobs, consent, crdt, indexing, periods, shadow, tx
- **v0.23** — lazy-mode indexes (#265–#268)
- **v0.20** — p2p sync
- **v0.19** — deterministic encryption
- **v0.18** — hierarchical permission tiers
- **v0.17** — accounting periods
- **v0.16** — time-machine, shadow vaults, consent, bulk ops
- ...

For full history, see per-package CHANGELOGs:

- [packages/hub/CHANGELOG.md](./packages/hub/CHANGELOG.md)
- [packages/to-*/CHANGELOG.md](./packages/) (20 store packages)
- [packages/in-*/CHANGELOG.md](./packages/) (10 integration packages)
- [packages/on-*/CHANGELOG.md](./packages/) (9 auth/unlock packages)
- [packages/as-*/CHANGELOG.md](./packages/) (9 export-format packages)
