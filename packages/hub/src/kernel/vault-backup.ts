/**
 * Vault backup / restore / integrity.
 *
 * Holds `dump()` (verifiable encrypted JSON backup, including the blob
 * collections so blob "covers" travel in the bundle), `load()` (restore +
 * post-load integrity gate), `verifyBackupIntegrity()` (chain + data-envelope
 * cross-check), and `exportJSON()` (plaintext per-collection export, built on
 * the vault's `exportStream`). Behaviour is byte-identical to the inline
 * `Vault` methods these functions replaced — every dependency the moving code
 * touched on `this.*` arrives via {@link BackupContext}. `Vault` keeps the
 * public methods as thin delegators.
 *
 * Internal — reached through `vault.dump()` / `vault.load()` / etc.
 */
import { NOYDB_BACKUP_VERSION } from './types.js'
import { BackupLedgerError, BackupCorruptedError } from './errors.js'
import { LEDGER_COLLECTION, LEDGER_DELTAS_COLLECTION } from '../with-commit/history/ledger/constants.js'
import { SCHEMAS_COLLECTION } from '../with-shape/persisted-schemas/storage.js'
import { SEQUENCE_COLLECTION } from '../with-commit/sequence/index.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultBackup,
  VaultSnapshot,
  ExportStreamOptions,
  ExportChunk,
} from './types.js'
import type { LedgerStore } from '../with-commit/history/ledger/store.js'

/** Everything the moving backup methods touched on the vault's `this.*`. */
export interface BackupContext {
  /** The ciphertext store. */
  readonly adapter: NoydbStore
  /** Vault namespace name. */
  readonly vault: string
  /** The invoking keyring's user id (read fresh per call). */
  userId(): string
  /** The vault's ledger store, or null when history is off. */
  getLedgerOrNull(): LedgerStore | null
  /** Recompute an envelope's `payloadHash` (bound `historyStrategy.envelopePayloadHash`). */
  envelopePayloadHash(envelope: EncryptedEnvelope): Promise<string>
  /**
   * Refresh the in-memory keyring from the freshly-loaded keyring file and
   * rebuild the DEK resolver. No-op when the vault has no `reloadKeyring`
   * callback (plaintext vaults / test constructions).
   */
  reloadKeyringAndRebuildDEK(): Promise<void>
  /** Clear the vault's collection cache (post-load). */
  clearCollectionCache(): void
  /** Reset the ledger store so the next `ledger()` rebuilds its head cache. */
  resetLedgerStore(): void
  /** The vault's decrypt+ACL export stream (used by `exportJSON`). */
  exportStream(opts: ExportStreamOptions): AsyncIterableIterator<ExportChunk>
}

/** Result of {@link verifyBackupIntegrity}. */
export type VerifyBackupResult =
  | { readonly ok: true; readonly head: string; readonly length: number }
  | {
      readonly ok: false
      readonly kind: 'chain'
      readonly divergedAt: number
      readonly message: string
    }
  | {
      readonly ok: false
      readonly kind: 'data'
      readonly collection: string
      readonly id: string
      readonly message: string
    }

/**
 * Dump vault as a verifiable encrypted JSON backup string.
 *
 * backups embed the current ledger head and the full `_ledger` +
 * `_ledger_deltas` internal collections so the receiver can run
 * `verifyBackupIntegrity()` after `load()` and detect any tampering between
 * dump and restore. Backups produced without a ledger skip the integrity check
 * with a warning — both modes round-trip cleanly.
 */
