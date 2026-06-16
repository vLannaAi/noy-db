/**
 * @category capability
 * crossShardJoin — co-partitioned + broadcast dimension join for
 * ShardedQuery. Spec:
 * docs/superpowers/specs/2026-06-09-cross-shard-join-design.md.
 *
 * This module owns the BROADCAST half (central, post-merge map-attach)
 * and the leg type definitions. The CO-PARTITIONED half is threaded
 * into the existing intra-vault `.join()` from vault-group.ts — see
 * ShardedQuery.fanoutRecords. join.ts is deliberately untouched.
 */
import { readPath } from '@noy-db/hub/kernel'
import type { JoinStrategy } from '@noy-db/hub/kernel'

/** Public options for `ShardedQuery.crossShardJoin`. */
export interface CrossShardJoinOptions {
  /** Alias key under which the joined same-shard record attaches. */
  readonly as: string
  /** Per-shard row ceiling override (default DEFAULT_JOIN_MAX_ROWS). */
  readonly maxRows?: number
  /** Planner strategy override, passed through to intra-vault `.join()`. */
  readonly strategy?: JoinStrategy
}

/**
 * Minimal structural shape of a broadcast dimension source. A
 * `Collection` satisfies this natively: `list()` hydrates and returns
 * the decoded records. Kept as a one-method interface so plain test
 * sources are trivial to construct.
 */
export interface BroadcastSource {
  list(): Promise<readonly unknown[]>
}

/** Public options for `ShardedQuery.broadcastJoin`. */
export interface BroadcastJoinOptions {
  /** Alias key under which the dimension record attaches. */
  readonly as: string
  /** The shared dimension collection (an opened handle in another vault). */
  readonly from: BroadcastSource
  /** Right-side key to match `field` against. Default 'id'. */
  readonly on?: string
  /** Miss behavior. 'warn' (default) attaches null + one-shot warning; 'cascade' is silent. */
  readonly mode?: 'warn' | 'cascade'
}

/** Internal co-partitioned leg carried on ShardedQuery. */
export interface CoPartitionedLeg {
  readonly field: string
  readonly as: string
  readonly maxRows: number | undefined
  readonly strategy: JoinStrategy | undefined
}

/** Internal broadcast leg carried on ShardedQuery. */
export interface BroadcastLeg {
  readonly field: string
  readonly as: string
  readonly from: BroadcastSource
  readonly on: string
  readonly mode: 'warn' | 'cascade'
}

/**
 * Coerce an unknown key value into a lookup string. Mirrors join.ts's
 * private `coerceRefKey` (string → string; number/bigint → String;
 * else null) — re-implemented locally to keep join.ts literally
 * untouched.
 */
function coerceKey(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/** One-shot warn dedup for broadcast misses, keyed by `field→as`. */
const warnedBroadcastKeys = new Set<string>()
function warnOnceBroadcastMiss(field: string, as: string, key: string): void {
  const dedup = `${field}→${as}:${key}`
  if (warnedBroadcastKeys.has(dedup)) return
  warnedBroadcastKeys.add(dedup)
  console.warn(
    `[klum-db] broadcastJoin: no "${as}" dimension row for ${field}="${key}". ` +
      `Attaching null. Use mode: 'cascade' to silence.`,
  )
}

/** Test-only reset for the broadcast warn dedup set. */
export function resetBroadcastWarnings(): void {
  warnedBroadcastKeys.clear()
}

/**
 * Apply every broadcast leg to a merged row set, centrally. Each leg's
 * source is snapshotted ONCE, indexed by its `on` key, then every row
 * gets `{ [as]: match ?? null }`. Returns fresh top-level objects.
 */
export async function applyBroadcastLegs(
  rows: readonly unknown[],
  legs: readonly BroadcastLeg[],
): Promise<unknown[]> {
  if (legs.length === 0) return [...rows]

  // Build one index per leg (list() once per source).
  const indexes: { leg: BroadcastLeg; map: Map<string, unknown> }[] = []
  for (const leg of legs) {
    const map = new Map<string, unknown>()
    for (const rec of await leg.from.list()) {
      const k = coerceKey(readPath(rec, leg.on))
      if (k !== null && !map.has(k)) map.set(k, rec)
    }
    indexes.push({ leg, map })
  }

  return rows.map((row) => {
    const out = { ...(row as Record<string, unknown>) }
    for (const { leg, map } of indexes) {
      const key = coerceKey(readPath(row, leg.field))
      const match = key === null ? null : map.get(key) ?? null
      if (match === null && leg.mode === 'warn') {
        warnOnceBroadcastMiss(leg.field, leg.as, key ?? '<null>')
      }
      out[leg.as] = match
    }
    return out
  })
}
