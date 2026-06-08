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

import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { encrypt, decrypt } from '../crypto.js'
import { ConflictError, SequenceContentionError, SequenceOfflineError } from '../errors.js'

export const SEQUENCE_COLLECTION = '_sequences'
// A sequence is a single hot CAS row — higher contention than a ledger
// append. A larger budget + jittered backoff absorbs moderate concurrency;
// a genuine burst beyond this surfaces SequenceContentionError so the
// caller can retry / queue (the honest online-only contract).
const MAX_NEXT_ATTEMPTS = 16

interface SequenceState {
  value: number
}

export interface SequenceHandle {
  /** Atomically allocate and return the next value (1, 2, 3, …). */
  next(): Promise<number>
  /** Read the current value without allocating. Returns 0 if never used. */
  peek(): Promise<number>
}

async function sleepBackoff(attempt: number): Promise<void> {
  // Exponential backoff with full jitter to break the thundering herd
  // when many writers contend on the same counter row.
  const ceil = Math.min(2 ** attempt, 32)
  const ms = Math.floor(Math.random() * ceil)
  await new Promise((r) => setTimeout(r, ms))
}

export class SequenceStore {
  private readonly adapter: NoydbStore
  private readonly vault: string
  private readonly encrypted: boolean
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>
  private readonly actor: string
  /**
   * Memoized DEK promise. The `_sequences` collection DEK is created on
   * first access; without sharing one promise, a burst of concurrent
   * `next()` calls would each trigger DEK creation and diverge (one
   * writer's ciphertext unreadable by another). One shared promise → one
   * DEK.
   */
  private dekPromise: Promise<CryptoKey> | null = null

  constructor(opts: {
    adapter: NoydbStore
    vault: string
    encrypted: boolean
    getDEK: (collectionName: string) => Promise<CryptoKey>
    actor: string
  }) {
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
    }
  }

  private assertOnline(): void {
    if (this.adapter.capabilities?.casAtomic !== true) {
      throw new SequenceOfflineError()
    }
  }

  private dek(): Promise<CryptoKey> {
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
}