export async function dumpVault(ctx: BackupContext): Promise<string> {
  const snapshot = await ctx.adapter.loadAll(ctx.vault)

  // Load keyrings (separate path because loadAll filters them out
  // along with all other underscore-prefixed internal collections).
  const keyringIds = await ctx.adapter.list(ctx.vault, '_keyring')
  const keyrings: Record<string, unknown> = {}
  for (const keyringId of keyringIds) {
    const envelope = await ctx.adapter.get(ctx.vault, '_keyring', keyringId)
    if (envelope) {
      keyrings[keyringId] = JSON.parse(envelope._data)
    }
  }

  // Load the ledger entries + deltas so the receiver can replay
  // the chain after restore. Without this, `load()` would have an
  // empty ledger and `verifyBackupIntegrity()` would have nothing
  // to compare against.
  //
  // Also enumerate the blob collections so blob content ("covers")
  // travels in the bundle (the blob DEK already travels in `_keyring`).
  // Literals are inlined (not imported from blobs/blob-set.ts) to keep
  // the blob runtime out of this kernel hot path — they mirror
  // BLOB_INDEX/CHUNKS/EVICTION_AUDIT_COLLECTION and SLOTS/VERSIONS_PREFIX.
  // The collect-loop skips empty ids, so this no-ops without blobs.
  const internalSnapshot: VaultSnapshot = {}
  const internalNames = [
    LEDGER_COLLECTION, LEDGER_DELTAS_COLLECTION, SCHEMAS_COLLECTION, SEQUENCE_COLLECTION,
    '_blob_index', '_blob_chunks', '_blob_eviction_audit',
    ...Object.keys(snapshot).flatMap((c) => [`_blob_slots_${c}`, `_blob_versions_${c}`]),
  ]
  for (const internalName of internalNames) {
    const ids = await ctx.adapter.list(ctx.vault, internalName)
    if (ids.length === 0) continue
    const records: Record<string, EncryptedEnvelope> = {}
    for (const id of ids) {
      const envelope = await ctx.adapter.get(ctx.vault, internalName, id)
      if (envelope) records[id] = envelope
    }
    internalSnapshot[internalName] = records
  }

  // Embed the ledger head if there's a chain. An empty ledger
  // (fresh vault) leaves `ledgerHead` undefined, which
  // load() treats the same as a legacy backup (no integrity
  // check, console warning). If history is not opted in,
  // `getLedgerOrNull` returns null and we skip embedding entirely
  // — the backup is still valid, just without the integrity head.
  const ledgerForHead = ctx.getLedgerOrNull()
  const head = ledgerForHead ? await ledgerForHead.head() : null
  const backup: VaultBackup = {
    _noydb_backup: NOYDB_BACKUP_VERSION,
    _compartment: ctx.vault,
    _exported_at: new Date().toISOString(),
    _exported_by: ctx.userId(),
    keyrings: keyrings as VaultBackup['keyrings'],
    collections: snapshot,
    ...(Object.keys(internalSnapshot).length > 0
      ? { _internal: internalSnapshot }
      : {}),
    ...(head
      ? {
          ledgerHead: {
            hash: head.hash,
            index: head.entry.index,
            ts: head.entry.ts,
          },
        }
      : {}),
  }

  return JSON.stringify(backup)
}

/**
 * Restore a vault from a verifiable backup. After loading, runs
 * `verifyBackupIntegrity()` to confirm the hash chain, the embedded head, and
 * every data envelope's payload hash. Legacy backups (no `ledgerHead`) load
 * with a console warning and skip the integrity check.
 */
