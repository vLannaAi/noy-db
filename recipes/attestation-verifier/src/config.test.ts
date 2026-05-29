import { describe, it, expect } from 'vitest'
import { config, sample } from './config.js'
import { verifyDocument } from './verify-core.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('bundled demo data', () => {
  it('the committed sample QR verifies authentic-valid against the bundled config', async () => {
    const v = await verifyDocument(sample.qr, sample.record, config)
    expect(v.outcome).toBe('authentic-valid')
    expect(v.revocationTrusted).toBe(true)   // bundled list is signed by the same demo key
  })

  it('public/sample-qr.txt stays byte-identical to sample.qr (no committed-file drift)', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const txt = readFileSync(join(dir, '../public/sample-qr.txt'), 'utf8').trim()
    expect(txt).toBe(sample.qr)
  })
})
