import { describe, it, expect } from 'vitest'
import { NOYDB_ENVELOPE_GENERATION } from '../src/kernel/types.js'
import { buildRecordAad } from '../src/kernel/enclave/record-aad.js'

/**
 * The generation ↔ AAD-scheme history (#1207). APPEND-ONLY.
 *
 * This table is the release checklist made executable: `record-aad.ts`'s
 * `SCHEME` cannot change without failing the byte-prefix assertion below,
 * and updating this table forces a decision about the generation in the
 * same diff. `null` means "no AAD" — the pre-#1041 sealing format.
 */
const GENERATION_HISTORY: ReadonlyMap<number, string | null> = new Map([
  [1, null], // no AAD — hub ≤ 0.6.0-pre.17
  [2, 'noydb-aad/2'], // identity + `_v` bound into the AEAD (#1041, #1093) — hub ≥ 0.6.0-pre.18
])

describe('NOYDB_ENVELOPE_GENERATION (#1207)', () => {
  it('is the newest generation in the history table', () => {
    // Monotonic by construction: the table is append-only, so the current
    // generation must be its maximum key. A bump without a history row, or a
    // row without a bump, both fail here.
    expect(NOYDB_ENVELOPE_GENERATION).toBe(Math.max(...GENERATION_HISTORY.keys()))
  })

  it('matches the AAD scheme actually emitted by buildRecordAad', () => {
    // Asserted against the BYTES, not against the source constant — a string
    // constant is not a call site. If the scheme label ever changes without
    // this table (and therefore the generation) moving with it, this fails.
    const scheme = GENERATION_HISTORY.get(NOYDB_ENVELOPE_GENERATION)
    expect(scheme).toBeTypeOf('string')
    const aad = buildRecordAad({ collection: 'c', id: 'r', version: 1 })
    const prefix = new TextDecoder().decode(aad.subarray(0, scheme!.length))
    expect(prefix).toBe(scheme)
  })

  it('each generation names a distinct sealing format', () => {
    const schemes = [...GENERATION_HISTORY.values()]
    expect(new Set(schemes).size).toBe(schemes.length)
  })
})
