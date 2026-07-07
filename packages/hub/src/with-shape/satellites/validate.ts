import { SatelliteConfigError } from '../../kernel/errors.js'
import type { SatelliteSpec } from './types.js'

export interface SatelliteDeclarationInput {
  readonly satellite: string
  readonly satelliteOf: string
  readonly fields: readonly string[] | undefined
  readonly joined?: string | undefined
  /** True when the named base is itself registered as a satellite (R-S3). */
  readonly baseIsSatellite: boolean
  /** True when the declaring collection (or its base) sets crdtMode (R-S8). */
  readonly crdtMode: boolean
  /** True when `joined` names an already-declared plain (non-pair) collection (R-S5). */
  readonly joinedCollidesWithCollection: boolean
}

/** Sync declaration refusals R-S3/R-S5/R-S8. Async cross-checks live in registry.ts. */
export function validateSatelliteDeclaration(input: SatelliteDeclarationInput): SatelliteSpec {
  if (input.baseIsSatellite) {
    throw new SatelliteConfigError(
      `R-S3: "${input.satellite}" declares satelliteOf "${input.satelliteOf}", which is itself a satellite — no satellite-of-satellite chains.`,
    )
  }
  if (input.crdtMode) {
    throw new SatelliteConfigError(
      `R-S8: crdtMode is refused on either member of a satellite pair in v1 (revert cannot compensate a merge).`,
    )
  }
  if (!input.fields || input.fields.length === 0) {
    throw new SatelliteConfigError(`R-S5: satellite "${input.satellite}" must declare a non-empty fields list.`)
  }
  if (input.fields.includes('id')) {
    throw new SatelliteConfigError(`R-S5: fields must not contain the shared key "id".`)
  }
  if (input.joined !== undefined && (input.joined === input.satellite || input.joined === input.satelliteOf)) {
    throw new SatelliteConfigError(`R-S5: joined name "${input.joined}" collides with a pair member.`)
  }
  if (input.joinedCollidesWithCollection) {
    throw new SatelliteConfigError(`R-S5: joined name "${input.joined}" collides with an already-declared collection.`)
  }
  return Object.freeze({
    base: input.satelliteOf,
    satellite: input.satellite,
    fields: Object.freeze([...input.fields]),
    joined: input.joined,
  })
}

/** Order-insensitive stable hash of the fields list (FNV-1a over the sorted, joined names). */
export function hashFields(fields: readonly string[]): string {
  // '\x1f' (unit separator) — NOT '' — joins the sorted names: an empty
  // delimiter collapses ['ab'] and ['a', 'b'] onto the same hash.
  const s = [...fields].sort().join('\x1f')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}
