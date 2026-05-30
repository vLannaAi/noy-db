/** The decrypted record the render Lambda turns into a PDF. */
export interface RenderPayload {
  docId: string
  fields: Record<string, string | number>
  qr: string
}

const KMS_PLAINTEXT_LIMIT = 4096 // AWS KMS Encrypt caps plaintext at 4 KB.

export function encodeRenderPayload(p: RenderPayload): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(p))
  if (bytes.length > KMS_PLAINTEXT_LIMIT) {
    throw new Error(
      `render payload exceeds the 4 KB KMS plaintext limit (${bytes.length} > ${KMS_PLAINTEXT_LIMIT} bytes). ` +
        'Attestation payloads (declared fields + QR) are normally far under; envelope encryption for larger payloads is out of scope.',
    )
  }
  return bytes
}

export function decodeRenderPayload(bytes: Uint8Array): RenderPayload {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  if (
    parsed === null || typeof parsed !== 'object' ||
    typeof (parsed as RenderPayload).docId !== 'string' ||
    typeof (parsed as RenderPayload).qr !== 'string' ||
    typeof (parsed as RenderPayload).fields !== 'object' || (parsed as RenderPayload).fields === null
  ) {
    throw new Error('decodeRenderPayload: invalid payload shape (need { docId, fields, qr })')
  }
  return parsed as RenderPayload
}
