import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { verifyAttestation } from '@noy-db/attestation'
import { withI18n } from '../src/i18n/index.js'
import { i18nText } from '../src/i18n/core.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, AttestationError } from '../src/errors.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => { let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) } let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) } return coll }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) { const coll = gc(v, c); const ex = coll.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); coll.set(id, env) },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { const coll = store.get(v)?.get(c); return coll ? [...coll.keys()] : [] },
    async loadAll(v) { const comp = store.get(v); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(v, data) { const comp = new Map<string, Map<string, EncryptedEnvelope>>(); for (const [n, recs] of Object.entries(data)) { const coll = new Map<string, EncryptedEnvelope>(); for (const [id, e] of Object.entries(recs)) coll.set(id, e); comp.set(n, coll) } const ex = store.get(v); if (ex) for (const [n, coll] of ex) if (n.startsWith('_')) comp.set(n, coll); store.set(v, comp) },
  }
}

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation = { fields: [
  { path: 'invoiceNo', normalize: 'alnum-upper' as const },
  { path: 'total', normalize: 'cents' as const },
  { path: 'issueDate', normalize: 'iso-date' as const },
] }

async function ownerVault() {
  const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-passphrase-2026' })
  const vault = await db.openVault('books')
  const invoices = vault.collection<Invoice>('invoices', { attestation })
  await invoices.put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1', total: 1234.5, issueDate: '2026-05-29' })
  return { db, vault }
}

describe('vault.issueAttestation (integration)', () => {
  it('issues a QR a third party verifies offline with the published public key', async () => {
    const { vault } = await ownerVault()
    const { docId, qr, keyId } = await vault.issueAttestation('invoices', 'inv-1')
    expect(docId).toHaveLength(26)

    const { keyId: pubKeyId, publicKeyB64 } = await vault.getDocumentSigningPublicKey()
    expect(pubKeyId).toBe(keyId)

    const r = await verifyAttestation({
      qr, claimedFields: { invoiceNo: 'INV-1', total: 1234.5, issueDate: '2026-05-29' },
      fieldSchema: attestation, publicKeys: { [pubKeyId]: publicKeyB64 },
    })
    expect(r.valid).toBe(true)
  })

  it('reuses the same signer across issues (stable keyId)', async () => {
    const { vault } = await ownerVault()
    const a = await vault.issueAttestation('invoices', 'inv-1')
    await vault.collection<Invoice>('invoices').put('inv-2', { id: 'inv-2', invoiceNo: 'INV-2', total: 5, issueDate: '2026-05-29' })
    const b = await vault.issueAttestation('invoices', 'inv-2')
    expect(b.keyId).toBe(a.keyId)
  })

  it('throws AttestationError when the collection has no attestation schema declared', async () => {
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'pw-123456' })
    const vault = await db.openVault('books')
    await vault.collection<Invoice>('plain').put('x', { id: 'x', invoiceNo: 'A', total: 1, issueDate: '2026-05-29' })
    await expect(vault.issueAttestation('plain', 'x')).rejects.toThrow(AttestationError)
  })

  it('signs the canonical stored record, not the locale-resolved presentation (locale-independent issuance)', async () => {
    // Regression for the {locale:'raw'} fix in makeIssueContext().readRecord.
    // The attested collection has an i18nText field (vendorName) AND the vault
    // is opened with a default locale. Without {locale:'raw'}, get() would
    // collapse the language map into the default-locale string, so issuance
    // would commit a hash of the COLLAPSED presentation value rather than the
    // canonical stored map. The verifier — given the canonical stored values —
    // would then see a field mismatch. With the fix, issuance commits the
    // canonical (raw) record and verification against canonical values holds.
    interface I18nInvoice { id: string; invoiceNo: string; total: number; issueDate: string; vendorName: Record<string, string> }
    const i18nAttestation = { fields: [
      { path: 'invoiceNo', normalize: 'alnum-upper' as const },
      { path: 'total', normalize: 'cents' as const },
      { path: 'issueDate', normalize: 'iso-date' as const },
      { path: 'vendorName', normalize: 'trim' as const },
    ] }
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-passphrase-2026', i18nStrategy: withI18n() })
    // Default locale 'en' would collapse vendorName to 'ACME Co' on a plain get().
    const vault = await db.openVault('books', { locale: 'en' })
    const invoices = vault.collection<I18nInvoice>('invoices', {
      attestation: i18nAttestation,
      i18nFields: { vendorName: i18nText({ languages: ['en', 'th'], required: 'all' }) },
    })
    const vendorName = { en: 'ACME Co', th: 'เอซีเอ็มอี' }
    await invoices.put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1', total: 1234.5, issueDate: '2026-05-29', vendorName })

    const { qr, keyId } = await vault.issueAttestation('invoices', 'inv-1')
    const { publicKeyB64 } = await vault.getDocumentSigningPublicKey()

    // Claim the CANONICAL stored values — vendorName is the full language map.
    const r = await verifyAttestation({
      qr,
      claimedFields: { invoiceNo: 'INV-1', total: 1234.5, issueDate: '2026-05-29', vendorName },
      fieldSchema: i18nAttestation,
      publicKeys: { [keyId]: publicKeyB64 },
    })
    expect(r.valid).toBe(true)
    expect(r.perField.find(f => f.path === 'vendorName')?.match).toBe(true)
  })
})
