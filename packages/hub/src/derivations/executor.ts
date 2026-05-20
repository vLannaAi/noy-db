import { DerivationOutputShapeError } from '../errors.js'
import type { DerivationContext, DerivationStrategy, DerivedFromMeta } from './types.js'

export interface RunResult {
  outputs: Record<string, OutputResult>
  failed: boolean
}

export interface OutputResult {
  value: Record<string, unknown>
  ok: boolean
  error?: Error
  /**
   * `true` when an optional output (#144) returned `null` /
   * `undefined`. The caller deletes any previously-emitted output at
   * the same id (mirrors "tombstone for derived data"); a never-emitted
   * output is a silent no-op. `ok: true` because skipping is a
   * successful outcome, not a failure — the executor still ran and
   * the strategy hash is honoured.
   */
  skipped?: boolean
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
      if (value === undefined || value === null) {
        if (outSpec.optional === true) {
          // #144: optional output explicitly skipped. Mark for caller
          // so any prior-emitted output at this id can be deleted.
          outputs[key] = { value: {}, ok: true, skipped: true }
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
        value: { ...(value as Record<string, unknown>), _derivedFrom: meta },
        ok: true,
      }
    }
    return { outputs, failed: false }
  },
}
