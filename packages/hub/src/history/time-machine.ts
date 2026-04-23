/**
 * Time-machine queries — point-in-time reads reconstructed from the
 * existing history + ledger infrastructure (v0.16 #215).
 *
 * ## Usage
 *
 * ```ts
 * const vault = await db.openVault('acme', { passphrase })
 * const q1End = vault.at('2026-03-31T23:59:59Z')
 * const invoice = await q1End.collection<Invoice>('invoices').get('inv-001')
 * // → the record as it stood at the close of Q1 2026
 * ```
 *
 * ## How it works
 *
 * Every write path already fans out into two persistence lanes:
 *
 * 1. `saveHistory(...)` persists a **full encrypted envelope snapshot**
 *    per version under the `_history` collection (one envelope per
 *    version, keyed by `{collection}:{id}:{paddedVersion}`). Each
 *    envelope carries its own `_ts` (the write timestamp).
 * 2. `ledger.append(...)` appends a hash-chained audit entry that
 *    records the `op` (put / delete), `version`, and `ts`.
 *
 * Reconstruction at a target timestamp T is therefore:
 *
 * - Find the newest history envelope for `(collection, id)` whose
 *   `_ts ≤ T` — that's the state the record was in at T.
 * - Check the ledger for any `op: 'delete'` entry for the same
 *   `(collection, id)` with `entry.ts` in `(latestEnvelope._ts, T]` —
 *   if present, the record was deleted before T, so return `null`.
 * - Decrypt the surviving envelope with the current collection DEK
 *   (DEKs are per-collection but stable across versions — the same
 *   key encrypts v1 and v15 of a record).
 *
 * No delta replay. The existing `history.ts` module already stores
 * complete snapshots; we just pick the right one.
 *
 * ## Read-only contract
 *
 * Every write method on `CollectionInstant` throws
 * {@link ReadOnlyAtInstantError}. A historical view is a *read*
 * surface — mutating the past would require either a branch/shadow
 * mechanism (tracked under v0.16 #217 shadow vaults) or a rewrite of
 * history, which breaks the ledger's tamper-evidence guarantee.
 *
 * @module
 */
import type { EncryptedEnvelope, NoydbStore } from '../types.js'
import type { LedgerStore } from './ledger/store.js'
import { getHistory } from './history.js'
import { decrypt } from '../crypto.js'
import { ReadOnlyAtInstantError } from '../errors.js'

/**
 * Narrow view of a {@link Vault}'s internals that
 * {@link VaultInstant} needs. Passed in by `Vault.at()` rather than
 * constructed here so all crypto + adapter access stays inside the
 * Vault class.
 *
 * Not exported from the public barrel — consumers should get a
 * `VaultInstant` via `vault.at(ts)`, never by constructing one
 * directly.
 */
export interface VaultEngine {
  readonly adapter: NoydbStore
  /** Vault name (the compartment). */
  readonly name: string
  /**
   * `true` when the vault was opened with a passphrase (the normal
   * case). `false` in plaintext-mode vaults (`encrypt: false`) — in
   * that case `envelope._data` is raw JSON and we skip the DEK lookup.
   */
  readonly encrypted: boolean
  /**
   * Resolves the DEK used to decrypt a given collection's envelopes.
   * Not called when `encrypted` is false.
   */
  getDEK(collection: string): Promise<CryptoKey>
  /**
   * Lazily-initialised ledger. We consult it to detect deletes that
   * happened between the latest history snapshot and the target
   * timestamp. `null` when history is disabled for this vault — in
   * that case time-machine reads fall back to history-only
   * reconstruction (which may miss deletes).
   */
  getLedger(): LedgerStore | null
}

/**
 * A vault at a fixed instant. Produced by `vault.at(timestamp)`.
 * Carries no session state of its own — every read is a fresh
 * lookup through the vault's adapter.
 *
 * Cheap to construct; safe to throw away. Create one per query.
 */
export class VaultInstant {
  constructor(
    private readonly engine: VaultEngine,
    /** Fully-resolved target timestamp (ISO-8601 UTC). */
    public readonly timestamp: string,
  ) {}

  /** Get a point-in-time view of a collection. */
  collection<T = unknown>(name: string): CollectionInstant<T> {
    return new CollectionInstant<T>(this.engine, this.timestamp, name)
  }
}

/**
 * A read-only collection view anchored to a past instant.
 *
 * Every write method throws {@link ReadOnlyAtInstantError} — see the
 * module docstring for why. The read surface is intentionally smaller
 * than the live {@link Collection}: `get` and `list` cover the
 * "what did the books look like on date X" use case without pulling
 * in the full query DSL / joins / aggregates at this stage. Follow-up
 * work tracked under v0.16.
 */
export class CollectionInstant<T = unknown> {
  constructor(
    private readonly engine: VaultEngine,
    private readonly targetTs: string,
    public readonly name: string,
  ) {}

  /**
   * Return the record as it existed at the target timestamp, or
   * `null` if the record had not been created yet or had already been
   * deleted by then.
   */
  async get(id: string): Promise<T | null> {
    const envelope = await this.resolveEnvelope(id)
    if (!envelope) return null
    const plaintext = this.engine.encrypted
      ? await decrypt(envelope._iv, envelope._data, await this.engine.getDEK(this.name))
      : envelope._data
    return JSON.parse(plaintext) as T
  }

