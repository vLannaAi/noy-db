/**
 * computed() — the declaration factory for a field whose value is DERIVED
 * from other fields on the same record (#638 Task 7, spec §6). Composes
 * with `via()` (the locked grammar since phase A: `via(computed(fn, { deps,
 * mode }), money('EUR'))`), grouped by `_viaBrand` like every other via
 * feature (`kernel/via-compose.ts#mergeViaFields`).
 *
 * `mode` picks where the function runs:
 *  - `'materialized'` (default) — TODAY's stage-5 write-time eager compute
 *    (`with-formula/computed/index.ts#evalComputedFields`), stored like any
 *    other field. Byte-for-byte the existing `computed: { field: fn }` sugar.
 *  - `'virtual'` — rides the `present` read phase (the money-`Formatted`/
 *    i18n-`Label` precedent, seam map Part 4): computed fresh on every
 *    read, NEVER stored, `queryable: 'none'`, excluded from export unless
 *    its declared `deps` permit (identical taint rule to materialized —
 *    see `shape/via-computed/binding.ts`).
 *
 * `deps` names the OTHER fields `fn` reads — feeds `ViaGraph` (Task 1/2) so
 * a source's taint (e.g. a classified field) propagates to this derived
 * field. A depsless entry is fine UNLESS the collection also declares
 * classified fields (`kernel/collection-config.ts#resolveComputedEdges`
 * refuses it — closes the #636 opaque-function leak).
 */
import type { ViaDescriptor } from '../../kernel/via.js'

export interface ComputedDescriptor extends ViaDescriptor {
  readonly _viaBrand: 'computed'
  readonly fn: (record: Record<string, unknown>) => unknown
  readonly deps?: readonly string[]
  readonly mode: 'materialized' | 'virtual'
}

export function computed(
  fn: (record: Record<string, unknown>) => unknown,
  opts?: { readonly deps?: readonly string[]; readonly mode?: 'materialized' | 'virtual' },
): ComputedDescriptor {
  return {
    _viaBrand: 'computed',
    fn,
    ...(opts?.deps !== undefined ? { deps: opts.deps } : {}),
    mode: opts?.mode ?? 'materialized',
  }
}

export function isComputedDescriptor(x: unknown): x is ComputedDescriptor {
  return typeof x === 'object' && x !== null && (x as { _viaBrand?: unknown })._viaBrand === 'computed'
}
