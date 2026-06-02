import { DerivationCapExceededError, DerivationOutputShapeError } from '../errors.js'
import type { DerivationContext, DerivationStrategy, DerivedFromMeta } from './types.js'

export interface RunResult {
  outputs: Record<string, OutputResult>
  failed: boolean
}

/**
 * Per-output result of a strategy invocation. Discriminated by
 * `kind`:
 *
 * - `record` — the existing v1 shape: one value (or a "skipped"
 *   marker if the output was optional and `derive` returned null).
 * - `array` — a list of `(key, value)` entries.
 *   The caller diffs these against the previously-emitted key set
 *   (loaded from the fanout sidecar) to compute deletes + upserts.
 */
export type OutputResult =
  | RecordOutputResult
  | ArrayOutputResult
  | FailedOutputResult

export interface RecordOutputResult {
  kind: 'record'
  value: Record<string, unknown>
  ok: true
  /**
   * `true` when an optional output returned `null` /
   * `undefined`. The caller deletes any previously-emitted output at
   * the same id (mirrors "tombstone for derived data"); a never-emitted
   * output is a silent no-op. `ok: true` because skipping is a
   * successful outcome, not a failure.
   */
  skipped?: boolean
}

export interface ArrayOutputResult {
  kind: 'array'
  ok: true
  /** One `(key, value)` per derived row. Empty array means "all prior outputs for this source go." */
  entries: ReadonlyArray<{ readonly key: string; readonly value: Record<string, unknown> }>
}

export interface FailedOutputResult {
  kind: 'failed'
  ok: false
  error: Error
  /** Always empty on failure; present so consumers don't have to narrow. */
  value: Record<string, unknown>
}

/**
 * Stateless functions that execute a derivation strategy. Persistence
 * (encrypt + store.put) is the caller's job — typically
 * `DerivationRegistry.onSourceWrite` which iterates run() results and
 * writes each output via `Collection.put`.
 */
export const DerivationExecutor = {
  /**
   * Run `derive` once, validate output shape against the spec, stamp
   * `_derivedFrom` onto every output. Returns per-output success or
   * failure; throws only for shape mismatches (a contract violation).
   */
  async run<
    TSource extends Record<string, unknown>,
    TOutputs extends Record<string, Record<string, unknown>>,
  >(
    strategy: DerivationStrategy<TSource, TOutputs>,
    source: TSource & { id: string },
    sourceVersion: number,
    strategyHash: string,
    ctx: DerivationContext,
  ): Promise<RunResult> {
    const outputs: Record<string, OutputResult> = {}
    let derived: Partial<TOutputs>

    try {
      derived = await Promise.resolve(strategy.derive(source as TSource, ctx))
    } catch (err) {
      for (const key of Object.keys(strategy.outputs)) {
        outputs[key] = {
          kind: 'failed',
          value: {},
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        }
      }
      return { outputs, failed: true }
    }

    const meta: DerivedFromMeta = {
      source: strategy.source,
      sourceId: source.id,
      sourceVersion,
      derivedAt: new Date().toISOString(),
      strategyHash,
    }

    for (const key of Object.keys(strategy.outputs)) {
      const outSpec = strategy.outputs[key]
      if (!outSpec) continue
      const value = (derived as Record<string, unknown>)[key]

      // ── Array-shape branch ─────────────────────────────────────
      if (outSpec.shape === 'array') {
        if (value === undefined || value === null) {
          // Treat null/undefined as "empty array" — clears all prior
          // outputs for this (source, output) pair. The caller's
          // diff turns that into deletes.
          outputs[key] = { kind: 'array', ok: true, entries: [] }
          continue
        }
        if (!Array.isArray(value)) {
          throw new DerivationOutputShapeError(
            key,
            `shape 'array' expects an array, got ${typeof value}`,
          )
        }
        const maxFanout = outSpec.maxFanout ?? 64
        if (value.length > maxFanout) {
          throw new DerivationCapExceededError(key, value.length, maxFanout)
        }
        const entries: Array<{ key: string; value: Record<string, unknown> }> = []
        const seenKeys = new Set<string>()
        for (let i = 0; i < value.length; i++) {
          const row = value[i] as unknown
          if (row === null || typeof row !== 'object') {
            throw new DerivationOutputShapeError(
              key,
              `array member at index ${i} must be a non-null object (got ${row === null ? 'null' : typeof row})`,
            )
          }
          let derivedKey: string
          try {
            derivedKey = outSpec.key(row as Record<string, unknown>)
          } catch (err) {
            throw new DerivationOutputShapeError(
              key,
              `key extractor threw on array member at index ${i}: `
              + (err instanceof Error ? err.message : String(err)),
            )
          }
          if (typeof derivedKey !== 'string' || derivedKey.length === 0) {
            throw new DerivationOutputShapeError(
              key,
              `key extractor returned ${typeof derivedKey === 'string' ? 'empty string' : typeof derivedKey} at index ${i}; expected non-empty string`,
            )
          }
          if (seenKeys.has(derivedKey)) {
            throw new DerivationOutputShapeError(
              key,
              `duplicate key "${derivedKey}" in array output (index ${i}); each derived row must have a unique key within a single derive() invocation`,
            )
          }
          seenKeys.add(derivedKey)
          entries.push({
            key: derivedKey,
            value: { ...(row as Record<string, unknown>), _derivedFrom: meta },
          })
        }
        outputs[key] = { kind: 'array', ok: true, entries }
        continue
      }

      // ── Record-shape branch (existing v1 behavior) ─────────────
      if (value === undefined || value === null) {
        if (outSpec.optional === true) {
          // Optional output explicitly skipped. Mark for caller
          // so any prior-emitted output at this id can be deleted.
          outputs[key] = { kind: 'record', value: {}, ok: true, skipped: true }
          continue
        }
        throw new DerivationOutputShapeError(
          key,
          `expected object, got ${value === undefined ? 'undefined' : 'null'}`,
        )
      }
      if (typeof value !== 'object') {
        throw new DerivationOutputShapeError(
          key,
          `expected object, got ${typeof value}`,
        )
      }
      outputs[key] = {
        kind: 'record',
        value: { ...(value as Record<string, unknown>), _derivedFrom: meta },
        ok: true,
      }
    }
    return { outputs, failed: false }
  },
}
