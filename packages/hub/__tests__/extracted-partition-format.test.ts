/**
 * Extracted-partition wire format (#203/#206) — Plan 3a.
 *
 * Covers (format only, no extraction logic):
 *   - bundleKind + transferSeal header fields round-trip + validation
 *   - bundleKind ⇔ transferSeal cross-field invariant
 *   - ExtractedPartitionBody wrapper build/parse roundtrip
 *   - autoUnlock ⊕ extracted-partition mutual exclusion
 */

import { describe, it, expect } from 'vitest'
import {
  encodeBundleHeader,
  decodeBundleHeader,
  validateBundleHeader,
  NOYDB_BUNDLE_FORMAT_VERSION,
  type NoydbBundleHeader,
} from '../src/with-share/bundle/format.js'
import {
  buildExtractedPartitionWrapper,
  parseExtractedPartitionBody,
  type ExtractedPartitionBody,
} from '../src/with-share/bundle/bundle.js'

const base = {
  formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
  handle: '01ARZ3NDEKTSV4RRFFQ69G5FAV', // 26-char Crockford base32
  bodyBytes: 10,
  bodySha256: 'a'.repeat(64),
} satisfies Partial<NoydbBundleHeader>

describe('extracted-partition header fields', () => {
  it('round-trips a header carrying bundleKind + transferSeal indicator', () => {
    const header: NoydbBundleHeader = {
      ...base,
      bundleKind: 'extracted-partition',
      transferSeal: { v: 1, alg: 'aes-256-gcm-pre-shared', sealId: 'seal-abc' },
    }
    const decoded = decodeBundleHeader(encodeBundleHeader(header))
    expect(decoded.bundleKind).toBe('extracted-partition')
    expect(decoded.transferSeal).toEqual({ v: 1, alg: 'aes-256-gcm-pre-shared', sealId: 'seal-abc' })
  })

  it('accepts bundleKind: snapshot and a header with neither field (back-compat)', () => {
    expect(() => validateBundleHeader({ ...base, bundleKind: 'snapshot' })).not.toThrow()
    expect(() => validateBundleHeader({ ...base })).not.toThrow()
  })

  it('rejects an unknown bundleKind value', () => {
    expect(() => validateBundleHeader({ ...base, bundleKind: 'nope' })).toThrow(/bundleKind/)
  })
})

describe('bundleKind ⇔ transferSeal cross-field invariant', () => {
  it('rejects transferSeal without bundleKind: extracted-partition', () => {
    expect(() =>
      validateBundleHeader({ ...base, transferSeal: { v: 1, alg: 'aes-256-gcm-pre-shared', sealId: 's' } }),
    ).toThrow(/transferSeal.*extracted-partition/)
  })

  it('rejects bundleKind: extracted-partition without a transferSeal', () => {
    expect(() =>
      validateBundleHeader({ ...base, bundleKind: 'extracted-partition' }),
    ).toThrow(/extracted-partition.*transferSeal/)
  })
})

describe('ExtractedPartitionBody wrapper', () => {
  it('round-trips dump + sealed-DEK payload through build/parse', () => {
    const dumpJson = JSON.stringify({ _noydb_backup: 1, collections: {}, keyrings: {} })
    const seal = {
      v: 1 as const,
      alg: 'aes-256-gcm-pre-shared' as const,
      sealId: 'seal-xyz',
      payload: 'YmFzZTY0LXNlYWxlZC1kZWtz', // base64 placeholder ciphertext
    }

    const body: ExtractedPartitionBody = buildExtractedPartitionWrapper(dumpJson, seal)
    expect(body._noydb_bundle_body).toBe(1)
    expect(body.dump).toBe(dumpJson)
    expect(body._transferSeal).toEqual(seal)

    const parsed = parseExtractedPartitionBody(JSON.stringify(body))
    expect(parsed.dump).toBe(dumpJson)
    expect(parsed.seal).toEqual(seal)
  })

  it('parse rejects a body missing the _transferSeal blob', () => {
    const bad = JSON.stringify({ _noydb_bundle_body: 1, dump: '{}' })
    expect(() => parseExtractedPartitionBody(bad)).toThrow(/_transferSeal/)
  })

  it('parse rejects a non-wrapper body (raw string) and a wrapper missing the discriminator', () => {
    // A bare JSON string is caught by the object guard.
    expect(() => parseExtractedPartitionBody('"raw dump string"')).toThrow(/not a JSON object/)
    // A JSON object without the discriminator is caught by the marker check.
    expect(() => parseExtractedPartitionBody('{"dump":"{}"}')).toThrow(/_noydb_bundle_body/)
  })
})

describe('autoUnlock ⊕ extracted-partition mutual exclusion', () => {
  it('rejects a header carrying both autoUnlock and bundleKind: extracted-partition', () => {
    expect(() =>
      validateBundleHeader({
        ...base,
        autoUnlock: 'sealed',
        bundleKind: 'extracted-partition',
        transferSeal: { v: 1, alg: 'aes-256-gcm-pre-shared', sealId: 's' },
      }),
    ).toThrow(/autoUnlock.*extracted-partition|extracted-partition.*autoUnlock/)
  })
})
