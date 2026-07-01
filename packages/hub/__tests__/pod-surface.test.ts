import { describe, it, expect } from 'vitest'
import * as pod from '../src/pod/index.js'
import { writeNoydbBundle } from '../src/with-share/bundle/bundle.js'

describe('@noy-db/hub/pod surface', () => {
  it('exposes the canonical pod ops (aliases over the bundle impls)', () => {
    for (const s of ['writePod', 'readPod', 'readPodHeader', 'resetBrotliSupportCache']) {
      expect(pod[s as keyof typeof pod], s).toBeTypeOf('function')
    }
  })
  it('aliases writePod to the underlying writeNoydbBundle impl', () => {
    expect(pod.writePod).toBe(writeNoydbBundle)
  })
  it('re-exports the format constants', () => {
    expect(pod.NOYDB_BUNDLE_MAGIC).toBeDefined()
    expect(pod.NOYDB_BUNDLE_FORMAT_VERSION).toBeDefined()
    expect(pod.validateBundleHeader).toBeTypeOf('function')
  })
  it('re-exports the bundle/backup errors under their existing names (instanceof)', () => {
    for (const s of ['BundleIntegrityError', 'BundleSealMismatchError',
                     'BundleVersionConflictError', 'BackupLedgerError',
                     'BackupCorruptedError']) {
      expect(pod[s as keyof typeof pod], s).toBeTypeOf('function')
    }
  })
})
