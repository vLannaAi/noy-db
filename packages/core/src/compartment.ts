import type { NoydbAdapter, CompartmentBackup, HistoryConfig } from './types.js'
import { NOYDB_BACKUP_VERSION } from './types.js'
import { Collection } from './collection.js'
import type { CacheOptions } from './collection.js'
import type { IndexDef } from './query/indexes.js'
import type { OnDirtyCallback } from './collection.js'
import type { UnlockedKeyring } from './keyring.js'
import { ensureCollectionDEK } from './keyring.js'
import type { NoydbEventEmitter } from './events.js'
import { PermissionDeniedError } from './errors.js'
import type { StandardSchemaV1 } from './schema.js'
import { LedgerStore } from './ledger/index.js'
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
  private readonly keyring: UnlockedKeyring
  private readonly encrypted: boolean
  private readonly emitter: NoydbEventEmitter
  private readonly onDirty: OnDirtyCallback | undefined
  private readonly historyConfig: HistoryConfig
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>
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
  }) {
    this.adapter = opts.adapter
    this.name = opts.name
    this.keyring = opts.keyring
    this.encrypted = opts.encrypted
    this.emitter = opts.emitter
    this.onDirty = opts.onDirty
    this.historyConfig = opts.historyConfig ?? { enabled: true }

    // Create the DEK resolver (lazy — generates DEKs on first use)
    // We need to store the promise to avoid recreating it
    let getDEKFn: ((collectionName: string) => Promise<CryptoKey>) | null = null
    this.getDEK = async (collectionName: string): Promise<CryptoKey> => {
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

  /** Dump compartment as encrypted JSON backup string. */
  async dump(): Promise<string> {
    const snapshot = await this.adapter.loadAll(this.name)

    // Load keyrings
    const keyringIds = await this.adapter.list(this.name, '_keyring')
    const keyrings: Record<string, unknown> = {}
    for (const keyringId of keyringIds) {
      const envelope = await this.adapter.get(this.name, '_keyring', keyringId)
      if (envelope) {
        keyrings[keyringId] = JSON.parse(envelope._data)
      }
    }

    const backup: CompartmentBackup = {
      _noydb_backup: NOYDB_BACKUP_VERSION,
      _compartment: this.name,
      _exported_at: new Date().toISOString(),
      _exported_by: this.keyring.userId,
      keyrings: keyrings as CompartmentBackup['keyrings'],
      collections: snapshot,
    }

    return JSON.stringify(backup)
  }

  /** Restore compartment from an encrypted JSON backup string. */
  async load(backupJson: string): Promise<void> {
    const backup = JSON.parse(backupJson) as CompartmentBackup
    await this.adapter.saveAll(this.name, backup.collections)

    // Restore keyrings
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

    // Clear collection cache so they re-hydrate
    this.collectionCache.clear()
  }

  /** Export compartment as decrypted JSON (owner only). */
  async export(): Promise<string> {
    if (this.keyring.role !== 'owner') {
      throw new PermissionDeniedError('Only the owner can export decrypted data')
    }

    const result: Record<string, Record<string, unknown>> = {}
    const snapshot = await this.adapter.loadAll(this.name)

    for (const [collName, records] of Object.entries(snapshot)) {
      const coll = this.collection(collName)
      const decrypted: Record<string, unknown> = {}
      for (const id of Object.keys(records)) {
        decrypted[id] = await coll.get(id)
      }
      result[collName] = decrypted
    }

    return JSON.stringify(result)
  }
}
