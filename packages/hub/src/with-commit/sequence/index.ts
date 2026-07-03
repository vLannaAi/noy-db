/**
 * Atomic sequence primitive — online-coordinated gap-free numbering.
 *
 * `vault.sequence('invoice-2026').next()` returns 1, 2, 3, … with no
 * gaps and no duplicates, even under concurrent callers. Each named
 * sequence is an independent counter record at `_sequences/<name>`,
 * incremented with an optimistic compare-and-swap retry loop — the same
 * proven pattern as the ledger head (`history/ledger/store.ts`).
 *
 * **Explicitly online-only.** Gap-free numbering requires single-authority
 * serialization, which an offline / non-CAS store cannot provide. `next()`
 * throws {@link SequenceOfflineError} unless the backing store advertises
 * `capabilities.casAtomic`. This is a deliberate, honest wall — an offline
 * writer cannot safely allocate a global sequence number.
 *
 * Note on "gap-free": the *sequence* is gap-free (each `next()` yields a
 * unique, +1 value). If a caller discards a value without using it, that
 * is a gap in *usage*, not in the sequence — assign each `next()` result
 * to its record in the same operation.
 */

import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import { encrypt, decrypt, type EnclaveKey } from '../../kernel/enclave/index.js'
import { ConflictError, SequenceContentionError, SequenceOfflineError, ValidationError } from '../../kernel/errors.js'

// Capability opt-in seam (S4): `vault.sequence()` builds its CAS store through
// the sequenceStrategy, so it throws SequenceNotEnabledError unless opted in.
export { withSequence } from './active.js'
export { NO_SEQUENCE, type SequenceStrategy } from './strategy.js'
export { SequenceNotEnabledError } from '../../kernel/errors.js'

export const SEQUENCE_COLLECTION = '_sequences'
// A sequence is a single hot CAS row — higher contention than a ledger
// append. A larger budget + jittered backoff absorbs moderate concurrency;
// a genuine burst beyond this surfaces SequenceContentionError so the
// caller can retry / queue (the honest online-only contract).
const MAX_NEXT_ATTEMPTS = 16

interface SequenceState {
  value: number
}

/** Options for `SequenceHandle.next`. Deferred-numbering series use `for`; the CAS counter ignores all of these. */
export interface NextOptions {
  /** Deferred mode: the record id to number. Ignored by the CAS counter. */
  readonly for?: string
  /** Deferred mode: reject after this many ms if still unsealed (reserved; not yet enforced in this slice). */
  readonly timeoutMs?: number
}

/**
 * Partitioning for a CAS sequence. A partitioned sequence is an
 * independent counter scoped to one tuple of values — e.g.
 * `sequence('invoice', { partition: [2026, 'EU'] })` numbers EU-2026 invoices
 * separately from `[2026, 'US']` and from the bare `invoice` series.
 *
 * Partition components are URI-encoded (so `/`, null bytes and other
 * separators in a value can never collide with the structural separators) and
 * `'/'`-joined, then appended to the series with a null-byte (`\x00`)
 * separator. The null byte is illegal in a plain series name, which guarantees
 * a partitioned key is always disjoint from any unpartitioned series.
 */
export interface SequenceOptions {
  /** Partition tuple. Each component is URI-encoded and `'/'`-joined. */
  readonly partition?: readonly (string | number)[]
  /**
   * Render template for the serial string. When set, `vault.sequence`
   * returns a {@link FormattedSequenceHandle} whose `next()` resolves to
   * `{ serial, formatted }`. Tokens:
   * - `{seq}` — the allocated integer
   * - `{seq:0N}` — zero-padded to width N (e.g. `{seq:04}` → `0001`)
   * - `{partition.i}` — the i-th `partition` component (original value)
   *
   * Any other token, or a `{partition.i}` index beyond the supplied
   * `partition`, throws `ValidationError` at `vault.sequence()` construction.
   * Per-partition reset is inherent: a new partition tuple starts at 1.
   */
  readonly format?: string
}

/**
 * A formatted sequence handle. Identical to {@link SequenceHandle}
 * except `next()` also returns the rendered `formatted` string. `peek()` /
 * `seedTo()` operate on the underlying integer counter, unchanged.
 */
export interface FormattedSequenceHandle {
  /** Allocate the next value and return it with its rendered serial string. */
  next(opts?: NextOptions): Promise<{ serial: number; formatted: string }>
  /** Read the current integer value without allocating. Returns 0 if never used. */
  peek(): Promise<number>
  /** Set-if-greater on the underlying integer counter. See {@link SequenceHandle.seedTo}. */
  seedTo(n: number): Promise<void>
}