  /**
   * IDs of records that existed (had at least one `put` and were not
   * subsequently deleted) at the target timestamp.
   *
   * Implemented as a linear scan over history + ledger. Performance
   * is bounded by total history size (not live-vault size), so the
   * memory-first vault-scale cap (1K–50K records × average history
   * depth) still applies.
   */
  async list(): Promise<string[]> {
    const historyIds = await collectHistoryIds(this.engine.adapter, this.engine.name, this.name)
    const liveIds = await this.engine.adapter.list(this.engine.name, this.name)
    const candidateIds = new Set<string>([...historyIds, ...liveIds])
    const alive: string[] = []
    for (const id of candidateIds) {
      const env = await this.resolveEnvelope(id)
      if (env) alive.push(id)
    }
    return alive.sort()
  }

  // ── write guards ───────────────────────────────────────────────────

  async put(_id: string, _record: T): Promise<never> {
    throw new ReadOnlyAtInstantError('put', this.targetTs)
  }
  async delete(_id: string): Promise<never> {
    throw new ReadOnlyAtInstantError('delete', this.targetTs)
  }
  async update(_id: string, _patch: Partial<T>): Promise<never> {
    throw new ReadOnlyAtInstantError('update', this.targetTs)
  }

  // ── internals ─────────────────────────────────────────────────────

  /**
   * Return the envelope that represents the record's state at
   * `targetTs`, accounting for deletes. `null` if the record didn't
   * exist at that instant.
   *
   * ## Why we use the ledger as the authoritative timeline
   *
   * The per-version history snapshots saved by `saveHistory()` do
   * carry a `_ts` field, but that timestamp is the moment the
   * snapshot was *captured* (i.e. the instant right before the
   * subsequent overwrite), not the original write time. The ledger,
   * by contrast, records `ts` at the moment of each `put` / `delete`
   * — it's the only source that tracks the real timeline. So:
   *
   *   1. Walk the ledger; find the latest entry for `(collection, id)`
   *      with `ts ≤ targetTs`.
   *   2. If that entry is a `delete`, the record was gone at the
   *      target instant — return null.
   *   3. Otherwise it's a `put` with a specific `version`. Load the
   *      envelope for that version from history, falling back to the
   *      live collection for the most recent version.
   *
   * ## Fallback when the ledger is disabled
   *
   * If the vault has history disabled, `getLedger()` returns null and
   * we fall back to comparing envelope `_ts` fields. This is
   * approximate and gets the *last write* right but may confuse the
   * intermediate versions; adopters needing accurate time-machine
   * reads should leave history enabled.
   */
  private async resolveEnvelope(id: string): Promise<EncryptedEnvelope | null> {
    const ledger = this.engine.getLedger()
    if (ledger) {
      return this.resolveViaLedger(id, ledger)
    }
    return this.resolveViaEnvelopeTs(id)
  }

  private async resolveViaLedger(id: string, ledger: LedgerStore): Promise<EncryptedEnvelope | null> {
    const entries = await ledger.entries()
    // Entries are already ordered by index which is the mutation order.
    let latest: { op: 'put' | 'delete'; version: number } | null = null
    for (const e of entries) {
      if (e.collection !== this.name || e.id !== id) continue
      if (e.ts > this.targetTs) break   // entries are time-ordered by index
      latest = { op: e.op, version: e.version }
    }
    if (!latest) return null
    if (latest.op === 'delete') return null
    return this.loadVersion(id, latest.version)
  }

  private async resolveViaEnvelopeTs(id: string): Promise<EncryptedEnvelope | null> {
    const history = await getHistory(
      this.engine.adapter, this.engine.name, this.name, id,
    )
    const live = await this.engine.adapter.get(this.engine.name, this.name, id)
    const byVersion = new Map<number, EncryptedEnvelope>()
    for (const e of history) byVersion.set(e._v, e)
    if (live) byVersion.set(live._v, live)
    const sorted = [...byVersion.values()].sort((a, b) =>
      a._ts < b._ts ? 1 : a._ts > b._ts ? -1 : 0,
    )
    return sorted.find((e) => e._ts <= this.targetTs) ?? null
  }

  /**
   * Fetch the envelope for a specific version. The live record (most
   * recent put) lives in the main collection; prior versions live in
   * `_history`. We check live first because the common case after a
   * delete is that we're trying to load the last-live version from
   * history, and skipping live for the current-version case avoids a
   * redundant lookup.
   */
  private async loadVersion(id: string, version: number): Promise<EncryptedEnvelope | null> {
    const live = await this.engine.adapter.get(this.engine.name, this.name, id)
    if (live && live._v === version) return live

    // Direct lookup by (collection, id, version) — avoids scanning all history.
    const historyId = `${this.name}:${id}:${String(version).padStart(10, '0')}`
    return await this.engine.adapter.get(this.engine.name, '_history', historyId)
  }
}

/**
 * Scan the `_history` collection once and collect every distinct
 * `recordId` for the given collection. History keys follow the
 * shape `<collection>:<recordId>:<paddedVersion>`; we split on the
 * last two colons (delimiter-safe because `paddedVersion` is
 * exactly 10 digits).
 */
async function collectHistoryIds(
  adapter: NoydbStore,
  vault: string,
  collection: string,
): Promise<string[]> {
  const all = await adapter.list(vault, '_history')
  const prefix = `${collection}:`
  const seen = new Set<string>()
  for (const key of all) {
    if (!key.startsWith(prefix)) continue
    const lastColon = key.lastIndexOf(':')
    if (lastColon <= prefix.length) continue
    const middle = key.slice(prefix.length, lastColon)
    seen.add(middle)
  }
  return [...seen]
}
