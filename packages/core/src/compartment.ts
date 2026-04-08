import type {
  NoydbAdapter,
  EncryptedEnvelope,
  CompartmentBackup,
  CompartmentSnapshot,
  HistoryConfig,
  ExportStreamOptions,
  ExportChunk,
} from './types.js'
import { NOYDB_BACKUP_VERSION } from './types.js'
import { Collection } from './collection.js'
import type { CacheOptions } from './collection.js'
import type { IndexDef } from './query/indexes.js'
import type { JoinableSource } from './query/index.js'
import type { OnDirtyCallback } from './collection.js'
import type { UnlockedKeyring } from './keyring.js'
import { ensureCollectionDEK, hasAccess } from './keyring.js'
import type { NoydbEventEmitter } from './events.js'
import { BackupLedgerError, BackupCorruptedError } from './errors.js'
import type { StandardSchemaV1 } from './schema.js'
import { LedgerStore, sha256Hex, LEDGER_COLLECTION, LEDGER_DELTAS_COLLECTION } from './ledger/index.js'
import {
  RefRegistry,
  RefIntegrityError,
  type RefDescriptor,
  type RefViolation,
} from './refs.js'

/** A compartment (tenant namespace) containing collections. */
export class Compartment {
  private readonly adapter: NoydbAdapter
  private readonly name: string
  /**
   * The active in-memory keyring. NOT readonly because `load()`
   * needs to refresh it after restoring a different keyring file —
   * otherwise the in-memory DEKs (from the pre-load session) and
   * the on-disk wrapped DEKs (from the loaded backup) drift apart
   * and every subsequent decrypt fails with TamperedError.
   */
  private keyring: UnlockedKeyring
  private readonly encrypted: boolean
  private readonly emitter: NoydbEventEmitter
  private readonly onDirty: OnDirtyCallback | undefined
  private readonly historyConfig: HistoryConfig
  private getDEK: (collectionName: string) => Promise<CryptoKey>

  /**
   * Optional callback that re-derives an UnlockedKeyring from the
   * adapter using the active user's passphrase. Called by `load()`
   * after the on-disk keyring file has been replaced — refreshes
   * `this.keyring` so the next DEK access uses the loaded wrapped
   * DEKs instead of the stale pre-load ones.
   *
   * Provided by Noydb at openCompartment() time. Tests that
   * construct Compartment directly can pass `undefined`; load()
   * skips the refresh in that case (which is fine for plaintext
   * compartments — there's nothing to re-unwrap).
   */
  private readonly reloadKeyring: (() => Promise<UnlockedKeyring>) | undefined
  private readonly collectionCache = new Map<string, Collection<unknown>>()

  /**
   * Per-compartment ledger store. Lazy-initialized on first
   * `collection()` call (which passes it through to the Collection)
   * or on first `ledger()` call from user code.
   *
   * One LedgerStore is shared across all collections in a compartment
   * because the hash chain is compartment-scoped: the chain head is a
   * single "what did this compartment do last" identifier, not a
   * per-collection one. Two collections appending concurrently is the
   * single-writer concurrency concern documented in the LedgerStore
   * docstring.
   */
  private ledgerStore: LedgerStore | null = null

  /**
   * Per-compartment foreign-key reference registry. Collections
   * register their `refs` option here on construction; the
   * compartment uses the registry on every put/delete/checkIntegrity
   * call. One instance lives for the compartment's lifetime.
   */
  private readonly refRegistry = new RefRegistry()

  /**
   * Set of collection record-ids currently being deleted as part of
   * a cascade. Populated on entry to `enforceRefsOnDelete` and
   * drained on exit. Used to break mutual-cascade cycles: deleting
   * A → cascade to B → cascade back to A would otherwise recurse
   * forever, so we short-circuit when we see an already-in-progress
   * delete on the same (collection, id) pair.
   */
  private readonly cascadeInProgress = new Set<string>()

