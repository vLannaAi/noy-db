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
    // Build a valid buffer (innerBytes matches actual length), then truncate
    // one byte so decode sees the declared innerBytes overrunning the buffer.
    const inner0 = new Uint8Array([1, 2, 3])
    const m: MultiBundleManifest = {
      multiFormatVersion: 1, handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [{ handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 3, innerSha256: 'a'.repeat(64) }],
    }
    const good = encodeMultiBundle(m, [inner0])
    // Truncate the last byte — decode now sees innerBytes=3 but only 2 bytes available.
    expect(() => decodeMultiBundle(good.subarray(0, good.length - 1))).toThrow(/truncat|overrun|length/i)
  })

  it('encodeMultiBundle rejects an innerBytes / actual-length mismatch', () => {
    const m: MultiBundleManifest = {
      multiFormatVersion: 1, handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [{ handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 99, innerSha256: 'a'.repeat(64) }],
    }
    expect(() => encodeMultiBundle(m, [new Uint8Array([1, 2, 3])])).toThrow(/innerBytes|declares/i)
  })

  it('decodeMultiBundle rejects trailing bytes after the last compartment', () => {
    const inner0 = new Uint8Array([1, 2, 3])
    const m: MultiBundleManifest = {
      multiFormatVersion: 1, handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [{ handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 3, innerSha256: 'a'.repeat(64) }],
    }
    const good = encodeMultiBundle(m, [inner0])
    const withTrailer = new Uint8Array(good.length + 2)
    withTrailer.set(good, 0)
    expect(() => decodeMultiBundle(withTrailer)).toThrow(/trailing/i)
  })
})