export async function loadVault(ctx: BackupContext, backupJson: string): Promise<void> {
  const backup = JSON.parse(backupJson) as VaultBackup

  // 1. Restore data collections.
  await ctx.adapter.saveAll(ctx.vault, backup.collections)

  // 2. Restore keyrings.
  for (const [userId, keyringFile] of Object.entries(backup.keyrings)) {
    const envelope = {
      _noydb: 1 as const,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: JSON.stringify(keyringFile),
    }
    await ctx.adapter.put(ctx.vault, '_keyring', userId, envelope)
  }

  // 3. Restore internal collections (`_ledger`, `_ledger_deltas`).
  //    Required so verifyBackupIntegrity has the chain to walk.
  if (backup._internal) {
    for (const [internalName, records] of Object.entries(backup._internal)) {
      for (const [id, envelope] of Object.entries(records)) {
        await ctx.adapter.put(ctx.vault, internalName, id, envelope)
      }
    }
  }

  // 4. Refresh the in-memory keyring from the freshly-loaded
  //    keyring file. Without this, the Vault's getDEK
  //    closure still holds the OLD session's DEKs, and every
  //    decrypt of a loaded ledger entry / data envelope fails
  //    with TamperedError because the DEK doesn't match the
  //    ciphertext that was encrypted with the SOURCE user's DEK.
  //    Skipped for plaintext vaults and for tests that
  //    construct Vault without a reloadKeyring callback.
  await ctx.reloadKeyringAndRebuildDEK()

  // 5. Clear collection cache + reset the ledger store so the
  //    next ledger() call rebuilds its head cache from the
  //    freshly-loaded entries.
  ctx.clearCollectionCache()
  ctx.resetLedgerStore()

  // 5. Run the verification gate. Legacy backups (no ledgerHead)
  //    skip this with a one-line warning so existing consumers can
  //    still read them while migrating.
  if (!backup.ledgerHead) {
    console.warn(
      `[noy-db] Loaded a legacy backup with no ledgerHead — ` +
      `verifiable-backup integrity check skipped. ` +
      `Re-export with a ledger-aware build to get tamper detection.`,
    )
    return
  }

  const result = await verifyBackupIntegrity(ctx)
  if (!result.ok) {
    // Surface the most specific error class we can. The result
    // shape carries enough info for callers to inspect.
    if (result.kind === 'data') {
      throw new BackupCorruptedError(
        result.collection,
        result.id,
        result.message,
      )
    }
    throw new BackupLedgerError(result.message, result.divergedAt)
  }

  // 6. Cross-check: the freshly-verified head must match the
  //    value embedded at dump time. A mismatch means someone
  //    truncated or extended the chain after dump.
  if (result.head !== backup.ledgerHead.hash) {
    throw new BackupLedgerError(
      `Backup ledger head mismatch: embedded "${backup.ledgerHead.hash}" ` +
      `but reconstructed "${result.head}".`,
    )
  }
}

/**
 * End-to-end backup integrity check: `ledger.verify()` (hash chain) plus a data
 * envelope cross-check (every current record's `_data` hash must match the
 * latest `put` entry's `payloadHash`). Returns a discriminated union so callers
 * can distinguish chain vs data failures.
 */
