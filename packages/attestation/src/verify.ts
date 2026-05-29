import type { AttestationFieldSchema } from './types.js'
import type { QrPayload } from './qr.js'
import type { RevocationList } from './revocation.js'
import { canonicalJson, utf8 } from './encoding.js'
import { ed25519Sign, ed25519Verify } from './ed25519.js'
import { computeFieldHashes } from './hashing.js'
import { decodeQr } from './qr.js'
import { isRevoked } from './revocation.js'

export interface VerifyInput {
  readonly qr: string
  readonly claimedFields: Record<string, unknown>
  readonly fieldSchema: AttestationFieldSchema
  readonly publicKeys: Readonly<Record<string, string>>
  readonly revocation?: { list: RevocationList }
}
export interface VerifyResult {
  readonly valid: boolean
  readonly signatureValid: boolean
  readonly perField: ReadonlyArray<{ path: string; match: boolean }>
  readonly revoked: boolean | null
  readonly reason?: string
}

/**
 * The bytes the signature covers: canonicalJson of the payload minus `alg`/`sig`.
 * Excludes `alg` by design — v1 has exactly one algorithm (`ed25519`). If a `v:2`
 * ever introduces a second algorithm, `alg` MUST be added here to prevent a
 * downgrade attack.
 */
function signedCore(core: { v: 1; docId: string; salt: string; keyId: string; fieldHashes: readonly string[] }): Uint8Array {
  return utf8(canonicalJson({ v: core.v, docId: core.docId, salt: core.salt, keyId: core.keyId, fieldHashes: core.fieldHashes }))
}

export async function signPayloadCore(
  core: { v: 1; docId: string; salt: string; keyId: string; fieldHashes: readonly string[] },
  privateKeyPkcs8B64: string,
): Promise<string> {
  return ed25519Sign(privateKeyPkcs8B64, signedCore(core))
}

export async function verifyAttestation(input: VerifyInput): Promise<VerifyResult> {
  const p: QrPayload = decodeQr(input.qr)
  const pub = input.publicKeys[p.keyId]
  const signatureValid = pub
    ? await ed25519Verify(pub, p.sig, signedCore({ v: p.v, docId: p.docId, salt: p.salt, keyId: p.keyId, fieldHashes: p.fieldHashes }))
    : false

  const schema = input.fieldSchema
  const perField: Array<{ path: string; match: boolean }> = []
  let allMatch = true
  let countMismatch = false
  if (schema.fields.length !== p.fieldHashes.length) {
    countMismatch = true
    allMatch = false
    for (const f of schema.fields) perField.push({ path: f.path, match: false })
  } else {
    const recomputed = await computeFieldHashes(p.salt, schema, input.claimedFields)
    for (let i = 0; i < schema.fields.length; i++) {
      const match = recomputed[i] === p.fieldHashes[i]
      perField.push({ path: schema.fields[i]!.path, match })
      if (!match) allMatch = false
    }
  }

  // Membership check only — the CALLER must have verified the list's own
  // signature with `verifyRevocationList` before passing it here. A list that
  // omits a genuinely-revoked id lets that doc pass; that risk is the caller's.
  const revoked = input.revocation ? isRevoked(p.docId, input.revocation.list) : null
  const valid = signatureValid && allMatch && revoked !== true

  let reason: string | undefined
  if (!signatureValid) reason = pub ? 'signature invalid' : 'unknown keyId'
  else if (countMismatch) reason = 'schema/payload field-count mismatch'
  else if (!allMatch) reason = 'field mismatch'
  else if (revoked === true) reason = 'revoked'

  return reason !== undefined
    ? { valid, signatureValid, perField, revoked, reason }
    : { valid, signatureValid, perField, revoked }
}
