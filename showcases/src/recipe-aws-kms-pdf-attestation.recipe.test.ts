/**
 * Recipe — AWS-KMS PDF attestation (generation side, CI-safe slice)
 *
 * The firm issues a signed attestation, seals the render payload with its KMS
 * key (@noy-db/at-aws-kms), and a Lambda would later decrypt + render it to a
 * PDF with the QR embedded as vector. This CI slice proves the data path with a
 * MOCK KMS (no real AWS, no Chromium): issue → seal → unseal → buildInvoiceHtml,
 * and confirms the embedded QR still verifies offline via the ④ verifier.
 * Real deploy → invoke → teardown is in the recipe's RUNBOOK.md (profile-driven).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { sealAndUpload } from '@noy-db/recipe-aws-kms-pdf-attestation/seal'
import { buildInvoiceHtml } from '@noy-db/recipe-aws-kms-pdf-attestation/render-core'
import { decodeRenderPayload, type RenderPayload } from '@noy-db/recipe-aws-kms-pdf-attestation'
import { verifyDocument } from '@noy-db/recipe-attestation-verifier'
import { decodeQr, type AttestationFieldSchema } from '@noy-db/attestation'

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}

describe('recipe: aws-kms-pdf-attestation (CI slice, mock KMS)', () => {
  it('issue → seal → unseal → render HTML; the embedded QR still verifies offline', async () => {
    // 1. Firm issues an attestation through the hub.
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-pass-2026' })
    const vault = await db.openVault('books')
    await vault.collection<Invoice>('invoices', { attestation }).put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' })
    const { docId, qr, keyId } = await vault.issueAttestation('invoices', 'inv-1')
    const { publicKeyB64 } = await vault.getDocumentSigningPublicKey()

    // 2. Firm seals the render payload + "uploads" it (mock KMS=identity, mock S3 captures).
    const payload: RenderPayload = { docId, qr, fields: { invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' } }
    let stored: Uint8Array | undefined
    const kmsClient = { send: async (cmd: { input: { Plaintext: Uint8Array } }) => ({ CiphertextBlob: cmd.input.Plaintext }) }
    const s3Client = { send: async (cmd: { input: { Body: Uint8Array } }) => { stored = cmd.input.Body; return {} } }
    await sealAndUpload(payload, { keyId: 'arn:demo', bucket: 'b', key: `docs/${docId}`, kmsClient: kmsClient as never, s3Client: s3Client as never })
    expect(stored).toBeTruthy()

    // 3. Lambda side (mock decrypt=identity) → render HTML.
    const decoded = decodeRenderPayload(stored!)
    const html = await buildInvoiceHtml(decoded)
    expect(html).toContain('INV-1042')
    expect(html).toMatch(/<svg[\s>]/i)              // QR is vector
    expect(decodeQr(decoded.qr).docId).toBe(docId)  // the right QR rode along

    // 4. A third party verifies the embedded QR OFFLINE → authentic-valid.
    const printed = { invoiceNo: 'INV-1042', total: '1234.50', issueDate: '2026-05-29' }
    const v = await verifyDocument(decoded.qr, printed, { publicKeys: { [keyId]: publicKeyB64 }, fieldSchema: attestation })
    expect(v.outcome).toBe('authentic-valid')
  })

  it('a minted share link gates the render endpoint; unsigned requests are rejected', async () => {
    const { makeHandler } = await import('@noy-db/recipe-aws-kms-pdf-attestation/handler')
    const { mintShareLink } = await import('@noy-db/recipe-aws-kms-pdf-attestation/share-link')
    const { encodeRenderPayload } = await import('@noy-db/recipe-aws-kms-pdf-attestation')

    const shareSecret = new Uint8Array(32).fill(5)
    const stored = encodeRenderPayload({ docId: 'inv-1', qr: 'q', fields: { invoiceNo: 'INV-1', total: 1, issueDate: '2026-05-29' } })
    const s3 = { send: async () => ({ Body: { transformToByteArray: async () => stored } }) }
    const kms = { send: async (cmd: { input: { CiphertextBlob: Uint8Array } }) => ({ Plaintext: cmd.input.CiphertextBlob }) }
    const renderPdf = async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const handler = makeHandler({ s3: s3 as never, kms: kms as never, renderPdf, bucket: 'b', keyId: 'k', prefix: 'docs', shareSecret })

    // unsigned → rejected (the open ?docId= path is closed)
    const unsigned = await handler({ rawPath: '/inv-1', queryStringParameters: { docId: 'inv-1' } } as never)
    expect(unsigned.statusCode).toBe(403)

    // minted link → accepted
    const url = await mintShareLink('inv-1', { secret: shareSecret, baseUrl: 'https://fn/' })
    const q = new URL(url).searchParams
    const ok = await handler({ rawPath: '/', queryStringParameters: { d: q.get('d')!, exp: q.get('exp')!, sig: q.get('sig')! } } as never)
    expect(ok.statusCode).toBe(200)
  })
})
