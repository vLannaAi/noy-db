/**
 * Deterministic-index lookups (`findByDet` / `queryByDet`).
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
 * Elevated records (_tier > 0) are skipped: invisible to tier-0 scans (#691).
 *
 * Internal service — not exported as a `@noy-db/hub/*` subpath.
 */
import { encryptDeterministic, deriveDeterministicKey, type EnclaveKey } from '../crypto.js'
import type { NoydbStore } from '../../types.js'
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
  getDEK(): Promise<EnclaveKey>
  /** The record codec — decrypts a matched envelope to T. */
  readonly codec: RecordCodec<T>
}

/**
 * Recompute the deterministic ciphertext targets for a query value.
 *
 * L-1: _det migrated to a dedicated HKDF key (salt noydb-det); dual-query
 * keeps pre-migration envelopes findable — they self-heal to the new key on
 * their next write. Index 0 is the current (derived-key) target, index 1 the
 * legacy raw-DEK target. Both are derived once per query call, not per
 * envelope, so the extra derivation is a fixed cost.
 */
async function detTargets<T>(ctx: DeterministicContext<T>, field: string, value: unknown): Promise<[string, string]> {
  const dek = await ctx.getDEK()
  const detKey = await deriveDeterministicKey(dek)
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value)
  const context = `${ctx.name}/${field}`
  const [current, legacy] = await Promise.all([
    encryptDeterministic(plaintext, detKey, context),
    encryptDeterministic(plaintext, dek, context),
  ])
  return [`${current.iv}:${current.data}`, `${legacy.iv}:${legacy.data}`]
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
  const [target, legacyTarget] = await detTargets(ctx, field, value)

  const ids = await ctx.adapter.list(ctx.vault, ctx.name)
  for (const id of ids) {
    const env = await ctx.adapter.get(ctx.vault, ctx.name, id)
    // #691: an elevated record's _det slot is tier-independent (#662 carries
    // it), so it MATCHES — but its key material is tier-wrapped. Skip it
    // explicitly: invisible to tier-0 det scans regardless of cekCache state
    // (a catch-based fix would still leak plaintext, audit-free, in the
    // session that performed the elevate).
    if (!env || !env._det || (env._tier ?? 0) > 0) continue
    if (env._det[field] === target || env._det[field] === legacyTarget) {
      return ctx.codec.decryptRecord({ collection: ctx.name, id }, env)
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
  const [target, legacyTarget] = await detTargets(ctx, field, value)

  const ids = await ctx.adapter.list(ctx.vault, ctx.name)
  const matches: T[] = []
  for (const id of ids) {
    const env = await ctx.adapter.get(ctx.vault, ctx.name, id)
    // #691: skip elevated — see findByDet above
    if (!env || !env._det || (env._tier ?? 0) > 0) continue
    if (env._det[field] === target || env._det[field] === legacyTarget) {
      const rec = await ctx.codec.decryptRecord({ collection: ctx.name, id }, env)
      if (rec !== null) matches.push(rec) // skip tombstone (defensive)
    }
  }
  return matches
}
