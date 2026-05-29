/**
 * Showcase 89 — Document attestation: revocation publishing
 *
 * What you'll learn
 * ─────────────────
 * How a firm withdraws an already-issued document and proves it offline:
 *   1. issueAttestation → a signed QR; a third party verifies it OFFLINE
 *      (only @noy-db/attestation, no server) → authentic-valid.
 *   2. vault.revokeAttestation(docId) — marks the doc revoked in an encrypted
 *      _attestations/_revoked set. The vault is the source of truth; the firm
 *      never handles raw signing-key material.
 *   3. vault.publishRevocationList() — signs the revoked-id set with the firm's
 *      existing key (same keyId as issued docs) → a RevocationList the firm
 *      serves at a stable URL.
 *   4. The same offline verifier, now bundling that signed list, returns
 *      authentic-revoked — "issued by the firm, since withdrawn".
 *
 * Why it matters
 * ──────────────
 * Revocation is the one thing an offline QR can't answer on its own. The signed
 * list reveals only opaque docIds (zero document disclosure), and because it's
 * signed by the same firm key, the verifier trusts it without a server. This is
 * distinct from showcase/recipe ④, which signs a list with a throwaway keypair;
 * here the vault owns the revoked set and signs with the firm's real signer.
 *
 * Prerequisites
 * ─────────────
 *   - Showcase 00 (hello vault); the @noy-db/hub/attestation issue side; the
 *     @noy-db/recipe-attestation-verifier offline verifier (recipe).
 *
 * Spec mapping
 * ────────────
 *   docs/superpowers/specs/2026-05-30-attestation-revocation-publishing-design.md
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { verifyDocument } from '@noy-db/recipe-attestation-verifier'
import type { AttestationFieldSchema } from '@noy-db/attestation'

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}

describe('showcase 89: attestation revocation', () => {
  it('issue → authentic-valid; revoke + publish → authentic-revoked offline', async () => {
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-pass-2026' })
    const vault = await db.openVault('books')
    await vault.collection<Invoice>('invoices', { attestation }).put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' })

    const { docId, qr, keyId } = await vault.issueAttestation('invoices', 'inv-1')
    const { publicKeyB64 } = await vault.getDocumentSigningPublicKey()
    // The verifier types what's printed (strings). The hub stored total: 1234.5
    // (a number). The 'cents' normalizer canonicalizes both to the same
    // integer-of-cents, so the commitment matches across the issue → verify boundary.
    const printed = { invoiceNo: 'INV-1042', total: '1234.50', issueDate: '2026-05-29' }

    // Before revocation: a third party verifies offline → authentic & valid.
    const before = await verifyDocument(qr, printed, { publicKeys: { [keyId]: publicKeyB64 }, fieldSchema: attestation })
    expect(before.outcome).toBe('authentic-valid')

    // The firm withdraws the document and publishes the signed revocation list.
    await vault.revokeAttestation(docId)
    const revocationList = await vault.publishRevocationList()

    // The verifier bundles that list (served at a stable URL) → authentic-revoked.
    const after = await verifyDocument(qr, printed, { publicKeys: { [keyId]: publicKeyB64 }, fieldSchema: attestation, revocationList })
    expect(after.outcome).toBe('authentic-revoked')
  })
})
