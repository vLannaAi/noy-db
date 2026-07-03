/**
 * `applyListProjection` — the ONE vetted read-projection for lists/exports.
 * Replaces classified field values with their declared projection (omit /
 * mask / rider) so no consumer re-implements redaction. Pure, non-mutating.
 * Consumed by as-* exporters (#489) and available to any list renderer.
 * @module
 */
import type { CollectionDescription } from './describe.js'

export interface ListProjectionOptions {
  /** Also handle fields carrying only a plain sensitivity tag (pii/secret). */
  readonly sensitivity?: 'omit' | 'mask'
}

export function applyListProjection(
  desc: CollectionDescription,
  record: Record<string, unknown>,
  opts?: ListProjectionOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record }
  for (const f of desc.fields) {
    if (f.classified !== undefined) {
      const list = f.classified.list
      if (list === 'omit') { delete out[f.key]; continue }
      if ('mask' in list) {
        out[f.key] = list.mask.replace(/\$\{(\w+)\}/g, (_m, rider: string) => {
          const v = record[`${f.key}_${rider}`]
          // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions
          return v === undefined || v === null ? '•' : `${v}`
        })
        continue
      }
      out[f.key] = record[`${f.key}_${list.rider}`]
      continue
    }
    if (opts?.sensitivity !== undefined && (f.sensitivity === 'pii' || f.sensitivity === 'secret')) {
      if (opts.sensitivity === 'omit') delete out[f.key]
      else out[f.key] = '•••'
    }
  }
  return out
}