  constructor(opts: {
    adapter: NoydbAdapter
    name: string
    keyring: UnlockedKeyring
    encrypted: boolean
    emitter: NoydbEventEmitter
    onDirty?: OnDirtyCallback | undefined
    historyConfig?: HistoryConfig | undefined
    reloadKeyring?: (() => Promise<UnlockedKeyring>) | undefined
  }) {
    this.adapter = opts.adapter
    this.name = opts.name
    this.keyring = opts.keyring
    this.encrypted = opts.encrypted
    this.emitter = opts.emitter
    this.onDirty = opts.onDirty
    this.historyConfig = opts.historyConfig ?? { enabled: true }
    this.reloadKeyring = opts.reloadKeyring

    // Build the lazy DEK resolver. Pulled out into a private method
    // so `load()` can rebuild it after a keyring refresh — the
    // closure captures `this.keyring` by reference, so changing the
    // field is enough, but resetting the cached `getDEKFn` ensures
    // ensureCollectionDEK runs again against the freshly-loaded
    // wrapped DEKs.
    this.getDEK = this.makeGetDEK()
  }

  /**
   * Construct (or reconstruct) the lazy DEK resolver. Captures the
   * CURRENT value of `this.keyring` and `this.adapter` in a closure,
   * memoizing the inner getDEKFn after first use so subsequent
   * lookups are O(1).
   *
   * `load()` calls this after refreshing `this.keyring` to discard
   * the prior session's cached DEKs.
   */
  private makeGetDEK(): (collectionName: string) => Promise<CryptoKey> {
    let getDEKFn: ((collectionName: string) => Promise<CryptoKey>) | null = null
    return async (collectionName: string): Promise<CryptoKey> => {
      if (!getDEKFn) {
        getDEKFn = await ensureCollectionDEK(this.adapter, this.name, this.keyring)
      }
      return getDEKFn(collectionName)
    }
  }

  /**
   * Open a typed collection within this compartment.
   *
   * - `options.indexes` declares secondary indexes for the query DSL.
   *   Indexes are computed in memory after decryption; adapters never
   *   see plaintext index data.
   * - `options.prefetch` (default `true`) controls hydration. Eager mode
   *   loads everything on first access; lazy mode (`prefetch: false`)
   *   loads records on demand and bounds memory via the LRU cache.
   * - `options.cache` configures the LRU bounds. Required in lazy mode.
   *   Accepts `{ maxRecords, maxBytes: '50MB' | 1024 }`.
   * - `options.schema` attaches a Standard Schema v1 validator (Zod,
   *   Valibot, ArkType, Effect Schema, etc.). Every `put()` is validated
   *   before encryption; every read is validated after decryption.
   *   Failing records throw `SchemaValidationError`.
   *
   * Lazy mode + indexes is rejected at construction time — see the
   * Collection constructor for the rationale.
   */
  collection<T>(collectionName: string, options?: {
    indexes?: IndexDef[]
    prefetch?: boolean
    cache?: CacheOptions
    schema?: StandardSchemaV1<unknown, T>
    refs?: Record<string, RefDescriptor>
  }): Collection<T> {
    let coll = this.collectionCache.get(collectionName)
    if (!coll) {
      // Register ref declarations (if any) with the compartment-level
      // registry BEFORE constructing the Collection. This way the
      // first put() on the new collection already sees its refs via
      // compartment.enforceRefsOnPut.
      if (options?.refs) {
        this.refRegistry.register(collectionName, options.refs)
      }
      const collOpts: ConstructorParameters<typeof Collection<T>>[0] = {
        adapter: this.adapter,
        compartment: this.name,
        name: collectionName,
        keyring: this.keyring,
        encrypted: this.encrypted,
        emitter: this.emitter,
        getDEK: this.getDEK,
        onDirty: this.onDirty,
        historyConfig: this.historyConfig,
        ledger: this.ledger(),
        refEnforcer: this,
        joinResolver: this,
      }
      if (options?.indexes !== undefined) collOpts.indexes = options.indexes
      if (options?.prefetch !== undefined) collOpts.prefetch = options.prefetch
      if (options?.cache !== undefined) collOpts.cache = options.cache
      if (options?.schema !== undefined) collOpts.schema = options.schema
      coll = new Collection<T>(collOpts)
      this.collectionCache.set(collectionName, coll)
    }
    return coll as Collection<T>
  }

