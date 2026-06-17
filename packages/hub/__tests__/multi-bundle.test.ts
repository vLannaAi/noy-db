import { describe, it, expect } from 'vitest'
import {
  NOYDB_MULTI_BUNDLE_MAGIC,
  encodeMultiBundle,
  decodeMultiBundle,
  type MultiBundleManifest,
} from '../src/bundle/multi-bundle.js'

describe('multi-bundle framing codec', () => {
  it('round-trips a manifest + inner byte blobs', () => {
    const inner0 = new Uint8Array([1, 2, 3, 4, 5])
    const inner1 = new Uint8Array([9, 8, 7])
    const manifest: MultiBundleManifest = {
      multiFormatVersion: 1,
      handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [
        { handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 5, innerSha256: 'a'.repeat(64), roleTag: 'shard' },
        { handle: '01HBBBBBBBBBBBBBBBBBBBBBBB', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 3, innerSha256: 'b'.repeat(64) },
      ],
    }
    const bytes = encodeMultiBundle(manifest, [inner0, inner1])
    expect(bytes.subarray(0, 4)).toEqual(NOYDB_MULTI_BUNDLE_MAGIC)
    const decoded = decodeMultiBundle(bytes)
    expect(decoded.manifest).toEqual(manifest)
    expect(decoded.inner[0]).toEqual(inner0)
    expect(decoded.inner[1]).toEqual(inner1)
  })

  it('rejects bytes without the NDBM magic', () => {
    expect(() => decodeMultiBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toThrow(/magic/i)
  })

  it('rejects a manifest whose innerBytes sum exceeds the body', () => {
    const m: MultiBundleManifest = {
      multiFormatVersion: 1, handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [{ handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 999, innerSha256: 'a'.repeat(64) }],
    }
    const bytes = encodeMultiBundle(m, [new Uint8Array([1, 2, 3])])
    // tamper: truncate body so the declared innerBytes overruns
    expect(() => decodeMultiBundle(bytes.subarray(0, bytes.length - 1))).toThrow(/truncat|overrun|length/i)
  })
})
