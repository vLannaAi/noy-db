import { describe, it, expect } from 'vitest'
import { buildRecordAad, type RecordIdentity } from '../src/kernel/enclave/record-aad.js'

const base: RecordIdentity = {
  collection: 'invoices',
  id: 'inv-1',
  version: 3,
  tier: 0,
  by: 'alice',
}

const hex = (b: Uint8Array): string =>
  [...b].map(x => x.toString(16).padStart(2, '0')).join('')

describe('buildRecordAad (#1041)', () => {
  it('1. is deterministic — same identity, same bytes', () => {
    expect(hex(buildRecordAad(base))).toBe(hex(buildRecordAad({ ...base })))
  })

  it('2. every bound field changes the output', () => {
    const variants: RecordIdentity[] = [
      { ...base, collection: 'other' },
      { ...base, id: 'other' },
      { ...base, tier: 1 },
      { ...base, by: 'mallory' },
      { ...base, version: 4 },
    ]
    const baseline = hex(buildRecordAad(base))
    for (const v of variants) {
      expect(hex(buildRecordAad(v)), JSON.stringify(v)).not.toBe(baseline)
    }
  })

  it('3. is injection-proof — field boundaries cannot be forged by content', () => {
    // The classic failure: naive `${collection}:${id}` lets an
    // attacker move a record by choosing names that re-split the same way.
    // "a" + "b:c" must not collide with "a:b" + "c".
    const left = buildRecordAad({ ...base, collection: 'a', id: 'b:c' })
    const right = buildRecordAad({ ...base, collection: 'a:b', id: 'c' })
    expect(hex(left)).not.toBe(hex(right))
  })

  it('4. NUL bytes in a field cannot forge a boundary either', () => {
    const left = buildRecordAad({ ...base, collection: 'a\u0000b', id: 'c' })
    const right = buildRecordAad({ ...base, collection: 'a', id: '\u0000b c' })
    expect(hex(left)).not.toBe(hex(right))
  })

  it('5. an absent `by` is distinct from an empty-string `by`', () => {
    const absent = buildRecordAad({ ...base, by: undefined })
    const empty = buildRecordAad({ ...base, by: '' })
    expect(hex(absent)).not.toBe(hex(empty))
  })

  it('6. an absent tier is treated as tier 0 — the read paths already do', () => {
    // `collection.ts` reads `(envelope._tier ?? 0) > 0`, so an envelope with no
    // `_tier` and one with `_tier: 0` are the same record. The AAD must agree,
    // or writing without a tier and reading with one would fail to decrypt.
    expect(hex(buildRecordAad({ ...base, tier: undefined })))
      .toBe(hex(buildRecordAad({ ...base, tier: 0 })))
  })

  it('7. carries a scheme tag so the binding can evolve — `/2` since `_v` joined', () => {
    const bytes = buildRecordAad(base)
    expect(new TextDecoder().decode(bytes.slice(0, 11))).toBe('noydb-aad/2')
  })

  it('8. handles non-ASCII identifiers without collapsing them', () => {
    const thai = buildRecordAad({ ...base, collection: 'ใบแจ้งหนี้' })
    const other = buildRecordAad({ ...base, collection: 'ใบแจ้งหนีx' })
    expect(hex(thai)).not.toBe(hex(other))
  })

  it('9. adjacent versions do not collide — the length prefix keeps digits apart', () => {
    // `1` + `12` must not encode the same as `11` + `2`. Cheap to get wrong if
    // the version were ever concatenated rather than length-prefixed, and the
    // consequence would be two versions of a record becoming interchangeable —
    // a rollback that AAD waves through.
    const a = buildRecordAad({ ...base, id: '1', version: 12 })
    const b = buildRecordAad({ ...base, id: '11', version: 2 })
    expect(hex(a)).not.toBe(hex(b))
  })

  it('10. REFUSES a missing version rather than encoding "undefined"', () => {
    // The guard exists because of what happened without it: several hand-built
    // fixtures sealed with `version` absent, `String(undefined)` went into the
    // AAD, the write SUCCEEDED, and the failure surfaced as a TamperedError on
    // the next read — pointing at the read path, which was correct. Loud at the
    // seal site beats silent-then-misattributed (#1093).
    expect(() => buildRecordAad({ ...base, version: undefined as unknown as number }))
      .toThrow(/version must be a finite number/)
    expect(() => buildRecordAad({ ...base, version: NaN })).toThrow(/finite/)
  })
})