  /**
   * Enforce strict outbound refs on a `put()`. Called by Collection
   * just before it writes to the adapter. For every strict ref
   * declared on the collection, check that the target id exists in
   * the target collection; throw `RefIntegrityError` if not.
   *
   * `warn` and `cascade` modes don't affect put semantics — they're
   * enforced at delete time or via `checkIntegrity()`.
   */
  async enforceRefsOnPut(collectionName: string, record: unknown): Promise<void> {
    const outbound = this.refRegistry.getOutbound(collectionName)
    if (Object.keys(outbound).length === 0) return
    if (!record || typeof record !== 'object') return
    const obj = record as Record<string, unknown>

    for (const [field, descriptor] of Object.entries(outbound)) {
      if (descriptor.mode !== 'strict') continue
      const rawId = obj[field]
      // Nullish ref values are allowed — treat them as "no reference".
      // Users who want "always required" should express it in their
      // Standard Schema validator via a non-optional field.
      if (rawId === null || rawId === undefined) continue
      // Refs must be strings or numbers — anything else (object,
      // array, boolean) is a programming error and should fail
      // loudly rather than serialize as "[object Object]".
      if (typeof rawId !== 'string' && typeof rawId !== 'number') {
        throw new RefIntegrityError({
          collection: collectionName,
          id: (obj['id'] as string | undefined) ?? '<unknown>',
          field,
          refTo: descriptor.target,
          refId: null,
          message:
            `Ref field "${collectionName}.${field}" must be a string or number, got ${typeof rawId}.`,
        })
      }
      const refId = String(rawId)
      const target = this.collection<Record<string, unknown>>(descriptor.target)
      const exists = await target.get(refId)
      if (!exists) {
        throw new RefIntegrityError({
          collection: collectionName,
          id: (obj['id'] as string | undefined) ?? '<unknown>',
          field,
          refTo: descriptor.target,
          refId,
          message:
            `Strict ref "${collectionName}.${field}" → "${descriptor.target}" ` +
            `cannot be satisfied: target id "${refId}" not found in "${descriptor.target}".`,
        })
      }
    }
  }

  /**
   * Enforce inbound ref modes on a `delete()`. Called by Collection
   * just before it deletes from the adapter. Walks every inbound
   * ref that targets this (collection, id) and:
   *
   *   - `strict`: throws if any referencing records exist
   *   - `cascade`: deletes every referencing record
   *   - `warn`:    no-op (checkIntegrity picks it up)
   *
   * Cascade cycles are broken via `cascadeInProgress` — re-entering
   * for the same (collection, id) returns immediately so two
   * mutually-cascading collections don't recurse forever.
   */
  async enforceRefsOnDelete(collectionName: string, id: string): Promise<void> {
    const key = `${collectionName}/${id}`
    if (this.cascadeInProgress.has(key)) return
    this.cascadeInProgress.add(key)

    try {
      const inbound = this.refRegistry.getInbound(collectionName)
      for (const rule of inbound) {
        const fromCollection = this.collection<Record<string, unknown>>(rule.collection)
        // Scan the referencing collection for records whose ref
        // field matches this id. For eager-mode collections this
        // is an in-memory filter; for lazy-mode it requires a scan.
        const allRecords = await fromCollection.list()
        const matches = allRecords.filter((rec) => {
          const raw = rec[rule.field]
          // Same string/number-only restriction as enforceRefsOnPut.
          // Anything else can't have been a valid ref to begin with,
          // so it can't match.
          if (typeof raw !== 'string' && typeof raw !== 'number') return false
          return String(raw) === id
        })
        if (matches.length === 0) continue

        if (rule.mode === 'strict') {
          const first = matches[0]
          throw new RefIntegrityError({
            collection: rule.collection,
            id: (first?.['id'] as string | undefined) ?? '<unknown>',
            field: rule.field,
            refTo: collectionName,
            refId: id,
            message:
              `Cannot delete "${collectionName}"/"${id}": ` +
              `${matches.length} record(s) in "${rule.collection}" still reference it via strict ref "${rule.field}".`,
          })
        }
        if (rule.mode === 'cascade') {
          for (const match of matches) {
            const matchId = (match['id'] as string | undefined) ?? null
            if (matchId === null) continue
            // Recursive delete — the cycle breaker above catches
            // infinite loops.
            await fromCollection.delete(matchId)
          }
        }
        // warn: no-op
      }
    } finally {
      this.cascadeInProgress.delete(key)
    }
  }

  // ─── Join resolver (v0.6 #73 — eager .join()) ────────────────────

