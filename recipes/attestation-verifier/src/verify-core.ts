import {
  decodeQr, verifyAttestation, verifyRevocationList,
  type AttestationFieldSchema, type QrPayload, type RevocationList,
} from '@noy-db/attestation'

export interface VerifierConfig {
  publicKeys: Record<string, string>
  fieldSchema: AttestationFieldSchema
  revocationList?: RevocationList
}

export type VerifierOutcome =
  | 'authentic-valid'
  | 'authentic-revoked'
  | 'altered'
  | 'signature-invalid'
  | 'unknown-key'
  | 'unreadable-qr'

export interface Verdict {
  outcome: VerifierOutcome
  perField: Array<{ path: string; match: boolean }>
  revocationTrusted: boolean | null
  keyId?: string
  docId?: string
}

export async function verifyDocument(
  qr: string,
  claimedFields: Record<string, unknown>,
  config: VerifierConfig,
): Promise<Verdict> {
  let payload: QrPayload
  try {
    payload = decodeQr(qr)
  } catch {
    return { outcome: 'unreadable-qr', perField: [], revocationTrusted: null }
  }

  const matchedKey = config.publicKeys[payload.keyId]
  if (matchedKey === undefined) {
    return { outcome: 'unknown-key', perField: [], revocationTrusted: null, keyId: payload.keyId, docId: payload.docId }
  }

  let revocationTrusted: boolean | null = null
  if (config.revocationList) {
    revocationTrusted = await verifyRevocationList(config.revocationList, matchedKey)
  }

  const result = await verifyAttestation({
    qr,
    claimedFields,
    fieldSchema: config.fieldSchema,
    publicKeys: config.publicKeys,
    ...(revocationTrusted === true && config.revocationList ? { revocation: { list: config.revocationList } } : {}),
  })

  const perField = result.perField.map((f) => ({ path: f.path, match: f.match }))
  const allMatch = perField.length > 0 && perField.every((f) => f.match)

  let outcome: VerifierOutcome
  if (!result.signatureValid) outcome = 'signature-invalid'
  else if (!allMatch) outcome = 'altered'
  else if (result.revoked === true) outcome = 'authentic-revoked'
  else outcome = 'authentic-valid'

  return { outcome, perField, revocationTrusted, keyId: payload.keyId, docId: payload.docId }
}
