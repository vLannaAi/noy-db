# Retention + legal-hold: blob retention (#311) + record cold-storage archival (#307)

**Issues:** #311 (blobs), #307 (records) · **Layer:** Store / Document · **Cluster:** C.

Italian fiscal law requires ~10-year retention on invoices/DDTs and their PDFs, with legal-hold (litigation/audit) able to override any eviction. Two halves share one concept — **`legalHold` blocks eviction/archival** — but live in different subsystems.

## Part 1 — #311: blob legal-hold + period-bound retention

Extends the existing blob-compaction subsystem (`vault.compact()`, `BlobFieldPolicy { retainDays, evictWhen }`). Two additions to `BlobFieldPolicy`:

- **`legalHold?: (record) => boolean`** — while true, the slot is never evicted (overrides `retainDays`/`evictWhen`). Fail-closed: a throwing predicate retains the slot.
- **`retainUntil?: (record) => Date | string | number | null`** — a period-bound retention floor (e.g. fiscal period end + 10 years, computed from the record's business date). While `now < retainUntil`, the slot is never evicted.

`CompactionResult` gains `held` — the count of slots that *would* have evicted but were retained by a hold/floor. No new exports (both are fields on the already-exported `BlobFieldPolicy`). The "release" path is the predicate going false (the consumer updates the record); the next `compact()` then evicts. Blob eviction is destructive, so there is no blob-level restore — the existing `_blob_eviction_audit` records what was dropped.

## Part 2 — #307: record cold-storage archival

A new subsystem: `withArchive({ store })` designates a second `NoydbStore` as a cold archive target; a per-collection `archive` policy selects records to relocate there.

### Core principle

**Archival = envelope relocation.** A record is a self-contained encrypted envelope, so archival moves the ciphertext from the primary store to the cold store with **no re-encryption**. The cold store's contents *are* the archived-set index. Relocation uses low-level store ops + the collection's `_internalDelete`, which **bypasses guards** (an issued/immutable record over a sealed period can still be archived) and **never fires materialized-view dispatch** (finalized aggregates don't recompute).

### API

```ts
createNoydb({ store: primary, archiveStrategy: withArchive({ store: coldStore }) })

vault.collection('invoices', {
  archive: {
    archiveWhen: (r) => businessYear(r) <= currentYear - 1,  // period/business-date test
    legalHold?: (r) => r.underHold === true,                  // blocks archival, fail-closed
  },
})

await vault.archive({ maxArchives?, dryRun? })   // → { archived, held, scanned, byCollection }
await vault.restore('invoices', 'inv-2020-001')  // → boolean (relocates back to primary)
await vault.listArchived('invoices')             // → [{ collection, id }, …]
```

### Mechanics

- **`vault.archive()`** — for each collection with a policy, decrypt each record to evaluate `archiveWhen`/`legalHold`. For eligible, un-held records: `adapter.get` the envelope → `archiveStore.put` → `collection._internalDelete` (drops from primary + cache, bypassing guards/MV). `legalHold` (or a throwing predicate, fail-closed) counts as `held`. `dryRun` previews; `maxArchives` caps the batch.
- **`vault.restore(collection, id)`** — `archiveStore.get` → `adapter.put` (primary) → `collection._invalidateCacheEntry` (refresh) → `archiveStore.delete`. Returns false if not archived.
- **`vault.listArchived(collection?)`** — lists the cold store's ids for the collection(s).
- **Read of an archived record** — `get(id)` returns `null` from the primary store (it's cold). The consumer calls `restore` first. Aggregates/MVs over the collection naturally exclude archived records (they're gone from primary) — archival is intended for sealed periods whose totals are finalized.

### Engine isolation

The relocation logic lives in `src/archive/engine.ts` over an injected `ArchiveContext` (stores + per-collection accessors), unit-testable without a live vault. The Vault supplies the context (`adapter`, `collection().get/_internalDelete/_invalidateCacheEntry`, the `archiveRegistry`). The three `vault` methods are thin delegations.

## Boundaries & deferred

- **Archive metadata** (archivedAt / actor on each archived record) — deferred; v1 tracks presence only via the cold store.
- **Auto-archival cadence** (scheduled sweeps) — deferred; archival is consumer-scheduled like `compact()`.
- **Restore of a still-existing primary id** — `restore` overwrites the primary copy with the archived envelope (last-writer); documented.
- **Cross-store transactionality** — archive relocation is per-record (get→put→delete); a crash mid-batch leaves already-moved records consistent (envelope in cold, gone from primary) and the rest untouched. Not a single atomic transaction.

## Testing

- **#311:** legalHold blocks an otherwise-due eviction (+ `held` count); release → next compact evicts; `retainUntil` floor holds then releases; fail-closed on throw. Existing compaction tests unaffected.
- **#307 engine:** relocate eligible / skip ineligible; legalHold held + fail-closed; dryRun; maxArchives; restore round-trip; restore-of-missing → false.
- **#307 integration:** archive removes from primary + lists in cold; restore brings back (decryptable); legalHold blocks; **a guard-locked record is archived anyway** (proves guard bypass); missing `archiveStrategy` throws.

## Build sequence

1. #311 — extend `BlobFieldPolicy` (`legalHold`, `retainUntil`) + `CompactionResult.held` + `isHeld` in compaction.
2. #307 — `src/archive/` engine + `withArchive`; vault `archiveStrategy` + `archiveRegistry` + `archive`/`restore`/`listArchived`; noydb passthrough; exports.
3. Tests, docs, features.yaml.