  /**
   * Look up the `RefDescriptor` the left collection declared for a
   * given field name. Returns `null` when the field has no ref
   * declaration — the Query builder turns that into an actionable
   * error at plan time (before any records are touched).
   *
   * Implements the `joinResolver.resolveRef` half of the structural
   * interface that `Collection.query()` consumes. See
   * `query/join.ts` for the full design.
   */
  resolveRef(leftCollection: string, field: string): RefDescriptor | null {
    const outbound = this.refRegistry.getOutbound(leftCollection)
    return outbound[field] ?? null
  }

  /**
   * Resolve a right-side join source by target collection name.
   * Returns `null` for unknown collections so the Query executor can
   * surface an actionable error naming the missing target.
   *
   * Implements the `joinResolver.resolveSource` half of the
   * structural interface. The returned JoinableSource is a thin
   * wrapper that reads the target collection's in-memory cache via
   * `list()` / `get()` synchronously — the cache is populated by an
   * earlier `ensureHydrated()` call through the target's query/list
   * path. If the target has not been opened yet in this session the
   * join will see an empty snapshot; consumers who hit this can
   * open the target collection explicitly before running the query.
   *
   * Only same-compartment targets are resolvable — cross-compartment
   * joins are explicitly forbidden by the architecture (v0.5 #63
   * `queryAcross` is the sanctioned path for cross-compartment
   * correlation, not `.join()`).
   */
  resolveSource(collectionName: string): JoinableSource | null {
    // Reject internal / reserved collection names — joins against
    // `_ledger/`, `_keyring/`, `_deltas/`, etc. are never legitimate.
    if (collectionName.startsWith('_')) return null
    const coll = this.collectionCache.get(collectionName)
    if (!coll) return null
    // Collection exposes a structural `querySourceForJoin()` method
    // that returns a lightweight snapshot/lookupById view backed by
    // its in-memory cache. Typed as unknown here because
    // Collection<T> is covariant on T — the join executor only
    // reads fields by name and doesn't care about the concrete type.
    return (coll as unknown as {
      querySourceForJoin(): JoinableSource
    }).querySourceForJoin()
  }

  /**
   * Walk every collection that has declared refs, load its records,
   * and report any reference whose target id is missing. Modes are
   * reported alongside each violation so the caller can distinguish
   * "this is a warning the user asked for" from "this should never
   * have happened" (strict violations produced by out-of-band
   * writes).
   *
   * Returns `{ violations: [...] }` instead of throwing — the whole
   * point of `checkIntegrity()` is to surface a list for display
   * or repair, not to fail noisily.
   */
  async checkIntegrity(): Promise<{ violations: RefViolation[] }> {
    const violations: RefViolation[] = []
    for (const [collectionName, refs] of this.refRegistry.entries()) {
      const coll = this.collection<Record<string, unknown>>(collectionName)
      const records = await coll.list()
      for (const record of records) {
        const recId = (record['id'] as string | undefined) ?? '<unknown>'
        for (const [field, descriptor] of Object.entries(refs)) {
          const rawId = record[field]
          if (rawId === null || rawId === undefined) continue
          // Non-scalar ref values are flagged as a violation rather
          // than thrown — `checkIntegrity` is a "report what's wrong"
          // tool, not a "block on first failure" tool. The thrown
          // version lives in `enforceRefsOnPut`.
          if (typeof rawId !== 'string' && typeof rawId !== 'number') {
            violations.push({
              collection: collectionName,
              id: recId,
              field,
              refTo: descriptor.target,
              refId: rawId,
              mode: descriptor.mode,
            })
            continue
          }
          const refId = String(rawId)
          const target = this.collection<Record<string, unknown>>(descriptor.target)
          const exists = await target.get(refId)
          if (!exists) {
            violations.push({
              collection: collectionName,
              id: recId,
              field,
              refTo: descriptor.target,
              refId: rawId,
              mode: descriptor.mode,
            })
          }
        }
      }
    }
    return { violations }
  }

