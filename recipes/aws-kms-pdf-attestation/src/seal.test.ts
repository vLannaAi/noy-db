import { describe, it, expect } from 'vitest'
import { sealAndUpload } from './seal.js'
import { decodeRenderPayload, type RenderPayload } from './payload.js'

const payload: RenderPayload = { docId: 'd1', fields: { invoiceNo: 'INV-1' }, qr: 'qr-string' }

describe('sealAndUpload', () => {
  it('seals the payload via KMS Encrypt and PUTs it to the given bucket/key', async () => {
    const kmsCalls: { input: { Plaintext: Uint8Array } }[] = []
    const s3Calls: { input: { Bucket: string; Key: string; Body: Uint8Array } }[] = []
    // Mock KMS: "seal" = wrap bytes (identity); mock S3: capture the PutObject.
    const kmsClient = { send: async (cmd: { input: { Plaintext: Uint8Array } }) => { kmsCalls.push(cmd); return { CiphertextBlob: cmd.input.Plaintext } } }
    const s3Client = { send: async (cmd: { input: { Bucket: string; Key: string; Body: Uint8Array } }) => { s3Calls.push(cmd); return {} } }

    await sealAndUpload(payload, { keyId: 'arn:key', bucket: 'b', key: 'docs/d1', kmsClient: kmsClient as never, s3Client: s3Client as never })

    expect(kmsCalls).toHaveLength(1)
    const put = s3Calls[0]!.input
    expect(put.Bucket).toBe('b')
    expect(put.Key).toBe('docs/d1')
    // The stored body is the KMS ciphertext; our mock seal is identity, so it
    // decodes back to the original payload.
    expect(decodeRenderPayload(put.Body)).toEqual(payload)
  })
})
