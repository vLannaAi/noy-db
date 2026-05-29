import { describe, it, expect } from 'vitest'
import * as api from '../src/index.js'

describe('public API surface', () => {
  it('exports the documented functions', () => {
    for (const name of [
      'canonicalJson', 'sha256Hex', 'normalizeField', 'validateFieldSchema',
      'computeFieldHashes', 'generateDocSigningKeyPair', 'encodeQr', 'decodeQr',
      'signPayloadCore', 'verifyAttestation', 'isRevoked', 'verifyRevocationList', 'signRevocationList',
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function')
    }
  })
})