  /**
   * Return this compartment's hash-chained audit log.
   *
   * The ledger is lazy-initialized on first access and cached for the
   * lifetime of the Compartment instance. Every LedgerStore instance
   * shares the same adapter and DEK resolver, so `compartment.ledger()`
   * can be called repeatedly without performance cost.
   *
   * The LedgerStore itself is the public API: consumers call
   * `.append()` (via Collection internals), `.head()`, `.verify()`,
   * and `.entries({ from, to })`. See the LedgerStore docstring for
   * the full surface and the concurrency caveats.
   */
  ledger(): LedgerStore {
    if (!this.ledgerStore) {
      this.ledgerStore = new LedgerStore({
        adapter: this.adapter,
        compartment: this.name,
        encrypted: this.encrypted,
        getDEK: this.getDEK,
        actor: this.keyring.userId,
      })
    }
    return this.ledgerStore
  }

  /** List all collection names in this compartment. */
  async collections(): Promise<string[]> {
    const snapshot = await this.adapter.loadAll(this.name)
    return Object.keys(snapshot)
  }

  /**
   * Dump compartment as a verifiable encrypted JSON backup string.
   *
   * v0.4 backups embed the current ledger head and the full
   * `_ledger` + `_ledger_deltas` internal collections so the
   * receiver can run `verifyBackupIntegrity()` after `load()` and
   * detect any tampering between dump and restore. Pre-v0.4 callers
   * who didn't have a ledger get a backup without these fields, and
   * the corresponding `load()` skips the integrity check with a
   * warning — both modes round-trip cleanly.
   */
  async dump(): Promise<string> {
    const snapshot = await this.adapter.loadAll(this.name)

    // Load keyrings (separate path because loadAll filters them out
    // along with all other underscore-prefixed internal collections).
    const keyringIds = await this.adapter.list(this.name, '_keyring')
    const keyrings: Record<string, unknown> = {}
    for (const keyringId of keyringIds) {
      const envelope = await this.adapter.get(this.name, '_keyring', keyringId)
      if (envelope) {
        keyrings[keyringId] = JSON.parse(envelope._data)
      }
    }

    // Load the ledger entries + deltas so the receiver can replay
    // the chain after restore. Without this, `load()` would have an
    // empty ledger and `verifyBackupIntegrity()` would have nothing
    // to compare against.
    const internalSnapshot: CompartmentSnapshot = {}
    for (const internalName of [LEDGER_COLLECTION, LEDGER_DELTAS_COLLECTION]) {
      const ids = await this.adapter.list(this.name, internalName)
      if (ids.length === 0) continue
      const records: Record<string, EncryptedEnvelope> = {}
      for (const id of ids) {
        const envelope = await this.adapter.get(this.name, internalName, id)
        if (envelope) records[id] = envelope
      }
      internalSnapshot[internalName] = records
    }

    // Embed the ledger head if there's a chain. An empty ledger
    // (fresh compartment) leaves `ledgerHead` undefined, which
    // load() treats the same as a legacy backup (no integrity
    // check, console warning).
    const head = await this.ledger().head()
    const backup: CompartmentBackup = {
      _noydb_backup: NOYDB_BACKUP_VERSION,
      _compartment: this.name,
      _exported_at: new Date().toISOString(),
      _exported_by: this.keyring.userId,
      keyrings: keyrings as CompartmentBackup['keyrings'],
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
   * Restore a compartment from a verifiable backup.
   *
   * After loading, runs `verifyBackupIntegrity()` to confirm:
   *   1. The hash chain is intact (no `prevHash` mismatches)
   *   2. The chain head matches the embedded `ledgerHead.hash`
   *      from the backup
   *   3. Every data envelope's `payloadHash` matches the
   *      corresponding ledger entry — i.e. nobody swapped
   *      ciphertext between dump and restore
   *
   * On any failure, throws `BackupLedgerError` (chain or head
   * mismatch) or `BackupCorruptedError` (data envelope mismatch).
   * The compartment state on the adapter has already been written
   * by the time we throw, so the caller is responsible for either
   * accepting the suspect state or wiping it and trying a different
   * backup.
   *
   * Pre-v0.4 backups (no `ledgerHead` field, no `_internal`) load
   * with a console warning and skip the integrity check entirely
   * — there's no chain to verify against.
   */
  async load(backupJson: string): Promise<void> {
    const backup = JSON.parse(backupJson) as CompartmentBackup

    // 1. Restore data collections.
    await this.adapter.saveAll(this.name, backup.collections)

    // 2. Restore keyrings (same as v0.3).
    for (const [userId, keyringFile] of Object.entries(backup.keyrings)) {
      const envelope = {
        _noydb: 1 as const,
        _v: 1,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: JSON.stringify(keyringFile),
      }
      await this.adapter.put(this.name, '_keyring', userId, envelope)
    }

    // 3. Restore internal collections (`_ledger`, `_ledger_deltas`).
    //    Required so verifyBackupIntegrity has the chain to walk.
    if (backup._internal) {
      for (const [internalName, records] of Object.entries(backup._internal)) {
        for (const [id, envelope] of Object.entries(records)) {
          await this.adapter.put(this.name, internalName, id, envelope)
        }
      }
    }

    // 4. Refresh the in-memory keyring from the freshly-loaded
    //    keyring file. Without this, the Compartment's getDEK
    //    closure still holds the OLD session's DEKs, and every
    //    decrypt of a loaded ledger entry / data envelope fails
    //    with TamperedError because the DEK doesn't match the
    //    ciphertext that was encrypted with the SOURCE user's DEK.
    //    Skipped for plaintext compartments and for tests that
    //    construct Compartment without a reloadKeyring callback.
    if (this.reloadKeyring) {
      this.keyring = await this.reloadKeyring()
      // Rebuild the DEK resolver against the refreshed keyring so
      // the next ensureCollectionDEK call sees the loaded wrapped
      // DEKs, not the cached pre-load ones.
      this.getDEK = this.makeGetDEK()
    }

    // 5. Clear collection cache + reset the ledger store so the
    //    next ledger() call rebuilds its head cache from the
    //    freshly-loaded entries.
    this.collectionCache.clear()
    this.ledgerStore = null

    // 5. Run the verification gate. Pre-v0.4 backups skip this with
    //    a one-line warning so existing consumers can still read
    //    them while migrating.
    if (!backup.ledgerHead) {
      console.warn(
        `[noy-db] Loaded a legacy backup with no ledgerHead — ` +
        `verifiable-backup integrity check skipped. ` +
        `Re-export with v0.4+ to get tamper detection.`,
      )
      return
    }

    const result = await this.verifyBackupIntegrity()
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
   * End-to-end backup integrity check. Runs both:
   *
   *   1. `ledger.verify()` — walks the hash chain and confirms
   *      every `prevHash` matches the recomputed hash of its
   *      predecessor.
   *
   *   2. **Data envelope cross-check** — for every (collection, id)
   *      that has a current value, find the most recent ledger
   *      entry recording a `put` for that pair, recompute the
   *      sha256 of the stored envelope's `_data`, and compare to
   *      the entry's `payloadHash`. Any mismatch means an
   *      out-of-band write modified the data without updating the
   *      ledger.
   *
   * Returns a discriminated union so callers can handle the two
   * failure modes differently:
   *   - `{ ok: true, head, length }` — chain verified and all
   *     data matches; safe to use.
   *   - `{ ok: false, kind: 'chain', divergedAt, message }` — the
   *     chain itself is broken at the given index.
   *   - `{ ok: false, kind: 'data', collection, id, message }` —
   *     a specific data envelope doesn't match its ledger entry.
   *
   * This method is exposed so users can call it any time, not just
   * during `load()`. A scheduled background check is the simplest
   * way to detect tampering of an in-place compartment.
   */
  async verifyBackupIntegrity(): Promise<
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
  > {
    // Step 1: chain verification.
    const chainResult = await this.ledger().verify()
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
    const ledger = this.ledger()
    const allEntries = await ledger.loadAllEntries()

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
      const key = `${entry.collection}/${entry.id}`
      if (seen.has(key)) continue
      seen.add(key)
      // For deletes the data collection should NOT have the record,
      // so we skip — there's nothing to cross-check.
      if (entry.op === 'delete') continue
      latest.set(key, {
        collection: entry.collection,
        id: entry.id,
        expectedHash: entry.payloadHash,
      })
    }

    for (const { collection, id, expectedHash } of latest.values()) {
      const envelope = await this.adapter.get(this.name, collection, id)
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
      const actualHash = await sha256Hex(envelope._data)
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
   * Stream every collection in this compartment as decrypted, ACL-scoped
   * chunks.
   *
   * ⚠ **This method decrypts your records.** noy-db's threat model assumes
   * that records on disk are encrypted; the values yielded here are
   * plaintext. The consumer is responsible for ensuring the yielded data
   * is handled in a way that matches the data's sensitivity. If your goal
   * is encrypted backup or transport between noy-db instances, use
   * `dump()` instead — it produces a tamper-evident encrypted envelope and
   * never exposes plaintext.
   *
   * ## Behavior
   *
   * - **ACL-scoped.** Collections the calling principal cannot read are
   *   silently skipped (same rule as `Collection.list()`). An operator
   *   with `{ invoices: 'rw', clients: 'ro' }` permissions on a
   *   five-collection compartment exports only `invoices` and `clients`,
   *   with no error on the others.
   * - **Streaming.** Returns an `AsyncIterableIterator` so consumers can
   *   process chunks as they arrive without holding the full export in
   *   memory. Note: the underlying adapter call (`loadAll`) is still a
   *   single bulk read — the streaming benefit is on the *output* side.
   *   True per-record adapter streaming arrives with the v0.6 query DSL.
   * - **Schema + refs surfaced** as metadata on every chunk so downstream
   *   serializers (`@noy-db/decrypt-csv`, `@noy-db/decrypt-xlsx`, custom
   *   exporters) can produce schema-aware output without reaching into
   *   collection internals.
   * - **Internal collections filtered.** `_ledger`, `_keyring`, etc. are
   *   never yielded — they're noy-db's own bookkeeping and have no value
   *   in a plaintext export. Use `dump()` for full backup including
   *   internal collections.
   *
   * ## Composition
   *
   * Once cross-compartment queries land (#63), fanning this out across
   * every compartment the caller can unlock is `queryAcross(ids, c =>
   * c.exportStream())` — no new primitive needed. That's part of why this
   * method belongs in core: it's the single decrypt+ACL+metadata path
   * that every export-format package will build on, and pushing it into
   * a `@noy-db/decrypt-*` package would force every format to re-solve
   * the same problems independently.
   *
   * @example
   * ```ts
   * for await (const chunk of company.exportStream()) {
   *   // chunk.collection: 'invoices'
   *   // chunk.schema: ZodObject | null
   *   // chunk.refs: { clientId: { target: 'clients', mode: 'strict' } }
   *   // chunk.records: Invoice[]
   * }
   * ```
   *
   * @example
   * ```ts
   * // Per-record streaming for arbitrarily large collections.
   * for await (const chunk of company.exportStream({ granularity: 'record' })) {
   *   // chunk.records is always length 1
   *   await writer.write(serialize(chunk.records[0]))
   * }
   * ```
   */
  async *exportStream(opts: ExportStreamOptions = {}): AsyncIterableIterator<ExportChunk> {
    const granularity = opts.granularity ?? 'collection'

    // One bulk read to enumerate collections. `loadAll` filters out
    // underscore-prefixed internal collections, which is exactly what we
    // want — internal bookkeeping has no place in a plaintext export.
    const snapshot = await this.adapter.loadAll(this.name)
    const collectionNames = Object.keys(snapshot).sort()

    // Resolve the ledger head once if requested. The head is identical
    // across every yielded chunk (one ledger per compartment) — we copy
    // it onto each chunk so consumers doing per-record streaming don't
    // have to thread state across yields, and so the chunk shape stays
    // forward-compatible with future per-partition ledgers where the
    // head genuinely will differ per chunk.
    const ledgerHead = opts.withLedgerHead
      ? await (async () => {
          const head = await this.ledger().head()
          return head
            ? { hash: head.hash, index: head.entry.index, ts: head.entry.ts }
            : undefined
        })()
      : undefined

    for (const collectionName of collectionNames) {
      // ACL gate. The same `hasAccess` check that `Collection.list()`
      // honors — silent skip, no error, matches the "operator can read
      // some but not all" pattern.
      if (!hasAccess(this.keyring, collectionName)) continue

      const coll = this.collection(collectionName)
      const schema = coll.getSchema() ?? null
      const refs = this.refRegistry.getOutbound(collectionName)
      const ids = Object.keys(snapshot[collectionName] ?? {})

      if (granularity === 'collection') {
        // Decrypt every record in the collection, then yield once.
        // Using `coll.get(id)` rather than the loadAll envelope directly
        // because `get()` is the canonical decrypt+schema-validate path
        // and any future cache/index plumbing rides through it.
        const records: unknown[] = []
        for (const id of ids) {
          const record = await coll.get(id)
          if (record !== null) records.push(record)
        }
        const chunk: ExportChunk = {
          collection: collectionName,
          schema,
          refs,
          records,
          ...(ledgerHead ? { ledgerHead } : {}),
        }
        yield chunk
      } else {
        // Per-record yield. Memory profile: O(1 record) at a time.
        // The schema/refs metadata is repeated on every chunk so
        // consumers don't have to thread state across yields.
        for (const id of ids) {
          const record = await coll.get(id)
          if (record === null) continue
          const chunk: ExportChunk = {
            collection: collectionName,
            schema,
            refs,
            records: [record],
            ...(ledgerHead ? { ledgerHead } : {}),
          }
          yield chunk
        }
      }
    }
  }

  /**
   * Convenience wrapper that consumes `exportStream()` and serializes the
   * result to a single JSON string.
   *
   * ⚠ **`exportJSON()` decrypts your records and produces plaintext.**
   *
   * noy-db's threat model assumes that records on disk are encrypted.
   * This function deliberately violates that assumption: it produces a
   * JSON string in plaintext, which the consumer is then responsible for
   * protecting (filesystem permissions, full-disk encryption, secure
   * transfer, secure deletion).
   *
   * Use this function only when:
   * - You are the authorized owner of the data, **and**
   * - You have a legitimate downstream tool that requires plaintext
   *   JSON, **and**
   * - You have a documented plan for how the resulting plaintext will be
   *   protected and eventually destroyed.
   *
   * If your goal is encrypted backup or transport between noy-db
   * instances, use `dump()` instead — it produces a tamper-evident
   * encrypted envelope, never plaintext.
   *
   * ## Why `Promise<string>` instead of writing to a file path
   *
   * Core has zero `node:` imports — it runs unchanged in browsers, Node,
   * Bun, Deno, and edge runtimes. Accepting a file path would force a
   * `node:fs` import (breaks browsers) or a runtime dynamic import
   * (doesn't tree-shake, inflates bundles). Returning a string lets the
   * consumer choose any sink and forces the destination decision to be
   * explicit at the call site — which is also better for the security
   * warning.
   *
   * @example
   * ```ts
   * // Node: write to a file
   * import { writeFile } from 'node:fs/promises'
   * await writeFile('./backup.json', await company.exportJSON())
   * ```
   *
   * @example
   * ```ts
   * // Browser: download as a file
   * const json = await company.exportJSON()
   * const blob = new Blob([json], { type: 'application/json' })
   * const url = URL.createObjectURL(blob)
   * // ... attach to an <a download> and click
   * ```
   *
   * @example
   * ```ts
   * // Stream upload to a server
   * await fetch('/upload', {
   *   method: 'POST',
   *   body: await company.exportJSON(),
   * })
   * ```
   *
   * ## On-disk shape
   *
   * ```json
   * {
   *   "_noydb_export": 1,
   *   "_compartment": "acme",
   *   "_exported_at": "2026-04-07T12:00:00.000Z",
   *   "_exported_by": "alice@acme.example",
   *   "collections": {
   *     "invoices": {
   *       "schema": null,
   *       "refs": { "clientId": { "target": "clients", "mode": "strict" } },
   *       "records": [ ... ]
   *     }
   *   },
   *   "ledgerHead": { "hash": "...", "index": 42, "ts": "..." }
   * }
   * ```
   *
   * `schema` is included for forward compatibility but is currently
   * always `null` because Standard Schema validators are not JSON-
   * serializable. Format-package serializers that need the schema
   * should use `exportStream()` directly and read `chunk.schema` (which
   * is the live validator object, not a serialization of it).
   */
  async exportJSON(opts: ExportStreamOptions = {}): Promise<string> {
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

    for await (const chunk of this.exportStream({
      granularity: 'collection',
      withLedgerHead: opts.withLedgerHead === true,
    })) {
      collections[chunk.collection] = {
        schema: null, // Standard Schema validators are not JSON-serializable
        refs: chunk.refs,
        records: chunk.records,
      }
      if (chunk.ledgerHead) ledgerHead = chunk.ledgerHead
    }

    return JSON.stringify({
      _noydb_export: 1,
      _compartment: this.name,
      _exported_at: new Date().toISOString(),
      _exported_by: this.keyring.userId,
      collections,
      ...(ledgerHead ? { ledgerHead } : {}),
    })
  }
}
