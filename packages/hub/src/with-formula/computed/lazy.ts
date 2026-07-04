/**
 * Lazy loader for the computed-fields engine (#553).
 *
 * The `computed` declaration on `collection({ … })` is the opt-in unit;
 * the engine's only kernel consultation is the (async) write pipeline,
 * so it loads on the first computed-declared put and stays out of the
 * floor bundle otherwise. Cached after first load — mirrors the
 * deferred-load pattern used for guards/derivations.
 */
import type * as ComputedModule from './index.js'

type EvalComputedFieldsFn = typeof ComputedModule.evalComputedFields

let fn: EvalComputedFieldsFn | null = null

export async function loadEvalComputedFields(): Promise<EvalComputedFieldsFn> {
  fn ??= (await import('./index.js')).evalComputedFields
  return fn
}