export async function verifyBackupIntegrity(ctx: BackupContext): Promise<VerifyBackupResult> {
  // Step 1: chain verification. Without the history strategy there
  // is no ledger; an unaudited backup verifies trivially as `ok`
  // because there's nothing to diverge from.
  const ledgerForVerify = ctx.getLedgerOrNull()
  if (!ledgerForVerify) {
    return { ok: true, head: '', length: 0 }
  }
  const chainResult = await ledgerForVerify.verify()
  if (!chainResult.ok) {
    return {
      ok: false,
      kind: 'chain',
      divergedAt: chainResult.divergedAt,
      message:
        `Ledger chain diverged at index ${chainResult.divergedAt}: ` +
        `expected prevHash "${chainResult.expected}" but found "${chainResult.actual}".`,
    }
  }

  // Step 2: data envelope cross-check. Walk every entry in the
  // ledger and, for the LATEST `put` per (collection, id), recompute
  // the data envelope's payloadHash and compare. Earlier puts of the
  // same id are skipped because the data collection only holds the
  // current version — historical envelopes live in the deltas
  // collection (which is itself protected by the chain).
  // Reuse the ledger we already resolved in step 1.
  const allEntries = await ledgerForVerify.loadAllEntries()

  // Find the latest non-delete entry per (collection, id). Walk
  // the entries in reverse so we hit the latest first; mark each
  // (collection, id) as seen and skip subsequent entries.
  const seen = new Set<string>()
  const latest = new Map<
    string,
    { collection: string; id: string; expectedHash: string }
  >()
  for (let i = allEntries.length - 1; i >= 0; i--) {
    const entry = allEntries[i]
    if (!entry) continue
    // Amendment entries are multi-record audit entries whose
    // `collection` and `id` are empty strings — building a `"/"`
    // key here would mark that synthetic slot as seen and falsely
    // trip the data check on a record that never existed. Skip
    // them BEFORE the key/seen bookkeeping so they neither
    // tombstone real entries nor enter the latest map.
    if (entry.op === 'amendment' || entry.op === 'lifecycle') continue
    const key = `${entry.collection}/${entry.id}`
    if (seen.has(key)) continue
    seen.add(key)
    // For deletes the data collection should NOT have the record,
    // so we skip — there's nothing to cross-check. Marking the key
    // as seen above ensures any earlier `put` of the same id is
    // also skipped (the record was subsequently deleted).
    if (entry.op === 'delete') continue
    latest.set(key, {
      collection: entry.collection,
      id: entry.id,
      expectedHash: entry.payloadHash,
    })
  }

  for (const { collection, id, expectedHash } of latest.values()) {
    const envelope = await ctx.adapter.get(ctx.vault, collection, id)
    if (!envelope) {
      return {
        ok: false,
        kind: 'data',
        collection,
        id,
        message:
          `Ledger expects data record "${collection}/${id}" to exist, ` +
          `but the adapter has no envelope for it.`,
      }
    }
    const actualHash = await ctx.envelopePayloadHash(envelope)
    if (actualHash !== expectedHash) {
      return {
        ok: false,
        kind: 'data',
        collection,
        id,
        message:
          `Data envelope "${collection}/${id}" has been tampered with: ` +
          `expected payloadHash "${expectedHash}", got "${actualHash}".`,
      }
    }
  }

  return {
    ok: true,
    head: chainResult.head,
    length: chainResult.length,
  }
}

/**
 * Plaintext per-collection export, built on the vault's `exportStream`. Forces
 * collection granularity (record-by-record output makes no sense in a single
 * string) and merges dictionary snapshots across collections.
 */
export async function exportVaultJSON(ctx: BackupContext, opts: ExportStreamOptions = {}): Promise<string> {
  // Force per-collection granularity regardless of caller setting:
  // record-by-record output doesn't make sense in a single string.
  const collections: Record<
    string,
    {
      schema: null
      refs: Record<string, { target: string; mode: 'strict' | 'warn' | 'cascade' }>
      records: unknown[]
    }
  > = {}
  let ledgerHead: ExportChunk['ledgerHead'] | undefined
  // Merged dictionary snapshot across all collections.
  // Only populated when `resolveLabels` is not set.
  const allDictionaries: Record<
    string, // collection name
    Record<string, Record<string, Record<string, string>>>
  > = {}

  for await (const chunk of ctx.exportStream({
    granularity: 'collection',
    withLedgerHead: opts.withLedgerHead === true,
    // Thread the export locale so records are read at the
    // `export` layer (i18nText collapsed + dictKey/staticDict labels resolved).
    ...(opts.resolveLabels !== undefined ? { resolveLabels: opts.resolveLabels } : {}),
  })) {
    collections[chunk.collection] = {
      schema: null, // Standard Schema validators are not JSON-serializable
      refs: chunk.refs,
      records: chunk.records,
    }
    if (chunk.ledgerHead) ledgerHead = chunk.ledgerHead
    // Collect dictionary snapshots unless resolveLabels is set
    if (!opts.resolveLabels && chunk.dictionaries) {
      allDictionaries[chunk.collection] = chunk.dictionaries
    }
  }

  const hasDictionaries = Object.keys(allDictionaries).length > 0
  return JSON.stringify({
    _noydb_export: 1,
    _compartment: ctx.vault,
    _exported_at: new Date().toISOString(),
    _exported_by: ctx.userId(),
    collections,
    ...(hasDictionaries ? { _dictionaries: allDictionaries } : {}),
    ...(ledgerHead ? { ledgerHead } : {}),
  })
}