// Matches a single `{...}` token with no nested braces.
const SEQ_FORMAT_TOKEN = /\{([^{}]*)\}/g
const SEQ_PAD_TOKEN = /^seq:0(\d+)$/
const SEQ_PARTITION_TOKEN = /^partition\.(\d+)$/

/**
 * Validate a sequence `format` against the supplied partition and return a
 * pure `(serial) => string` renderer. Eager validation: every token is
 * checked now, so a bad pattern throws `ValidationError` at construction —
 * never at `next()` time.
 */
export function compileSequenceFormat(
  format: string,
  series: string,
  partition: readonly (string | number)[] | undefined,
): (serial: number) => string {
  const parts = partition ?? []
  for (const m of format.matchAll(SEQ_FORMAT_TOKEN)) {
    const token = m[1] ?? ''
    if (token === 'seq') continue
    if (SEQ_PAD_TOKEN.test(token)) continue
    const partMatch = SEQ_PARTITION_TOKEN.exec(token)
    if (partMatch) {
      const idx = Number(partMatch[1])
      if (idx >= parts.length) {
        throw new ValidationError(
          `sequence("${series}"): format token "{${token}}" references partition index ${idx}, ` +
            `but only ${parts.length} partition component(s) were supplied.`,
        )
      }
      continue
    }
    throw new ValidationError(
      `sequence("${series}"): format contains unknown token "{${token}}". ` +
        `Accepted tokens: {seq}, {seq:0N}, {partition.i}.`,
    )
  }
  return (serial: number): string =>
    format.replace(SEQ_FORMAT_TOKEN, (full, token: string) => {
      if (token === 'seq') return String(serial)
      const padMatch = SEQ_PAD_TOKEN.exec(token)
      if (padMatch) return String(serial).padStart(Number(padMatch[1]), '0')
      const partMatch = SEQ_PARTITION_TOKEN.exec(token)
      if (partMatch) return String(parts[Number(partMatch[1])])
      return full // unreachable — validated above
    })
}

/**
 * Resolve the CAS storage key for a (series, partition) pair.
 *
 * With no partition the key is `series` verbatim. With a partition the key is
 * `${series}\x00${parts}` where `parts` is each component passed through
 * `encodeURIComponent(String(part))` and `'/'`-joined. The null-byte separator
 * is illegal in a plain series name, so partitioned keys never collide with
 * unpartitioned ones; URI-encoding keeps any component containing `/` distinct
 * from a multi-component partition.
 *
 * @throws {ValidationError} if any partition component is empty after `String()`
 *   or is a non-finite number (`NaN`, `±Infinity`).
 */
export function resolveSequenceKey(series: string, opts?: SequenceOptions): string {
  const partition = opts?.partition
  if (!partition || partition.length === 0) return series
  const parts = partition.map((p) => {
    if (typeof p === 'number' && !Number.isFinite(p)) {
      throw new ValidationError(`sequence partition component must be a finite number, got ${p}`)
    }
    const s = String(p)
    if (s === '') {
      throw new ValidationError('sequence partition component must not be empty')
    }
    return encodeURIComponent(s)
  })
  return `${series}\x00${parts.join('/')}`
}

export interface SequenceHandle {
  /** Atomically allocate and return the next value (1, 2, 3, …). Deferred series resolve at the next pass. */
  next(opts?: NextOptions): Promise<number>
  /** Read the current value without allocating. Returns 0 if never used. */
  peek(): Promise<number>
  /**
   * Set-if-greater: advance the counter to at least `n`. A no-op if the
   * current value is already `>= n` (so it never rewinds), and `seedTo(0)` is
   * a no-op. Idempotent and CAS-safe under concurrent `next()` / `seedTo()`.
   *
   * Use after a bundle / CSV import to fast-forward the counter past the
   * highest imported serial, so subsequent `next()` calls cannot re-use a
   * number that is already on a record.
   *
   * Online-only: throws {@link SequenceOfflineError} on a non-CAS store.
   */
  seedTo(n: number): Promise<void>
}

async function sleepBackoff(attempt: number): Promise<void> {
  // Exponential backoff with full jitter to break the thundering herd
  // when many writers contend on the same counter row.
  const ceil = Math.min(2 ** attempt, 32)
  const ms = Math.floor(Math.random() * ceil)
  await new Promise((r) => setTimeout(r, ms))
}

/** Per-call context the vault assembles to build a {@link SequenceStore}. */
export interface SequenceStoreOptions {
  adapter: NoydbStore
  vault: string
  encrypted: boolean
  getDEK: (collectionName: string) => Promise<EnclaveKey>
  actor: string
}

