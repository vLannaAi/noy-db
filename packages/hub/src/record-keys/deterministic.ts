/**
 * Deterministic-index lookups (`findByDet` / `queryByDet`), lifted off the
 * `Collection` god-object (Phase 5 A1 of the microkernel refactoring).
 *
 * A collection that declares `deterministicFields` stamps a deterministic
 * AES-GCM ciphertext for each such field on the envelope's `_det` slot at write
 * time (the encrypt side lives in {@link RecordCodec.encryptRecord}). These
 * helpers are the READ side: recompute the deterministic ciphertext for a query
 * value and scan the adapter for envelopes whose `_det[field]` matches — no
 * record bodies are decrypted during the scan, which is the whole point of a
 * deterministic index.
 *
 * Both functions take a small {@link DeterministicContext} (the exact `this.*`
 * the moving methods touched) instead of `this`, mirroring the `record-keys/`
 * siblings. Behaviour is byte-identical to the inline code they replaced.
 *
 * Internal subsystem — not exported as a `@noy-db/hub/*` subpath.
 */
import { encryptDeterministic } from '../crypto.js'
import type { NoydbStore } from '../types.js'
import type { RecordCodec } from './record-codec.js'

/** Everything the moving deterministic-index methods touched on `this.*`. */
export interface DeterministicContext<T> {
  /** Collection name — the deterministic-encryption AAD scope. */
  readonly name: string
  /** Vault namespace the records live under. */
  readonly vault: string
  /** The ciphertext store (scanned envelope-by-envelope). */
  readonly adapter: NoydbStore
  /** Declared deterministic-index fields, or null when the feature is off. */
  readonly deterministicFields: ReadonlySet<string> | null
  /** False on plaintext collections — det lookups are encrypted-only. */
  readonly storeCiphertext: boolean
  /** The collection DEK resolver. */
  getDEK(): Promise<CryptoKey>
  /** The record codec — decrypts a matched envelope to T. */
  readonly codec: RecordCodec<T>
}

/** Recompute the deterministic ciphertext target for a query value. */
async function detTarget<T>(ctx: DeterministicContext<T>, field: string, value: unknown): Promise<string> {
  const dek = await ctx.getDEK()
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value)
  const { iv, data } = await encryptDeterministic(plaintext, dek, `${ctx.name}/${field}`)
  return `${iv}:${data}`
}

function assertDetField<T>(ctx: DeterministicContext<T>, field: string, method: string): void {
  if (!ctx.deterministicFields || !ctx.deterministicFields.has(field)) {
    throw new Error(
      `Collection "${ctx.name}": field "${field}" is not declared in deterministicFields`,
    )
  }
  if (!ctx.storeCiphertext) {
    throw new Error(
      `Collection "${ctx.name}": ${method} is only meaningful on encrypted collections`,
    )
  }
}

/**
 * Find the first record whose deterministic field matches the given plaintext.
 * Returns `null` when no match exists.
 *
 * Reads every envelope via the adapter and compares the stored `_det[field]` to
 * a freshly computed deterministic ciphertext — no record bodies are decrypted
 * during the search.
 *
 * Throws when the field is not declared in `deterministicFields`, so a typo
 * fails loudly at the call site rather than silently returning null forever.
 */
export async function findByDet<T>(ctx: DeterministicContext<T>, field: string, value: unknown): Promise<T | null> {
  assertDetField(ctx, field, 'findByDet')
  const target = await detTarget(ctx, field, value)

  const ids = await ctx.adapter.list(ctx.vault, ctx.name)
  for (const id of ids) {
    const env = await ctx.adapter.get(ctx.vault, ctx.name, id)
    if (!env || !env._det) continue
    if (env._det[field] === target) {
      return ctx.codec.decryptRecord(env)
    }
  }
  return null
}

/**
 * Return every record whose deterministic field matches. Same semantics as
 * {@link findByDet} but without the short-circuit.
 */
export async function queryByDet<T>(ctx: DeterministicContext<T>, field: string, value: unknown): Promise<T[]> {
  assertDetField(ctx, field, 'queryByDet')
  const target = await detTarget(ctx, field, value)

  const ids = await ctx.adapter.list(ctx.vault, ctx.name)
  const matches: T[] = []
  for (const id of ids) {
    const env = await ctx.adapter.get(ctx.vault, ctx.name, id)
    if (!env || !env._det) continue
    if (env._det[field] === target) {
      const rec = await ctx.codec.decryptRecord(env)
      if (rec !== null) matches.push(rec) // skip tombstone (defensive)
    }
  }
  return matches
}
