/**
 * The `computed` via-binding (#638 Task 7) — covers ONLY `mode: 'virtual'`
 * fields. Materialized entries never reach here: they compile into
 * `mergedComputed` (`kernel/collection-config.ts`) and run through the
 * EXISTING stage-5 `evalComputedFields` write path, byte-for-byte unchanged
 * (the behavior lock).
 *
 * A virtual field is computed on READ, inside `present()` — the money-
 * `Formatted`/i18n-`Label` precedent (seam map Part 4) generalized to a
 * user-declared function. It is NEVER stored (no `encodeAtRest`/
 * `decodeAtRest` — the field never appears in `_data` or any `_sealed`
 * slot), and its posture is fixed `queryable: 'none'` — there is no stored/
 * indexed form to query against, regardless of what its sources would
 * otherwise permit (`ViaGraph`'s grain-'virtual' clamp, `kernel/via/graph.ts`,
 * is the belt; this binding's own static posture is the suspenders for a
 * depsless virtual field, which registers no graph edge at all).
 *
 * Export/read redaction for a TAINTED virtual field (sourced from a
 * classified/sealed field) is NOT this binding's job — it stays ignorant of
 * taint, exactly like `evalComputedFields` stays ignorant of it for
 * materialized fields. `kernel/via/taint-binding.ts#taintBinding` (appended
 * to the pipeline by `via/graph-wiring.ts#applyTaintOverlay`, AFTER this
 * binding) overwrites a tainted virtual field's value with the same
 * `EXPORT_REDACTION_MARKER` on every present() — the one enforcement seam
 * every via feature's taint already routes through.
 */
import type { NoydbVia, ViaPosture } from '../../kernel/via/index.js'
import { installViaBinder } from '../../kernel/via/index.js'
import type { ComputedDescriptor } from './descriptor.js'

export interface ComputedViaConfig {
  /** field name -> its virtual-mode descriptor. Materialized entries are never present here. */
  readonly virtualFields: ReadonlyMap<string, ComputedDescriptor>
}

const VIRTUAL_POSTURE: ViaPosture = { encryptedAtRest: 'envelope', queryable: 'none', exportable: true, forgettable: false }

export function computedVia(cfg: ComputedViaConfig): NoydbVia {
  const fields = cfg.virtualFields
  return {
    brand: 'computed',
    presentIsSync: true, // #1416 — `desc.fn(r)` is declared sync by the computed contract
    posture: VIRTUAL_POSTURE,
    covers: (field) => fields.has(field),
    present: (record) => {
      let r = record
      for (const [field, desc] of fields) {
        if (r === record) r = { ...record }
        r[field] = desc.fn(r)
      }
      return r
    },
  }
}

export function linkComputedVia(): void {
  installViaBinder('computed', (cfg) => computedVia(cfg as ComputedViaConfig))
}