export class SequenceStore {
  private readonly adapter: NoydbStore
  private readonly vault: string
  private readonly encrypted: boolean
  private readonly getDEK: (collectionName: string) => Promise<EnclaveKey>
  private readonly actor: string
  /**
   * Memoized DEK promise. The `_sequences` collection DEK is created on
   * first access; without sharing one promise, a burst of concurrent
   * `next()` calls would each trigger DEK creation and diverge (one
   * writer's ciphertext unreadable by another). One shared promise → one
   * DEK.
   */
  private dekPromise: Promise<EnclaveKey> | null = null

  constructor(opts: SequenceStoreOptions) {
    this.adapter = opts.adapter
    this.vault = opts.vault
    this.encrypted = opts.encrypted
    this.getDEK = opts.getDEK
    this.actor = opts.actor
  }

  /** A handle bound to one sequence name. */
  handle(name: string): SequenceHandle {
    return {
      next: () => this.next(name),
      peek: () => this.peek(name),
      seedTo: (n) => this.seedTo(name, n),
    }
  }

  private assertOnline(): void {
    if (this.adapter.capabilities?.casAtomic !== true) {
      throw new SequenceOfflineError()
    }
  }

  private dek(): Promise<EnclaveKey> {
    if (!this.dekPromise) this.dekPromise = this.getDEK(SEQUENCE_COLLECTION)
    return this.dekPromise
  }

  private async read(name: string): Promise<{ env: EncryptedEnvelope | null; value: number }> {
    const env = await this.adapter.get(this.vault, SEQUENCE_COLLECTION, name)
    if (!env) return { env: null, value: 0 }
    const json = this.encrypted ? await decrypt(env._iv, env._data, await this.dek()) : env._data
    const state = JSON.parse(json) as SequenceState
    return { env, value: state.value }
  }

  private async encryptState(state: SequenceState, version: number): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(state)
    if (!this.encrypted) {
      return { _noydb: NOYDB_FORMAT_VERSION, _v: version, _ts: new Date().toISOString(), _iv: '', _data: json, _by: this.actor }
    }
    const { iv, data } = await encrypt(json, await this.dek())
    return { _noydb: NOYDB_FORMAT_VERSION, _v: version, _ts: new Date().toISOString(), _iv: iv, _data: data, _by: this.actor }
  }

  async peek(name: string): Promise<number> {
    return (await this.read(name)).value
  }

  async next(name: string): Promise<number> {
    this.assertOnline()
    let lastConflict: ConflictError | undefined
    for (let attempt = 0; attempt < MAX_NEXT_ATTEMPTS; attempt++) {
      const { env, value } = await this.read(name)
      const nextValue = value + 1
      const expectedVersion = env?._v ?? 0 // 0 ≡ "must not yet exist" (create)
      const envelope = await this.encryptState({ value: nextValue }, expectedVersion + 1)
      try {
        await this.adapter.put(this.vault, SEQUENCE_COLLECTION, name, envelope, expectedVersion)
        return nextValue
      } catch (err) {
        if (err instanceof ConflictError) {
          lastConflict = err
          if (attempt < MAX_NEXT_ATTEMPTS - 1) await sleepBackoff(attempt)
          continue
        }
        throw err
      }
    }
    void lastConflict
    throw new SequenceContentionError(name, MAX_NEXT_ATTEMPTS)
  }

  async seedTo(name: string, n: number): Promise<void> {
    this.assertOnline()
    if (n <= 0) return // set-if-greater: 0 (and any non-positive seed) is a no-op
    let lastConflict: ConflictError | undefined
    for (let attempt = 0; attempt < MAX_NEXT_ATTEMPTS; attempt++) {
      const { env, value } = await this.read(name)
      if (value >= n) return // already at or past the floor — no write, idempotent
      const expectedVersion = env?._v ?? 0 // 0 ≡ "must not yet exist" (create)
      const envelope = await this.encryptState({ value: n }, expectedVersion + 1)
      try {
        await this.adapter.put(this.vault, SEQUENCE_COLLECTION, name, envelope, expectedVersion)
        return
      } catch (err) {
        if (err instanceof ConflictError) {
          lastConflict = err
          if (attempt < MAX_NEXT_ATTEMPTS - 1) await sleepBackoff(attempt)
          continue
        }
        throw err
      }
    }
    void lastConflict
    throw new SequenceContentionError(name, MAX_NEXT_ATTEMPTS)
  }
}
