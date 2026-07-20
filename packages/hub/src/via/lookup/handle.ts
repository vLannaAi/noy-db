/**
 * `_dict_*` reserved-collection storage engine — `LookupHandle`.
 *
 * Verbatim move of `DictionaryHandle` out of `via/i18n/dictionary.ts`
 * (#650 Task 1 — via-lookup extraction, phase D). The class is renamed to
 * `LookupHandle` (the dict tier is one backing kind the eventual lookup
 * layer supports); `via/i18n/dictionary.ts` re-exports it as
 * `DictionaryHandle` for one release so existing importers compile
 * unchanged. `DictEntry` / `DictionaryOptions` / `DICT_COLLECTION_PREFIX` /
 * `dictCollectionName` move with it — they were exclusively consumed by
 * this class's constructor/methods.
 *
 * No behavior change from the pre-move class: same encryption door
 * (`reservedEnvelopes('_dict_')`, #629 Task 4), same ACL, same ledger
 * shape, same sync-cache/snapshot contract for dict joins.
 */

import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import type { NoydbEventEmitter } from '../../kernel/events.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import type { ViaCryptoCtx } from '../../kernel/via/index.js'
import type { LedgerStore } from '../../with-commit/history/ledger/store.js'
import { envelopePayloadHash } from '../../with-commit/history/ledger/hash.js'
import {
  PermissionDeniedError,
  DictKeyMissingError,
} from '../../kernel/errors.js'

/**
 * Delete-marker predicate, duplicated (not imported) from
 * `kernel/enclave/record-keys/tombstone.ts`'s `isDeleteMarker` (#647 fix wave 1).
 * `via/lookup/**` may not statically import `kernel/enclave/` — not even the barrel
 * (Check 15, `via-enclave-isolation`) — and this predicate carries zero crypto/protected-body
 * surface (just the `_del` protocol-header field, not `_iv`/`_data`), so duplicating it here
 * mirrors the same call `port/with/i18n-strategy.ts` already makes for `isDictCollectionName`
 * (see its doc comment). Keep the two in sync if the marker shape ever changes.
 *
 * `buildDeleteMarker` (which DOES construct the protected `_iv`/`_data` body fields — Check 11,
 * `enclave-body-only`) can't be duplicated the same way; it's injected via the constructor
 * instead, built from the real `kernel/enclave` function at the Vault call site.
 */
function isDeleteMarker(envelope: EncryptedEnvelope): boolean {
  return envelope._del === true
}

/** Reserved collection name prefix. Never collides with user collections. */
export const DICT_COLLECTION_PREFIX = '_dict_'

/** Return the adapter collection name for a named dictionary. */
export function dictCollectionName(dictionaryName: string): string {
  return `${DICT_COLLECTION_PREFIX}${dictionaryName}`
}

// ─── Dictionary entry shape ────────────────────────────────────────────

/**
 * One entry in a `_dict_*` collection. The record `id` (adapter-side
 * key) IS the stable dictionary key (e.g. `'paid'`). The `labels`
 * record maps locale codes to display strings.
 */
export interface DictEntry {
  /** Stable key — same as the record id in the adapter. */
  readonly key: string
  /** Locale → label map, e.g. `{ en: 'Paid', th: 'ชำระแล้ว' }`. */
  readonly labels: Record<string, string>
}

// ─── Per-dictionary options ────────────────────────────────────────────

/**
 * Options for `vault.dictionary(name, options?)`.
 *
 * `writableBy` controls the minimum role for write operations (put,
 * putAll, delete, rename). Defaults to `'admin'` to match the standard
 * "dictionary contents are owned by admins" convention; set to
 * `'operator'` for user-editable dictionaries like custom tags.
 */
export interface DictionaryOptions {
  /** Minimum role allowed to write dictionary entries. Default: `'admin'`. */
  readonly writableBy?: 'owner' | 'admin' | 'operator'
}

// ─── LookupHandle ───────────────────────────────────────────────────────

/**
 * Handle to a named dictionary within a vault.
 *
 * Obtained via `vault.dictionary(name)`. Provides strongly-typed
 * CRUD for dictionary entries, plus the `rename()` operation that is the
 * only sanctioned mass-mutation path for dictKey fields.
 *
 * All writes are encrypted under the compartment's DEK for the
 * `_dict_<name>` collection. Adapters never see plaintext.
 */
export class LookupHandle<Keys extends string = string> {
  private readonly collName: string

