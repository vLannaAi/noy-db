/**
 * Recipe — Offline document-attestation verifier
 *
 * The firm issues a signed attestation (hub side); a third party verifies it
 * with NO hub, NO server, NO network — only @noy-db/attestation via the
 * recipe's shared verifyDocument(). Demonstrates authentic / altered / revoked
 * and the firm-issue → offline-verify boundary.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { verifyDocument } from '@noy-db/recipe-attestation-verifier'
import {
  generateDocSigningKeyPair, computeFieldHashes, signPayloadCore, encodeQr,
  signRevocationList, bytesToB64url, type AttestationFieldSchema, type QrPayload,
} from '@noy-db/attestation'

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}

describe('recipe: offline attestation verifier', () => {
  it('firm issues via the hub; a third party verifies offline (authentic + altered)', async () => {
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-pass-2026' })
    const vault = await db.openVault('books')
    const invoices = vault.collection<Invoice>('invoices', { attestation })
    await invoices.put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' })

    const { qr, keyId } = await vault.issueAttestation('invoices', 'inv-1')
    const { publicKeyB64 } = await vault.getDocumentSigningPublicKey()
    const config = { publicKeys: { [keyId]: publicKeyB64 }, fieldSchema: attestation }

    // A human reads "1,234.50" off the printed invoice and types it in. The hub
    // stored total: 1234.5 (a number). The 'cents' normalizer canonicalizes both
    // the typed string and the stored number to the same integer-of-cents, so the
    // commitment matches across the issue → verify boundary — no float math needed.
    const printed = { invoiceNo: 'INV-1042', total: '1234.50', issueDate: '2026-05-29' }
    expect((await verifyDocument(qr, printed, config)).outcome).toBe('authentic-valid')

    // Change just the total: the verifier reports 'altered' AND localizes which field differs.
    const tampered = await verifyDocument(qr, { ...printed, total: '9999.00' }, config)
    expect(tampered.outcome).toBe('altered')
    expect(tampered.perField.find((f) => f.path === 'total')?.match).toBe(false)
    expect(tampered.perField.find((f) => f.path === 'invoiceNo')?.match).toBe(true)
  })

  it('a revoked document reads authentic-revoked (revocation needs the firm private key — pure keypair here)', async () => {
    const k = await generateDocSigningKeyPair()
    const docId = '01J0000000000000000000RVK0' // synthetic ULID-shaped id — pure keypair, no vault/store
    const record = { invoiceNo: 'INV-9', total: '50', issueDate: '2026-05-29' }
    const salt = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))
    const fieldHashes = await computeFieldHashes(salt, attestation, record)
    const sig = await signPayloadCore({ v: 1, docId, salt, keyId: k.keyId, fieldHashes }, k.privateKeyPkcs8B64)
    const qr = encodeQr({ v: 1, docId, salt, alg: 'ed25519', keyId: k.keyId, fieldHashes, sig } as QrPayload)
    const list = await signRevocationList([docId], '2026-05-29T00:00:00.000Z', k.keyId, k.privateKeyPkcs8B64)

    const v = await verifyDocument(qr, record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema: attestation, revocationList: list })
    expect(v.outcome).toBe('authentic-revoked')
  })
})