  /**
   * Synchronous write-through cache for dict-join support.
   * Populated on every `put()`, `delete()`, and `rename()`. The snapshot
   * is built from this cache by `snapshotEntries()` — the query executor
   * calls this synchronously inside `.toArray()`.
   *
   * `null` means "not yet initialized" — callers should use `list()`
   * to warm the cache before using dict joins on pre-existing data.
   */
  private readonly _syncCache = new Map<string, DictEntry>()

  /**
   * Return all cached entries as `{ key, labels, ...labels }` records —
   * usable synchronously by the join executor's `snapshot()` call.
   * Returns an empty array when the cache has never been populated.
   */
  snapshotEntries(): readonly Record<string, unknown>[] {
    return Array.from(this._syncCache.values()).map((e) => ({
      key: e.key,
      labels: e.labels,
      ...e.labels,
    }))
  }

  constructor(
    private readonly adapter: NoydbStore,
    private readonly compartmentName: string,
    private readonly dictionaryName: string,
    private readonly keyring: UnlockedKeyring,
    /**
     * The `reservedEnvelopes('_dict_')` capability — this handle's sanctioned
     * crypto door onto its `_dict_<name>` collection (#629 Task 4). Bound by
     * the Vault; never a keyring, raw DEK, or enclave import.
     */
    private readonly reservedEnvelopes: ReturnType<ViaCryptoCtx['reservedEnvelopes']>,
    private readonly encrypted: boolean,
    private readonly ledger: LedgerStore | undefined,
    private readonly options: DictionaryOptions,
    /**
     * Callback provided by the Vault to find and rewrite records
     * in any registered collection that has a dictKeyField pointing at
     * this dictionary, used by `rename()`.
     */
    private readonly findAndUpdateReferences:
      | ((
          dictionaryName: string,
          oldKey: string,
          newKey: string,
        ) => Promise<void>)
      | undefined,
    private readonly emitter: NoydbEventEmitter,
    /**
     * #647 fix wave 1 — mints a version-ordered delete-marker envelope (the reserved-tier
     * mirror of #589's ordinary-collection delete marker). Injected rather than imported:
     * `buildDeleteMarker` constructs the envelope's protected-body fields (`_iv`/`_data`), and
     * `via/lookup/**` may not reach `kernel/enclave/` directly (Check 11
     * `enclave-body-only` / Check 15 `via-enclave-isolation`) — the Vault binds the real
     * `kernel/enclave` function at construction time, same pattern as `reservedEnvelopes` above.
     */
    private readonly buildDeleteMarker: (version: number, actor: string) => EncryptedEnvelope,
    /** #650 Task 4 (#647) — dirty-log participation hook (origin `local-write`), threaded from `BuildLookupHandleOptions`. */
    private readonly onDirty?: (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>,
    /** #650 Task 4 — thin `graphDispatch.collect`-equivalent; opens/collects/flushes a one-shot wave for this touch. */
    private readonly onRecordMutated?: (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>,
    /** #650 Task 5 (#648) — the real reference check `delete()`'s strict branch calls: restrict
     *  throws `DictKeyInUseError`, cascade/nullify apply their propagation. Vault-bound; a no-op
     *  when the dimension has no declared lookup-referencing edges. */
    private readonly checkReferencesOnDelete?: (key: string) => Promise<unknown>,
  ) {
    this.collName = dictCollectionName(dictionaryName)
  }

  // ─── Access checks ────────────────────────────────────────────────

  private requireWriteAccess(): void {
    const minRole = this.options.writableBy ?? 'admin'
    const roleRank: Record<string, number> = {
      client: 1,
      viewer: 2,
      operator: 3,
      admin: 4,
      owner: 5,
    }
    const callerRank = roleRank[this.keyring.role] ?? 0
    const requiredRank = roleRank[minRole] ?? 4
    if (callerRank < requiredRank) {
      throw new PermissionDeniedError(
        `Dictionary "${this.dictionaryName}" writes require "${minRole}" role or above. ` +
          `Current role: "${this.keyring.role}".`,
      )
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  private async encryptEntry(entry: DictEntry, version: number): Promise<EncryptedEnvelope> {
    if (!this.encrypted) {
      return {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: version,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: JSON.stringify(entry),
        _by: this.keyring.userId,
      }
    }
    const envelope = await this.reservedEnvelopes.encrypt(this.collName, JSON.stringify(entry), version)
    return { ...envelope, _by: this.keyring.userId }
  }

  private async decryptEntry(envelope: EncryptedEnvelope): Promise<DictEntry> {
    if (!this.encrypted) {
      return JSON.parse(envelope._data) as DictEntry
    }
    const json = await this.reservedEnvelopes.decrypt(this.collName, envelope)
    return JSON.parse(json) as DictEntry
  }

  /** @internal #650 Task 4 — re-read `key`'s CURRENT adapter truth into `_syncCache` (delete the
   *  cache entry when the key is now gone). Called by `Vault._invalidateSyncApplied` after a
   *  reserved-lookup row applies via sync, so an already-warmed snapshot/membership/altIndex read
   *  never sees a stale verdict for a pulled vocabulary edit — the same invalidation a local
   *  put()/delete()/rename() already triggers via `_syncCache.set`/`delete` above. */
  async _refreshSyncCache(key: string): Promise<void> {
    const envelope = await this.adapter.get(this.compartmentName, this.collName, key)
    if (!envelope || isDeleteMarker(envelope)) { this._syncCache.delete(key); return }
    this._syncCache.set(key, await this.decryptEntry(envelope))
  }

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * Add or overwrite a single dictionary entry.
   *
   * @param key    The stable key to store (e.g. `'paid'`).
   * @param labels Locale → label map (e.g. `{ en: 'Paid', th: 'ชำระแล้ว' }`).
   */
  async put(key: Keys, labels: Record<string, string>): Promise<void> {
    this.requireWriteAccess()

    const entry: DictEntry = { key, labels }
    const existing = await this.adapter.get(
      this.compartmentName,
      this.collName,
      key,
    )
    const version = existing ? existing._v + 1 : 1
    const envelope = await this.encryptEntry(entry, version)

    await this.adapter.put(
      this.compartmentName,
      this.collName,
      key,
      envelope,
      existing ? existing._v : undefined,
    )

    // Maintain synchronous cache for dict-join snapshot
    this._syncCache.set(key, entry)

    // #650 Task 4 (#647) — choke-point participation: dirty-log tracking BEFORE the emit (mirrors
    // Collection._onRecordMutated's local-write order), then the wave-open hook AFTER.
    await this.onDirty?.(this.collName, key, 'put', version)

    this.emitter.emit('change', {
      vault: this.compartmentName,
      collection: this.collName,
      id: key,
      action: 'put',
    })

    await this.onRecordMutated?.(this.collName, key, 'put', version)

    if (this.ledger) {
      await this.ledger.append({
        op: 'put',
        collection: this.collName,
        id: key,
        version,
        actor: this.keyring.userId,
        //  — must be the real envelope hash so
        // vault.verifyBackupIntegrity()'s data-cross-check matches.
        payloadHash: await envelopePayloadHash(envelope),
      })
    }
  }

  /**
   * Batch-add or overwrite multiple dictionary entries in one call.
   *
   * @param entries  `{ key: { locale: label } }` map.
   */
  async putAll(entries: Record<Keys, Record<string, string>>): Promise<void> {
    this.requireWriteAccess()
    for (const [key, labels] of Object.entries(entries) as [Keys, Record<string, string>][]) {
      await this.put(key, labels)
    }
  }

  /**
   * Load the label map for a single key.
   *
   * @returns The label map, or `null` if the key doesn't exist.
   */
  async get(key: Keys): Promise<Record<string, string> | null> {
    const envelope = await this.adapter.get(
      this.compartmentName,
      this.collName,
      key,
    )
    if (!envelope || isDeleteMarker(envelope)) return null
    const entry = await this.decryptEntry(envelope)
    return entry.labels
  }

  /**
   * Delete a dictionary key.
   *
   * Default mode is `'strict'` — throws `DictKeyInUseError` if any
   * registered collection has a record referencing this key. Pass
   * `{ mode: 'warn' }` to skip the check (dev-mode cleanup only).
   *
   * Under sync, deletion writes a version-ordered delete-marker row rather than removing the
   * adapter key outright (#647 fix wave 1) — markers accumulate over time; GC is future work,
   * acceptable for vocabulary-scale data.
   */
  async delete(key: Keys, opts: { mode?: 'strict' | 'warn' } = {}): Promise<void> {
    this.requireWriteAccess()

    const existing = await this.adapter.get(
      this.compartmentName,
      this.collName,
      key,
    )
    if (!existing || isDeleteMarker(existing)) {
      throw new DictKeyMissingError(this.dictionaryName, key)
    }

    // #650 Task 5 (#648) — the real reference check: restrict throws `DictKeyInUseError` naming
    // the referencing collection, cascade/nullify apply their propagation. `mode: 'warn'` skips
    // this entirely (today's dev-mode-cleanup escape hatch, unconditional delete). A dimension
    // with no declared lookup-referencing edges is a no-op (undeclared refs keep dangling).
    const mode = opts.mode ?? 'strict'
    if (mode === 'strict') {
      await this.checkReferencesOnDelete?.(key)
    }

    // #647 fix wave 1 — mirrors Collection._doDelete's identical `this.onDirty`-gated branch
    // (#589): under sync, a raw adapter.delete() is invisible to a peer's next pull (the key
    // simply stops appearing in remote.list()) — a deleted key never propagates and can be
    // silently resurrected by a later edit. Write a version-ordered DELETE-MARKER instead, so
    // the removal round-trips like any other row. No-op (plain adapter.delete) when sync isn't wired.
    const nextVersion = existing._v + 1
    if (this.onDirty) {
      await this.adapter.put(this.compartmentName, this.collName, key, this.buildDeleteMarker(nextVersion, this.keyring.userId))
    } else {
      await this.adapter.delete(this.compartmentName, this.collName, key)
    }

    // Maintain synchronous cache for dict-join snapshot
    this._syncCache.delete(key)

    // #650 Task 4 (#647) — same choke-point ordering as put() above.
    // #647 fix wave 1: the dirty entry's ACTION is 'put' (not 'delete') — mirrors
    // Collection._onRecordMutated's 'local-delete' case exactly: the marker rides push's
    // CAS-put path, not push's raw remote.delete() path (which would strip the marker off the
    // remote too and reopen this same hole). The version is the MARKER's version, so push's CAS
    // (expectedVersion = entry.version - 1) matches the pre-delete remote copy.
    await this.onDirty?.(this.collName, key, 'put', nextVersion)

    this.emitter.emit('change', {
      vault: this.compartmentName,
      collection: this.collName,
      id: key,
      action: 'delete',
    })

    await this.onRecordMutated?.(this.collName, key, 'delete', nextVersion)

    if (this.ledger) {
      await this.ledger.append({
        op: 'delete',
        collection: this.collName,
        id: key,
        version: existing._v,
        actor: this.keyring.userId,
        //  — for delete the prior envelope is what was just
        // removed; we hash it so the chain captures intent. The
        // verifyBackupIntegrity data-cross-check skips delete
        // entries entirely (the live record is gone), but the
        // chain still benefits from a stable non-empty hash.
        payloadHash: await envelopePayloadHash(existing),
      })
    }
  }

  /**
   * Rename a dictionary key — the only sanctioned mass-mutation path.
   *
   * Atomically:
   * 1. Adds the new key with the same labels as the old key.
   * 2. Updates every registered record that stores the old key to
   *    store the new key instead.
   * 3. Deletes the old key.
   * 4. Appends a single ledger entry recording the rename.
   *
   * Respects ACL: throws `PermissionDeniedError` before any mutation
   * if the caller can't write. The cascade is best-effort atomic
   * within this call — no two-phase commit across adapter calls.
   *
   * Cascade-on-delete is NOT supported. Use `rename()` when you need
   * to change a key that records reference.
   */
  async rename(oldKey: Keys, newKey: string): Promise<void> {
    this.requireWriteAccess()

    // 1. Load old entry
    const existing = await this.adapter.get(
      this.compartmentName,
      this.collName,
      oldKey,
    )
    if (!existing || isDeleteMarker(existing)) {
      throw new DictKeyMissingError(this.dictionaryName, oldKey)
    }
    const oldEntry = await this.decryptEntry(existing)

    // 2. Write new key
    const newEntry: DictEntry = { key: newKey, labels: oldEntry.labels }
    const newEnvelope = await this.encryptEntry(newEntry, 1)
    await this.adapter.put(
      this.compartmentName,
      this.collName,
      newKey,
      newEnvelope,
    )

    // #670 — publish newKey to the sync cache BEFORE step 3 rewrites referencing records: a
    // vocabulary:'closed' referencing field's enforceWrite reads checkLookupMembership ->
    // snapshotEntries() -> this._syncCache, so if newKey isn't a member yet, step 3's own write of
    // newKey into those records self-refuses with UnknownLookupKeyError. Transition semantics:
    // mid-rename BOTH oldKey and newKey are legitimately members (records are transitioning
    // old->new during the rewrite) — oldKey stays a member until its removal completes below.
    this._syncCache.set(newKey, newEntry)

    // 3. Update all referencing records in registered collections
    if (this.findAndUpdateReferences) {
      await this.findAndUpdateReferences(this.dictionaryName, oldKey, newKey)
    }

    // 4. Remove old key — #647 fix wave 1: same delete-marker convention as delete() above, so
    // the old key's removal propagates on sync instead of leaving a phantom stale row on a peer
    // that only observes the new key arriving.
    const oldKeyNextVersion = existing._v + 1
    if (this.onDirty) {
      await this.adapter.put(this.compartmentName, this.collName, oldKey, this.buildDeleteMarker(oldKeyNextVersion, this.keyring.userId))
    } else {
      await this.adapter.delete(this.compartmentName, this.collName, oldKey)
    }

    // Maintain synchronous cache for dict-join snapshot — oldKey's removal from the cache lands
    // here (after step 3), completing the old->new membership transition begun above.
    this._syncCache.delete(oldKey)

    // #650 Task 4 (#647) — same choke-point ordering as put()/delete() above, for BOTH touches.
    // #647 fix wave 1: oldKey's dirty action is 'put' (not 'delete') — see delete()'s comment
    // above for why the marker must ride push's CAS-put path, at the marker's version.
    await this.onDirty?.(this.collName, oldKey, 'put', oldKeyNextVersion)
    this.emitter.emit('change', {
      vault: this.compartmentName,
      collection: this.collName,
      id: oldKey,
      action: 'delete',
    })
    await this.onRecordMutated?.(this.collName, oldKey, 'delete', oldKeyNextVersion)

    await this.onDirty?.(this.collName, newKey, 'put', 1)
    this.emitter.emit('change', {
      vault: this.compartmentName,
      collection: this.collName,
      id: newKey,
      action: 'put',
    })
    await this.onRecordMutated?.(this.collName, newKey, 'put', 1)

    // 5. Ledger — record the rename as delete(oldKey) + put(newKey)
    // so verifyBackupIntegrity()'s data-cross-check matches reality
    // (the oldKey envelope is gone; the newKey envelope is what was
    // just written). Two entries instead of one — the chain still
    // captures the rename intent via the matching ts + actor.
    if (this.ledger) {
      await this.ledger.append({
        op: 'delete',
        collection: this.collName,
        id: oldKey,
        version: existing._v,
        actor: this.keyring.userId,
        payloadHash: await envelopePayloadHash(existing),
      })
      await this.ledger.append({
        op: 'put',
        collection: this.collName,
        id: newKey,
        version: 1,
        actor: this.keyring.userId,
        payloadHash: await envelopePayloadHash(newEnvelope),
      })
    }
  }

  /**
   * List all entries in this dictionary.
   *
   * @returns Array of `{ key, labels }` objects.
   */
  async list(): Promise<DictEntry[]> {
    const keys = await this.adapter.list(this.compartmentName, this.collName)
    const entries: DictEntry[] = []
    for (const key of keys) {
      const envelope = await this.adapter.get(
        this.compartmentName,
        this.collName,
        key,
      )
      // #647 fix wave 1 — a delete-marker row is a removed key, not a live entry: exclude it
      // from the listing and drop any stale cache entry a prior warm may have left under it.
      if (!envelope || isDeleteMarker(envelope)) { this._syncCache.delete(key); continue }
      const entry = await this.decryptEntry(envelope)
      entries.push(entry)
      // Warm the synchronous cache
      this._syncCache.set(key, entry)
    }
    return entries
  }

  /**
   * Resolve a key to its label for the given locale.
   *
   * Used by the collection's locale-aware read path to populate
   * `<field>Label` virtual fields. Returns `undefined` when the
   * key doesn't exist or has no label for the requested locale
   * (after exhausting the fallback chain).
   */
  async resolveLabel(
    key: string,
    locale: string,
    fallback?: string | readonly string[],
  ): Promise<string | undefined> {
    const labels = await this.get(key as Keys)
    if (!labels) return undefined

    // Try primary locale
    if (labels[locale] !== undefined) return labels[locale]

    // Try fallback chain
    const chain = Array.isArray(fallback) ? (fallback as readonly string[]) : fallback ? [fallback as string] : []
    for (const fb of chain) {
      if (fb === 'any') {
        // Return any available label
        const any = Object.values(labels)[0]
        if (any !== undefined) return any
      } else if (labels[fb] !== undefined) {
        return labels[fb]
      }
    }

    return undefined
  }
}

// Compat alias — existing importers of `DictionaryHandle` (the pre-#650
// name) keep compiling unchanged. `via/i18n/dictionary.ts` re-exports
// this same binding for one release.
export { LookupHandle as DictionaryHandle }
